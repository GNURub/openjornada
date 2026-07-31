package mcpserver

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

type tokenView struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Prefix     string `json:"prefix"`
	CreatedBy  string `json:"createdBy"`
	ActorName  string `json:"actorName"`
	ActorRole  string `json:"actorRole"`
	ExpiresAt  string `json:"expiresAt"`
	LastUsedAt string `json:"lastUsedAt"`
	RevokedAt  string `json:"revokedAt"`
	Created    string `json:"created"`
	Token      string `json:"token,omitempty"`
}

func (s *Service) listTokens(e *core.RequestEvent) error {
	if err := requireTokenManager(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), err)
	}
	filter := "organization = {:organization}"
	params := map[string]any{"organization": e.Auth.GetString("organization")}
	if e.Auth.GetString("role") != "admin" {
		filter += " && createdBy = {:actor}"
		params["actor"] = e.Auth.Id
	}
	records, err := e.App.FindRecordsByFilter("mcp_tokens", filter, "-created", 500, 0, params)
	if err != nil {
		return e.InternalServerError("No se pudieron cargar los tokens MCP.", err)
	}
	items := make([]tokenView, 0, len(records))
	for _, record := range records {
		items = append(items, s.tokenView(record, ""))
	}
	return e.JSON(http.StatusOK, map[string]any{
		"items":  items,
		"mcpUrl": s.publicMCPURL(),
	})
}

func (s *Service) createToken(e *core.RequestEvent) error {
	if err := requireTokenManager(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), err)
	}
	var body struct {
		Name      string `json:"name"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("La solicitud no es válida.", err)
	}
	body.Name = strings.TrimSpace(body.Name)
	if len(body.Name) < 3 || len(body.Name) > 80 {
		return e.BadRequestError("El nombre debe tener entre 3 y 80 caracteres.", nil)
	}
	expiresAt, err := time.Parse(time.RFC3339, body.ExpiresAt)
	if err != nil {
		return e.BadRequestError("La caducidad no es válida.", err)
	}
	now := time.Now()
	if expiresAt.Before(now.Add(24*time.Hour)) || expiresAt.After(now.AddDate(0, 6, 0)) {
		return e.BadRequestError("La caducidad debe estar entre un día y seis meses.", nil)
	}

	prefix, err := randomURLString(9)
	if err != nil {
		return e.InternalServerError("No se pudo generar el token.", err)
	}
	secret, err := randomURLString(32)
	if err != nil {
		return e.InternalServerError("No se pudo generar el token.", err)
	}
	raw := "ojmcp_" + prefix + "_" + secret
	collection, err := e.App.FindCollectionByNameOrId("mcp_tokens")
	if err != nil {
		return e.InternalServerError("La migración MCP no está disponible.", err)
	}
	record := core.NewRecord(collection)
	record.Set("organization", e.Auth.GetString("organization"))
	record.Set("createdBy", e.Auth.Id)
	record.Set("name", body.Name)
	record.Set("prefix", prefix)
	record.Set("tokenHash", hashToken(raw))
	record.Set("expiresAt", expiresAt)
	if err := e.App.Save(record); err != nil {
		return e.InternalServerError("No se pudo guardar el token MCP.", err)
	}
	s.audit(&principal{token: record, actor: e.Auth}, "mcp_token.crear", "success", []string{record.Id})
	return e.JSON(http.StatusCreated, s.tokenView(record, raw))
}

func (s *Service) revokeToken(e *core.RequestEvent) error {
	if err := requireTokenManager(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), err)
	}
	record, err := e.App.FindRecordById("mcp_tokens", e.Request.PathValue("id"))
	if err != nil || record.GetString("organization") != e.Auth.GetString("organization") {
		return e.NotFoundError("No se ha encontrado el token MCP.", err)
	}
	if e.Auth.GetString("role") != "admin" && record.GetString("createdBy") != e.Auth.Id {
		return e.ForbiddenError("Solo puedes revocar tus propios tokens.", nil)
	}
	if record.GetString("revokedAt") == "" {
		record.Set("revokedAt", time.Now())
		if err := e.App.Save(record); err != nil {
			return e.InternalServerError("No se pudo revocar el token MCP.", err)
		}
	}
	s.audit(&principal{token: record, actor: e.Auth}, "mcp_token.revocar", "success", []string{record.Id})
	return e.JSON(http.StatusOK, s.tokenView(record, ""))
}

func (s *Service) tokenView(record *core.Record, raw string) tokenView {
	actorName := ""
	actorRole := ""
	if actor, err := s.app.FindRecordById("users", record.GetString("createdBy")); err == nil {
		actorName = actor.GetString("name")
		actorRole = actor.GetString("role")
	}
	return tokenView{
		ID:         record.Id,
		Name:       record.GetString("name"),
		Prefix:     record.GetString("prefix"),
		CreatedBy:  record.GetString("createdBy"),
		ActorName:  actorName,
		ActorRole:  actorRole,
		ExpiresAt:  record.GetDateTime("expiresAt").String(),
		LastUsedAt: record.GetDateTime("lastUsedAt").String(),
		RevokedAt:  record.GetDateTime("revokedAt").String(),
		Created:    record.GetDateTime("created").String(),
		Token:      raw,
	}
}

func requireTokenManager(actor *core.Record) error {
	if actor == nil || !actor.GetBool("active") {
		return errors.New("Debes iniciar sesión con una cuenta activa.")
	}
	role := actor.GetString("role")
	if role != "admin" && role != "manager" {
		return errors.New("Solo administración y responsables pueden gestionar tokens MCP.")
	}
	return nil
}

func randomURLString(bytes int) (string, error) {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
