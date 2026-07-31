package mcpserver

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const (
	serverVersion      = "0.1.0"
	maxMCPBodyBytes    = 24 << 20
	maxCallsPerMinute  = 60
	lastUsedWriteDelay = 15 * time.Minute
)

type Service struct {
	app         core.App
	internalURL string
	httpClient  *http.Client
	enabled     bool

	rateMu sync.Mutex
	rates  map[string]*rateWindow
}

type rateWindow struct {
	start time.Time
	count int
}

type principal struct {
	token *core.Record
	actor *core.Record
}

type principalContextKey struct{}

func New(app core.App) *Service {
	enabled := strings.ToLower(strings.TrimSpace(os.Getenv("PB_MCP_ENABLED"))) != "false"
	internalURL := strings.TrimRight(strings.TrimSpace(os.Getenv("PB_MCP_INTERNAL_URL")), "/")
	if internalURL == "" {
		internalURL = "http://127.0.0.1:8090"
	}
	parsed, err := url.Parse(internalURL)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" {
		panic("PB_MCP_INTERNAL_URL debe ser una URL HTTP de 127.0.0.1")
	}
	return &Service{
		app:         app,
		internalURL: internalURL,
		httpClient: &http.Client{
			Timeout: 45 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		enabled: enabled,
		rates:   map[string]*rateWindow{},
	}
}

func (s *Service) Register(e *core.ServeEvent) {
	streamable := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		p, _ := r.Context().Value(principalContextKey{}).(*principal)
		if p == nil {
			return nil
		}
		return s.serverFor(p)
	}, &mcp.StreamableHTTPOptions{
		Stateless:                    true,
		JSONResponse:                 true,
		MaxRequestBodyBytes:          maxMCPBodyBytes,
		PropagateRequestCancellation: true,
		Logger:                       slog.New(slog.NewTextHandler(&discardWriter{}, nil)),
	})

	mcpHandler := apis.WrapStdHandler(s.authHTTP(streamable))
	e.Router.GET("/mcp", mcpHandler).
		Bind(apis.SkipSuccessActivityLog())
	e.Router.POST("/mcp", mcpHandler).
		Bind(apis.SkipSuccessActivityLog())
	e.Router.DELETE("/mcp", mcpHandler).
		Bind(apis.SkipSuccessActivityLog())
	e.Router.GET("/api/openjornada/mcp-tokens", s.listTokens).
		Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/mcp-tokens", s.createToken).
		Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/mcp-tokens/{id}/revoke", s.revokeToken).
		Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.GET("/api/openjornada/mcp-files", apis.WrapStdHandler(http.HandlerFunc(s.downloadFile))).
		Bind(apis.SkipSuccessActivityLog())
}

type discardWriter struct{}

func (*discardWriter) Write(p []byte) (int, error) { return len(p), nil }

func (s *Service) authHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.enabled {
			http.NotFound(w, r)
			return
		}
		if !s.validOrigin(r) {
			http.Error(w, "Origen no permitido.", http.StatusForbidden)
			return
		}
		p, err := s.authenticate(r.Header.Get("Authorization"))
		if err != nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="OpenJornada MCP"`)
			http.Error(w, "Token MCP ausente o no válido.", http.StatusUnauthorized)
			return
		}
		if !s.allowCall(p.token.Id) {
			http.Error(w, "Demasiadas solicitudes.", http.StatusTooManyRequests)
			return
		}
		s.touchToken(p.token)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalContextKey{}, p)))
	})
}

func (s *Service) validOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	publicURL := strings.TrimRight(s.app.Settings().Meta.AppURL, "/")
	parsedOrigin, err := url.Parse(origin)
	if err != nil {
		return false
	}
	parsedPublic, err := url.Parse(publicURL)
	return err == nil &&
		strings.EqualFold(parsedOrigin.Scheme, parsedPublic.Scheme) &&
		strings.EqualFold(parsedOrigin.Host, parsedPublic.Host)
}

func (s *Service) publicMCPURL() string {
	publicURL := strings.TrimSpace(os.Getenv("PB_PUBLIC_URL"))
	if publicURL == "" {
		publicURL = s.app.Settings().Meta.AppURL
	}
	return mcpURLFromPublicURL(publicURL)
}

func mcpURLFromPublicURL(publicURL string) string {
	publicURL = strings.TrimRight(strings.TrimSpace(publicURL), "/")
	if publicURL == "" {
		return "/mcp"
	}
	return publicURL + "/mcp"
}

func (s *Service) authenticate(header string) (*principal, error) {
	const prefix = "Bearer "
	if !strings.HasPrefix(header, prefix) {
		return nil, errors.New("missing bearer")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(header, prefix))
	tokenPrefix, err := parseTokenPrefix(raw)
	if err != nil {
		return nil, err
	}
	token, err := s.app.FindFirstRecordByFilter("mcp_tokens", "prefix = {:prefix}", map[string]any{
		"prefix": tokenPrefix,
	})
	if err != nil {
		return nil, errors.New("invalid token")
	}
	sum := sha256.Sum256([]byte(raw))
	expected, err := hex.DecodeString(token.GetString("tokenHash"))
	if err != nil || len(expected) != len(sum) || subtle.ConstantTimeCompare(expected, sum[:]) != 1 {
		return nil, errors.New("invalid token")
	}
	now := time.Now()
	if token.GetString("revokedAt") != "" || !token.GetDateTime("expiresAt").Time().After(now) {
		return nil, errors.New("expired token")
	}
	actor, err := s.app.FindRecordById("users", token.GetString("createdBy"))
	if err != nil ||
		actor.GetString("organization") != token.GetString("organization") ||
		!actor.GetBool("active") ||
		(actor.GetString("role") != "admin" && actor.GetString("role") != "manager") {
		return nil, errors.New("invalid actor")
	}
	return &principal{token: token, actor: actor}, nil
}

func parseTokenPrefix(raw string) (string, error) {
	const tokenPrefixLength = len("ojmcp_") + 12
	if len(raw) < tokenPrefixLength+1+40 ||
		!strings.HasPrefix(raw, "ojmcp_") ||
		raw[tokenPrefixLength] != '_' {
		return "", errors.New("invalid token format")
	}
	return raw[len("ojmcp_"):tokenPrefixLength], nil
}

func (s *Service) allowCall(tokenID string) bool {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	now := time.Now()
	window := s.rates[tokenID]
	if window == nil || now.Sub(window.start) >= time.Minute {
		s.rates[tokenID] = &rateWindow{start: now, count: 1}
		return true
	}
	if window.count >= maxCallsPerMinute {
		return false
	}
	window.count++
	return true
}

func (s *Service) touchToken(token *core.Record) {
	last := token.GetDateTime("lastUsedAt").Time()
	if !last.IsZero() && time.Since(last) < lastUsedWriteDelay {
		return
	}
	token.Set("lastUsedAt", time.Now())
	_ = s.app.Save(token)
}

func hashToken(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func signValue(key, value string) string {
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte("openjornada:mcp-file:v1:" + value))
	return hex.EncodeToString(mac.Sum(nil))
}

func jsonText(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return `{"error":"No se pudo serializar la respuesta."}`
	}
	return string(data)
}

func toolResult(value any) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content:           []mcp.Content{&mcp.TextContent{Text: jsonText(value)}},
		StructuredContent: value,
	}
}

func toolError(err error) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}},
		IsError: true,
	}
}

func boolPointer(value bool) *bool { return &value }

func (s *Service) audit(p *principal, tool, outcome string, ids []string) {
	collection, err := s.app.FindCollectionByNameOrId("audit_logs")
	if err != nil {
		return
	}
	record := core.NewRecord(collection)
	record.Set("organization", p.actor.GetString("organization"))
	record.Set("actor", p.actor.Id)
	record.Set("action", "mcp.tool.call")
	record.Set("entityType", "mcp_token")
	record.Set("entityId", p.token.Id)
	record.Set("metadata", map[string]any{
		"tool":    tool,
		"outcome": outcome,
		"targets": ids,
	})
	record.Set("occurredAt", time.Now())
	_ = s.app.Save(record)
}

func apiError(status int, body []byte) error {
	var response struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &response)
	if response.Message == "" {
		response.Message = fmt.Sprintf("PocketBase ha respondido con estado %d.", status)
	}
	return errors.New(response.Message)
}
