package laborcalendar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultProviderURL = "https://calendariosnacionales.com/es/v1"
	maxResponseBytes   = 4 << 20
)

var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,99}$`)
var communityCodePattern = regexp.MustCompile(`^[A-Z]{3}$`)
var provinceCodePattern = regexp.MustCompile(`^[0-9]{2}$`)
var municipalityINEPattern = regexp.MustCompile(`^[0-9]{5}$`)

type Community struct {
	Code string `json:"code"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type Province struct {
	Code string `json:"code"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type Municipality struct {
	INE  string `json:"ine"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type Holiday struct {
	Date      string `json:"date"`
	Name      string `json:"name"`
	Scope     string `json:"scope"`
	Source    string `json:"source"`
	SourceURL string `json:"sourceUrl"`
}

type Calendar struct {
	Year         int          `json:"year"`
	GeneratedAt  string       `json:"generatedAt"`
	Confidence   string       `json:"confidence"`
	Region       Community    `json:"region"`
	Province     Province     `json:"province"`
	Municipality Municipality `json:"municipality"`
	Holidays     struct {
		Calendar []Holiday `json:"calendar"`
	} `json:"holidays"`
	Warnings   []string `json:"warnings"`
	Disclaimer string   `json:"disclaimer"`
}

type cachedResponse struct {
	data      []byte
	expiresAt time.Time
}

type Client struct {
	baseURL    string
	httpClient *http.Client
	cacheTTL   time.Duration
	mu         sync.Mutex
	cache      map[string]cachedResponse
}

func NewClient(baseURL string, httpClient *http.Client) (*Client, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("la URL del proveedor de calendarios no es válida")
	}
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 12 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return &Client{
		baseURL:    baseURL,
		httpClient: httpClient,
		cacheTTL:   6 * time.Hour,
		cache:      map[string]cachedResponse{},
	}, nil
}

func NewDefaultClient() *Client {
	client, err := NewClient(defaultProviderURL, nil)
	if err != nil {
		panic(err)
	}
	return client
}

func (c *Client) Communities(ctx context.Context, year int) ([]Community, error) {
	var response struct {
		Communities []Community `json:"communities"`
	}
	if err := c.getJSON(ctx, fmt.Sprintf("/%d/comunidades.json", year), &response); err != nil {
		return nil, err
	}
	response.Communities = filterCatalog(response.Communities, func(item Community) bool {
		return communityCodePattern.MatchString(item.Code)
	})
	return response.Communities, validateCatalog(response.Communities, func(item Community) (string, string) {
		return item.Slug, item.Name
	})
}

func (c *Client) Provinces(ctx context.Context, year int, community string) ([]Province, error) {
	if err := validateSlug(community); err != nil {
		return nil, err
	}
	var response struct {
		Provinces []Province `json:"provinces"`
	}
	path := fmt.Sprintf("/%d/regiones/%s/provincias.json", year, community)
	if err := c.getJSON(ctx, path, &response); err != nil {
		return nil, err
	}
	response.Provinces = filterCatalog(response.Provinces, func(item Province) bool {
		return provinceCodePattern.MatchString(item.Code)
	})
	return response.Provinces, validateCatalog(response.Provinces, func(item Province) (string, string) {
		return item.Slug, item.Name
	})
}

func (c *Client) Municipalities(
	ctx context.Context,
	year int,
	community string,
	province string,
) ([]Municipality, error) {
	if err := validateSlug(community); err != nil {
		return nil, err
	}
	if err := validateSlug(province); err != nil {
		return nil, err
	}
	var response struct {
		Municipalities []Municipality `json:"municipalities"`
	}
	path := fmt.Sprintf(
		"/%d/regiones/%s/provincias/%s/localidades.json",
		year,
		community,
		province,
	)
	if err := c.getJSON(ctx, path, &response); err != nil {
		return nil, err
	}
	response.Municipalities = filterCatalog(
		response.Municipalities,
		func(item Municipality) bool { return municipalityINEPattern.MatchString(item.INE) },
	)
	return response.Municipalities, validateCatalog(
		response.Municipalities,
		func(item Municipality) (string, string) { return item.Slug, item.Name },
	)
}

func (c *Client) Calendar(
	ctx context.Context,
	year int,
	community string,
	province string,
	municipality string,
) (*Calendar, error) {
	for _, slug := range []string{community, province, municipality} {
		if err := validateSlug(slug); err != nil {
			return nil, err
		}
	}
	var response Calendar
	path := fmt.Sprintf(
		"/%d/localidades/%s/%s/%s.json",
		year,
		community,
		province,
		municipality,
	)
	if err := c.getJSON(ctx, path, &response); err != nil {
		return nil, err
	}
	if response.Year != year || len(response.Holidays.Calendar) == 0 {
		return nil, errors.New("el proveedor no devolvió un calendario laboral válido")
	}
	seen := map[string]bool{}
	for _, holiday := range response.Holidays.Calendar {
		if err := validateHoliday(holiday, year); err != nil {
			return nil, err
		}
		if seen[holiday.Date] {
			return nil, fmt.Errorf("el proveedor devolvió la fecha duplicada %s", holiday.Date)
		}
		seen[holiday.Date] = true
	}
	sort.Slice(response.Holidays.Calendar, func(i, j int) bool {
		return response.Holidays.Calendar[i].Date < response.Holidays.Calendar[j].Date
	})
	return &response, nil
}

func (c *Client) getJSON(ctx context.Context, path string, target any) error {
	if !strings.HasPrefix(path, "/") || strings.Contains(path, "..") {
		return errors.New("la ruta del proveedor no es válida")
	}
	targetURL := c.baseURL + path
	now := time.Now()
	c.mu.Lock()
	entry, found := c.cache[targetURL]
	c.mu.Unlock()
	if found && entry.expiresAt.After(now) {
		return json.Unmarshal(entry.data, target)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "OpenJornada/1.0 (+https://github.com/GNURub/openjornada)")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("no se pudo consultar el calendario laboral: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("el proveedor de calendarios respondió con estado %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return err
	}
	if len(data) > maxResponseBytes {
		return errors.New("la respuesta del calendario laboral es demasiado grande")
	}
	if err := json.Unmarshal(data, target); err != nil {
		return errors.New("el proveedor devolvió un calendario no válido")
	}
	c.mu.Lock()
	c.cache[targetURL] = cachedResponse{data: data, expiresAt: now.Add(c.cacheTTL)}
	c.mu.Unlock()
	return nil
}

func validateSlug(value string) error {
	if !slugPattern.MatchString(value) {
		return errors.New("la ubicación seleccionada no es válida")
	}
	return nil
}

func validateCatalog[T any](items []T, fields func(T) (string, string)) error {
	if len(items) == 0 || len(items) > 10_000 {
		return errors.New("el proveedor devolvió un catálogo vacío o demasiado grande")
	}
	for _, item := range items {
		slug, name := fields(item)
		if validateSlug(slug) != nil || strings.TrimSpace(name) == "" || len(name) > 160 {
			return errors.New("el proveedor devolvió una ubicación no válida")
		}
	}
	return nil
}

func filterCatalog[T any](items []T, keep func(T) bool) []T {
	filtered := make([]T, 0, len(items))
	for _, item := range items {
		if keep(item) {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func validateHoliday(holiday Holiday, year int) error {
	date, err := time.Parse("2006-01-02", holiday.Date)
	if err != nil || date.Year() != year {
		return errors.New("el proveedor devolvió una fecha festiva no válida")
	}
	name := strings.TrimSpace(holiday.Name)
	if name == "" || len(name) > 120 {
		return errors.New("el proveedor devolvió un nombre de festivo no válido")
	}
	switch holiday.Scope {
	case "nacional", "autonomico", "provincial", "local":
	default:
		return errors.New("el proveedor devolvió un ámbito de festivo no válido")
	}
	if len(holiday.Source) > 200 || len(holiday.SourceURL) > 500 {
		return errors.New("el proveedor devolvió una fuente demasiado larga")
	}
	if holiday.SourceURL != "" {
		parsed, err := url.Parse(holiday.SourceURL)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
			return errors.New("el proveedor devolvió una fuente no válida")
		}
	}
	return nil
}
