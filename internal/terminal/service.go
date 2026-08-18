package terminal

import (
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const (
	protocolVersion    = 1
	maxOfflineDuration = 24 * time.Hour
	maxQueuedActions   = 10000
	adminIdleTimeout   = 5 * time.Minute
	scanContextTTL     = 10 * time.Second
)

type Service struct {
	app core.App
}

type terminalPrincipal struct {
	Terminal     *core.Record
	Organization *core.Record
	SigningKey   []byte
}

func New(app core.App) *Service {
	return &Service{app: app}
}

func (s *Service) Register(e *core.ServeEvent) {
	e.Router.GET("/api/openjornada/terminals", s.listTerminals).Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/terminals", s.createTerminal).Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.PATCH("/api/openjornada/terminals/{id}", s.renameTerminal).Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/terminals/{id}/rotate-key", s.rotateTerminalKey).Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/terminals/{id}/revoke", s.revokeTerminal).Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.PUT("/api/openjornada/terminals/admin-pin", s.updateAdminPIN).Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.GET("/api/openjornada/rfid-employees", s.listRFIDEmployees).Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.PUT("/api/openjornada/employees/{id}/rfid", s.assignRFIDWeb).Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.DELETE("/api/openjornada/employees/{id}/rfid", s.revokeRFIDWeb).Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.GET("/api/openjornada/terminal-incidents", s.listIncidents).Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/terminal-incidents/{id}/resolve", s.resolveIncident).Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())

	e.Router.POST("/api/openjornada/terminal/v1/bootstrap", s.bootstrap).Bind(apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/terminal/v1/admin-sessions", s.createAdminSession).Bind(apis.SkipSuccessActivityLog())
	e.Router.DELETE("/api/openjornada/terminal/v1/admin-sessions/current", s.closeAdminSession).Bind(apis.SkipSuccessActivityLog())
	e.Router.GET("/api/openjornada/terminal/v1/employees", s.listDeviceEmployees).Bind(apis.SkipSuccessActivityLog())
	e.Router.PUT("/api/openjornada/terminal/v1/employees/{id}/rfid", s.assignRFIDDevice).Bind(apis.SkipSuccessActivityLog())
	e.Router.DELETE("/api/openjornada/terminal/v1/employees/{id}/rfid", s.revokeRFIDDevice).Bind(apis.SkipSuccessActivityLog())
	e.Router.GET("/api/openjornada/terminal/v1/cache", s.deviceCache).Bind(apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/terminal/v1/resolve", s.resolveTag).Bind(apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/terminal/v1/actions", s.performAction).Bind(apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/terminal/v1/sync", s.syncActions).Bind(apis.SkipSuccessActivityLog())
}

func (s *Service) authenticateTerminal(e *core.RequestEvent) (*terminalPrincipal, error) {
	if !secureTerminalRequest(e.Request) {
		return nil, errors.New("insecure terminal request")
	}
	header := strings.TrimSpace(e.Request.Header.Get("Authorization"))
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, errors.New("missing bearer")
	}
	raw := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	prefix, err := parseTerminalPrefix(raw)
	if err != nil {
		return nil, err
	}
	terminal, err := e.App.FindFirstRecordByFilter("attendance_terminals", "prefix = {:prefix}", map[string]any{"prefix": prefix})
	if err != nil || terminal.GetString("revokedAt") != "" || !secureHashEqual(terminal.GetString("tokenHash"), raw) {
		return nil, errors.New("invalid terminal")
	}
	organization, err := e.App.FindRecordById("organizations", terminal.GetString("organization"))
	if err != nil {
		return nil, errors.New("invalid organization")
	}
	signingKey, err := terminalSigningKey(terminal.GetString("signingMaterial"))
	if err != nil {
		return nil, err
	}
	return &terminalPrincipal{Terminal: terminal, Organization: organization, SigningKey: signingKey}, nil
}

func secureTerminalRequest(request *http.Request) bool {
	if request.TLS != nil {
		return true
	}
	host := request.Host
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") || net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback() {
		return true
	}
	remoteHost, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		remoteHost = request.RemoteAddr
	}
	remoteIP := net.ParseIP(strings.Trim(remoteHost, "[]"))
	forwardedHTTPS := strings.EqualFold(strings.TrimSpace(strings.Split(request.Header.Get("X-Forwarded-Proto"), ",")[0]), "https")
	return forwardedHTTPS && remoteIP != nil && (remoteIP.IsLoopback() || remoteIP.IsPrivate())
}

func (s *Service) terminalOrUnauthorized(e *core.RequestEvent) (*terminalPrincipal, error) {
	principal, err := s.authenticateTerminal(e)
	if err != nil {
		return nil, apiError(e, http.StatusUnauthorized, "authentication_required", "La credencial del terminal no es válida.")
	}
	return principal, nil
}

func apiError(e *core.RequestEvent, status int, code, message string) error {
	return e.JSON(status, map[string]any{"status": status, "code": code, "message": message, "data": map[string]any{}})
}

func requireAdmin(actor *core.Record) error {
	if actor == nil || !actor.GetBool("active") || actor.GetString("role") != "admin" {
		return errors.New("Solo administración puede realizar esta operación.")
	}
	return nil
}

func requireRFIDManager(actor *core.Record) error {
	if actor == nil || !actor.GetBool("active") {
		return errors.New("Debes iniciar sesión con una cuenta activa.")
	}
	role := actor.GetString("role")
	if role != "admin" && role != "manager" {
		return errors.New("Solo administración y responsables pueden gestionar RFID.")
	}
	return nil
}
