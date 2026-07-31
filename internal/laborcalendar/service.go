package laborcalendar

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const (
	providerName = "Calendarios Nacionales"
	providerLink = "https://calendariosnacionales.com/es/api/"
)

type Service struct {
	app    core.App
	client *Client
}

type location struct {
	CommunityCode    string `json:"communityCode"`
	CommunitySlug    string `json:"communitySlug"`
	CommunityName    string `json:"communityName"`
	ProvinceCode     string `json:"provinceCode"`
	ProvinceSlug     string `json:"provinceSlug"`
	ProvinceName     string `json:"provinceName"`
	MunicipalityINE  string `json:"municipalityIne"`
	MunicipalitySlug string `json:"municipalitySlug"`
	MunicipalityName string `json:"municipalityName"`
}

type previewHoliday struct {
	Holiday
	Existing     bool   `json:"existing"`
	ExistingName string `json:"existingName,omitempty"`
}

func New(app core.App) *Service {
	return &Service{app: app, client: NewDefaultClient()}
}

func NewWithClient(app core.App, client *Client) *Service {
	return &Service{app: app, client: client}
}

func (s *Service) Register(e *core.ServeEvent) {
	e.Router.GET("/api/openjornada/labor-calendar/communities", s.communities).
		Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.GET("/api/openjornada/labor-calendar/provinces", s.provinces).
		Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.GET("/api/openjornada/labor-calendar/municipalities", s.municipalities).
		Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.GET("/api/openjornada/labor-calendar/preview", s.preview).
		Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/labor-calendar/import", s.importCalendar).
		Bind(apis.RequireAuth("users"))
}

func (s *Service) communities(e *core.RequestEvent) error {
	if err := requireAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	year, err := requestYear(e)
	if err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	items, err := s.client.Communities(e.Request.Context(), year)
	if err != nil {
		return providerError(e, err)
	}
	return e.JSON(http.StatusOK, catalogResponse(items))
}

func (s *Service) provinces(e *core.RequestEvent) error {
	if err := requireAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	year, err := requestYear(e)
	if err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	community := e.Request.URL.Query().Get("community")
	items, err := s.client.Provinces(e.Request.Context(), year, community)
	if err != nil {
		return providerError(e, err)
	}
	return e.JSON(http.StatusOK, catalogResponse(items))
}

func (s *Service) municipalities(e *core.RequestEvent) error {
	if err := requireAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	year, err := requestYear(e)
	if err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	query := e.Request.URL.Query()
	items, err := s.client.Municipalities(
		e.Request.Context(),
		year,
		query.Get("community"),
		query.Get("province"),
	)
	if err != nil {
		return providerError(e, err)
	}
	return e.JSON(http.StatusOK, catalogResponse(items))
}

func (s *Service) preview(e *core.RequestEvent) error {
	if err := requireAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	year, err := requestYear(e)
	if err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	organization, err := e.App.FindRecordById("organizations", e.Auth.GetString("organization"))
	if err != nil {
		return e.NotFoundError("No se encontró la empresa.", err)
	}
	place, err := organizationLocation(organization)
	if err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	calendar, err := s.client.Calendar(
		e.Request.Context(),
		year,
		place.CommunitySlug,
		place.ProvinceSlug,
		place.MunicipalitySlug,
	)
	if err != nil {
		return providerError(e, err)
	}
	if err := calendarMatchesLocation(calendar, place); err != nil {
		return e.Error(http.StatusBadGateway, err.Error(), nil)
	}
	existing, err := existingHolidayNames(e.App, e.Auth.GetString("organization"), year)
	if err != nil {
		return e.InternalServerError("No se pudieron comparar los festivos existentes.", err)
	}
	items := make([]previewHoliday, 0, len(calendar.Holidays.Calendar))
	for _, holiday := range calendar.Holidays.Calendar {
		name, found := existing[holiday.Date]
		items = append(items, previewHoliday{
			Holiday:      holiday,
			Existing:     found,
			ExistingName: name,
		})
	}
	return e.JSON(http.StatusOK, map[string]any{
		"year":        year,
		"location":    place,
		"generatedAt": calendar.GeneratedAt,
		"confidence":  calendar.Confidence,
		"warnings":    calendar.Warnings,
		"disclaimer":  calendar.Disclaimer,
		"items":       items,
		"provider":    providerView(),
	})
}

func (s *Service) importCalendar(e *core.RequestEvent) error {
	if err := requireAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	var body struct {
		Year  int      `json:"year"`
		Dates []string `json:"dates"`
	}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("La selección de festivos no es válida.", err)
	}
	if err := validateYear(body.Year); err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	selected := map[string]bool{}
	for _, date := range body.Dates {
		parsed, err := time.Parse("2006-01-02", date)
		if err != nil || parsed.Year() != body.Year {
			return e.BadRequestError("La selección contiene una fecha no válida.", nil)
		}
		selected[date] = true
	}
	if len(selected) == 0 || len(selected) > 25 {
		return e.BadRequestError("Selecciona entre 1 y 25 festivos.", nil)
	}

	organization, err := e.App.FindRecordById("organizations", e.Auth.GetString("organization"))
	if err != nil {
		return e.NotFoundError("No se encontró la empresa.", err)
	}
	place, err := organizationLocation(organization)
	if err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	calendar, err := s.client.Calendar(
		e.Request.Context(),
		body.Year,
		place.CommunitySlug,
		place.ProvinceSlug,
		place.MunicipalitySlug,
	)
	if err != nil {
		return providerError(e, err)
	}
	if err := calendarMatchesLocation(calendar, place); err != nil {
		return e.Error(http.StatusBadGateway, err.Error(), nil)
	}
	available := map[string]Holiday{}
	for _, holiday := range calendar.Holidays.Calendar {
		available[holiday.Date] = holiday
	}
	for date := range selected {
		if _, found := available[date]; !found {
			return e.BadRequestError("La selección ya no coincide con el calendario del proveedor.", nil)
		}
	}
	existing, err := existingHolidayNames(e.App, e.Auth.GetString("organization"), body.Year)
	if err != nil {
		return e.InternalServerError("No se pudieron comparar los festivos existentes.", err)
	}
	dates := make([]string, 0, len(selected))
	for date := range selected {
		dates = append(dates, date)
	}
	sort.Strings(dates)
	imported := 0
	skipped := 0
	err = e.App.RunInTransaction(func(txApp core.App) error {
		collection, err := txApp.FindCollectionByNameOrId("public_holidays")
		if err != nil {
			return err
		}
		for _, date := range dates {
			if _, found := existing[date]; found {
				skipped++
				continue
			}
			holiday := available[date]
			record := core.NewRecord(collection)
			record.Set("organization", e.Auth.GetString("organization"))
			record.Set("name", strings.TrimSpace(holiday.Name))
			record.Set("date", date+" 12:00:00.000Z")
			record.Set("scope", holiday.Scope)
			record.Set("source", strings.TrimSpace(holiday.Source))
			record.Set("sourceUrl", holiday.SourceURL)
			record.Set("importProvider", "calendariosnacionales")
			record.Set("importedAt", time.Now())
			if err := txApp.Save(record); err != nil {
				return err
			}
			imported++
		}
		return saveImportAudit(txApp, e.Auth, body.Year, place, imported, skipped)
	})
	if err != nil {
		return e.InternalServerError("No se pudo completar la importación del calendario.", err)
	}
	return e.JSON(http.StatusCreated, map[string]any{
		"imported": imported,
		"skipped":  skipped,
		"year":     body.Year,
	})
}

func requestYear(e *core.RequestEvent) (int, error) {
	year, err := strconv.Atoi(e.Request.URL.Query().Get("year"))
	if err != nil {
		return 0, errors.New("el año no es válido")
	}
	return year, validateYear(year)
}

func validateYear(year int) error {
	current := time.Now().Year()
	if year < current-1 || year > current+2 {
		return fmt.Errorf("el año debe estar entre %d y %d", current-1, current+2)
	}
	return nil
}

func requireAdmin(actor *core.Record) error {
	if actor == nil || !actor.GetBool("active") || actor.GetString("role") != "admin" {
		return errors.New("solo administración puede importar el calendario laboral")
	}
	return nil
}

func catalogResponse(items any) map[string]any {
	return map[string]any{"items": items, "provider": providerView()}
}

func providerView() map[string]string {
	return map[string]string{"name": providerName, "url": providerLink}
}

func providerError(e *core.RequestEvent, err error) error {
	return e.Error(
		http.StatusBadGateway,
		"No se pudo obtener el calendario laboral. Inténtalo de nuevo más tarde.",
		err,
	)
}

func organizationLocation(record *core.Record) (location, error) {
	if record.GetString("countryCode") != "ES" {
		return location{}, errors.New("la importación automática sólo está disponible para centros en España")
	}
	place := location{
		CommunityCode:    record.GetString("autonomousCommunityCode"),
		CommunitySlug:    record.GetString("autonomousCommunitySlug"),
		CommunityName:    record.GetString("autonomousCommunityName"),
		ProvinceCode:     record.GetString("provinceCode"),
		ProvinceSlug:     record.GetString("provinceSlug"),
		ProvinceName:     record.GetString("provinceName"),
		MunicipalityINE:  record.GetString("municipalityIne"),
		MunicipalitySlug: record.GetString("municipalitySlug"),
		MunicipalityName: record.GetString("municipalityName"),
	}
	if place.CommunitySlug == "" || place.ProvinceSlug == "" || place.MunicipalitySlug == "" {
		return location{}, errors.New("guarda primero la comunidad, provincia y municipio de la empresa")
	}
	for _, slug := range []string{place.CommunitySlug, place.ProvinceSlug, place.MunicipalitySlug} {
		if err := validateSlug(slug); err != nil {
			return location{}, errors.New("la ubicación guardada no es válida")
		}
	}
	return place, nil
}

func calendarMatchesLocation(calendar *Calendar, place location) error {
	if calendar.Region.Slug != place.CommunitySlug ||
		calendar.Region.Code != place.CommunityCode ||
		calendar.Province.Slug != place.ProvinceSlug ||
		calendar.Province.Code != place.ProvinceCode ||
		calendar.Municipality.Slug != place.MunicipalitySlug ||
		calendar.Municipality.INE != place.MunicipalityINE {
		return errors.New("el proveedor devolvió un calendario de otra ubicación")
	}
	return nil
}

func existingHolidayNames(app core.App, organization string, year int) (map[string]string, error) {
	records, err := app.FindRecordsByFilter(
		"public_holidays",
		"organization = {:organization} && date >= {:start} && date <= {:end}",
		"date",
		500,
		0,
		map[string]any{
			"organization": organization,
			"start":        fmt.Sprintf("%04d-01-01 00:00:00.000Z", year),
			"end":          fmt.Sprintf("%04d-12-31 23:59:59.999Z", year),
		},
	)
	if err != nil {
		return nil, err
	}
	items := make(map[string]string, len(records))
	for _, record := range records {
		date := record.GetString("date")
		if len(date) >= 10 {
			items[date[:10]] = record.GetString("name")
		}
	}
	return items, nil
}

func saveImportAudit(
	app core.App,
	actor *core.Record,
	year int,
	place location,
	imported int,
	skipped int,
) error {
	collection, err := app.FindCollectionByNameOrId("audit_logs")
	if err != nil {
		return err
	}
	record := core.NewRecord(collection)
	record.Set("organization", actor.GetString("organization"))
	record.Set("actor", actor.Id)
	record.Set("action", "public_holidays.imported")
	record.Set("entityType", "public_holidays")
	record.Set("entityId", actor.GetString("organization"))
	record.Set("metadata", map[string]any{
		"provider":        "calendariosnacionales",
		"year":            year,
		"municipalityIne": place.MunicipalityINE,
		"imported":        imported,
		"skipped":         skipped,
	})
	record.Set("occurredAt", time.Now())
	return app.Save(record)
}
