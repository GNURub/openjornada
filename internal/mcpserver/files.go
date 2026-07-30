package mcpserver

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const signedFileTTL = 5 * time.Minute

var protectedFileFields = map[string]string{
	"employee_documents": "file",
	"leave_requests":     "attachment",
	"expenses":           "receipt",
}

func (s *Service) fileLink(ctx context.Context, p *principal, collection, recordID, field string) (any, []string, error) {
	if recordID == "" {
		return nil, nil, fmt.Errorf("falta el identificador del registro")
	}
	if protectedFileFields[collection] != field {
		return nil, []string{recordID}, fmt.Errorf("el campo de archivo no está permitido")
	}
	value, err := s.doJSON(ctx, p.actor, http.MethodGet, collectionPath(collection, recordID), nil, nil)
	if err != nil {
		return nil, []string{recordID}, err
	}
	record, ok := value.(map[string]any)
	if !ok {
		return nil, []string{recordID}, fmt.Errorf("el registro no es válido")
	}
	filename, _ := record[field].(string)
	if filename == "" {
		return nil, []string{recordID}, fmt.Errorf("el registro no contiene ningún archivo")
	}
	link, expiresAt, err := s.signedFileURL(p.token.Id, collection, recordID, field)
	if err != nil {
		return nil, []string{recordID}, err
	}
	return map[string]any{
		"url":         link,
		"filename":    filename,
		"expiresAt":   expiresAt.Format(time.RFC3339),
		"expiresIn":   int(signedFileTTL.Seconds()),
		"singleUse":   false,
		"cachePolicy": "no-store",
	}, []string{recordID}, nil
}

func (s *Service) signedFileURL(tokenID, collection, recordID, field string) (string, time.Time, error) {
	key := strings.TrimSpace(os.Getenv("PB_ENCRYPTION_KEY"))
	if key == "" {
		return "", time.Time{}, fmt.Errorf("la descarga MCP no está configurada: falta PB_ENCRYPTION_KEY")
	}
	expiresAt := time.Now().Add(signedFileTTL).UTC()
	expires := strconv.FormatInt(expiresAt.Unix(), 10)
	canonical := strings.Join([]string{tokenID, collection, recordID, field, expires}, "\n")
	query := url.Values{
		"token":      {tokenID},
		"collection": {collection},
		"record":     {recordID},
		"field":      {field},
		"expires":    {expires},
		"signature":  {signValue(key, canonical)},
	}
	publicURL := strings.TrimRight(strings.TrimSpace(os.Getenv("PB_PUBLIC_URL")), "/")
	if publicURL == "" {
		publicURL = strings.TrimRight(s.app.Settings().Meta.AppURL, "/")
	}
	if publicURL == "" {
		return "", time.Time{}, fmt.Errorf("la URL pública de PocketBase no está configurada")
	}
	return publicURL + "/api/openjornada/mcp-files?" + query.Encode(), expiresAt, nil
}

func (s *Service) downloadFile(w http.ResponseWriter, r *http.Request) {
	if !s.enabled {
		http.NotFound(w, r)
		return
	}
	query := r.URL.Query()
	tokenID := query.Get("token")
	collection := query.Get("collection")
	recordID := query.Get("record")
	field := query.Get("field")
	expiresRaw := query.Get("expires")
	signature := query.Get("signature")
	if protectedFileFields[collection] != field || tokenID == "" || recordID == "" {
		http.Error(w, "Enlace de descarga no válido.", http.StatusBadRequest)
		return
	}
	expires, err := strconv.ParseInt(expiresRaw, 10, 64)
	now := time.Now()
	if err != nil || now.Unix() > expires || time.Unix(expires, 0).After(now.Add(signedFileTTL+time.Minute)) {
		http.Error(w, "El enlace de descarga ha caducado.", http.StatusUnauthorized)
		return
	}
	key := strings.TrimSpace(os.Getenv("PB_ENCRYPTION_KEY"))
	canonical := strings.Join([]string{tokenID, collection, recordID, field, expiresRaw}, "\n")
	expected, decodeErr := hex.DecodeString(signValue(key, canonical))
	provided, signatureErr := hex.DecodeString(signature)
	if key == "" || decodeErr != nil || signatureErr != nil || len(expected) != len(provided) || subtle.ConstantTimeCompare(expected, provided) != 1 {
		http.Error(w, "Firma de descarga no válida.", http.StatusUnauthorized)
		return
	}
	p, err := s.principalForTokenID(tokenID)
	if err != nil {
		http.Error(w, "El token MCP ya no es válido.", http.StatusUnauthorized)
		return
	}
	recordValue, err := s.doJSON(r.Context(), p.actor, http.MethodGet, collectionPath(collection, recordID), nil, nil)
	if err != nil {
		http.Error(w, "No tienes acceso al archivo.", http.StatusForbidden)
		return
	}
	record, ok := recordValue.(map[string]any)
	filename, _ := record[field].(string)
	if !ok || filename == "" {
		http.NotFound(w, r)
		return
	}
	fileTokenValue, err := s.doJSON(r.Context(), p.actor, http.MethodPost, "/api/files/token", nil, nil)
	if err != nil {
		http.Error(w, "No se pudo autorizar la descarga.", http.StatusBadGateway)
		return
	}
	fileTokenMap, _ := fileTokenValue.(map[string]any)
	fileToken, _ := fileTokenMap["token"].(string)
	if fileToken == "" {
		http.Error(w, "No se pudo autorizar la descarga.", http.StatusBadGateway)
		return
	}
	fileQuery := url.Values{"token": {fileToken}, "download": {"1"}}
	response, err := s.do(
		r.Context(),
		p.actor,
		http.MethodGet,
		"/api/files/"+url.PathEscape(collection)+"/"+url.PathEscape(recordID)+"/"+url.PathEscape(filename),
		fileQuery,
		nil,
		"",
	)
	if err != nil {
		http.Error(w, "No se pudo descargar el archivo.", http.StatusBadGateway)
		return
	}
	contentType := response.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", `attachment; filename="`+safeFilename(filename)+`"`)
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(response.Body)
	s.audit(p, "archivo.descargar", "success", []string{recordID})
}

func (s *Service) principalForTokenID(tokenID string) (*principal, error) {
	token, err := s.app.FindRecordById("mcp_tokens", tokenID)
	if err != nil || token.GetString("revokedAt") != "" || !token.GetDateTime("expiresAt").Time().After(time.Now()) {
		return nil, fmt.Errorf("token no válido")
	}
	actor, err := s.app.FindRecordById("users", token.GetString("createdBy"))
	if err != nil ||
		!actor.GetBool("active") ||
		actor.GetString("organization") != token.GetString("organization") ||
		(actor.GetString("role") != "admin" && actor.GetString("role") != "manager") {
		return nil, fmt.Errorf("actor no válido")
	}
	return &principal{token: token, actor: actor}, nil
}

func safeFilename(value string) string {
	value = strings.ReplaceAll(value, `"`, "")
	value = strings.ReplaceAll(value, "\r", "")
	value = strings.ReplaceAll(value, "\n", "")
	if value == "" {
		return "documento"
	}
	return value
}
