package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

type apiResponse struct {
	Status int
	Header http.Header
	Body   []byte
}

func (s *Service) doJSON(
	ctx context.Context,
	actor *core.Record,
	method string,
	path string,
	query url.Values,
	body any,
) (any, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("no se pudo preparar la solicitud: %w", err)
		}
		reader = bytes.NewReader(data)
	}
	response, err := s.do(ctx, actor, method, path, query, reader, "application/json")
	if err != nil {
		return nil, err
	}
	if len(response.Body) == 0 {
		return map[string]any{"status": response.Status}, nil
	}
	var value any
	if err := json.Unmarshal(response.Body, &value); err != nil {
		return nil, fmt.Errorf("PocketBase devolvió una respuesta no válida")
	}
	return value, nil
}

func (s *Service) doMultipart(
	ctx context.Context,
	actor *core.Record,
	method string,
	path string,
	fields map[string]string,
	fileField string,
	filename string,
	content []byte,
) (any, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return nil, err
		}
	}
	part, err := writer.CreateFormFile(fileField, filename)
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(content); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	response, err := s.do(
		ctx,
		actor,
		method,
		path,
		nil,
		&body,
		writer.FormDataContentType(),
	)
	if err != nil {
		return nil, err
	}
	var value any
	if err := json.Unmarshal(response.Body, &value); err != nil {
		return nil, fmt.Errorf("PocketBase devolvió una respuesta no válida")
	}
	return value, nil
}

func (s *Service) do(
	ctx context.Context,
	actor *core.Record,
	method string,
	path string,
	query url.Values,
	body io.Reader,
	contentType string,
) (*apiResponse, error) {
	target := s.internalURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if contentType != "" && body != nil {
		request.Header.Set("Content-Type", contentType)
	}
	authToken, err := actor.NewStaticAuthToken(2 * time.Minute)
	if err != nil {
		return nil, fmt.Errorf("no se pudo crear la autorización interna: %w", err)
	}
	request.Header.Set("Authorization", authToken)
	response, err := s.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("no se pudo contactar con PocketBase: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxMCPBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxMCPBodyBytes {
		return nil, fmt.Errorf("la respuesta de PocketBase supera el límite permitido")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, pocketBaseError(response.StatusCode, data)
	}
	return &apiResponse{Status: response.StatusCode, Header: response.Header.Clone(), Body: data}, nil
}

func pocketBaseError(status int, data []byte) error {
	var payload struct {
		Message string `json:"message"`
	}
	_ = json.Unmarshal(data, &payload)
	message := strings.TrimSpace(payload.Message)
	if message == "" {
		message = http.StatusText(status)
	}
	return fmt.Errorf("PocketBase (%d): %s", status, message)
}

func collectionPath(collection string, id ...string) string {
	path := "/api/collections/" + url.PathEscape(collection) + "/records"
	if len(id) > 0 && id[0] != "" {
		path += "/" + url.PathEscape(id[0])
	}
	return path
}

func listQuery(args map[string]any, filterParts []string, sort, expand string) url.Values {
	page := boundedInt(args, "pagina", 1, 1, 100000)
	perPage := boundedInt(args, "por_pagina", 50, 1, 100)
	query := url.Values{
		"page":    {strconv.Itoa(page)},
		"perPage": {strconv.Itoa(perPage)},
	}
	if len(filterParts) > 0 {
		query.Set("filter", strings.Join(filterParts, " && "))
	}
	if sort != "" {
		query.Set("sort", sort)
	}
	if expand != "" {
		query.Set("expand", expand)
	}
	return query
}

func filterEqual(field, value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	return field + " = " + strconv.Quote(strings.TrimSpace(value))
}

func filterDate(field, operator, value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	timePart := " 00:00:00.000Z"
	if operator == "<=" {
		timePart = " 23:59:59.999Z"
	}
	return field + " " + operator + " " + strconv.Quote(strings.TrimSpace(value)+timePart)
}

func nonEmpty(values ...string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}

func decodeArgs(raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	var args map[string]any
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil, fmt.Errorf("los argumentos no son JSON válido")
	}
	if args == nil {
		args = map[string]any{}
	}
	return args, nil
}

func stringArg(args map[string]any, key string) string {
	value, _ := args[key].(string)
	return strings.TrimSpace(value)
}

func requiredString(args map[string]any, key, label string) (string, error) {
	value := stringArg(args, key)
	if value == "" {
		return "", fmt.Errorf("falta el campo obligatorio %q", label)
	}
	return value, nil
}

func boolArg(args map[string]any, key string, fallback bool) bool {
	value, ok := args[key].(bool)
	if !ok {
		return fallback
	}
	return value
}

func numberArg(args map[string]any, key string, fallback float64) float64 {
	value, ok := args[key].(float64)
	if !ok {
		return fallback
	}
	return value
}

func boundedInt(args map[string]any, key string, fallback, min, max int) int {
	value := int(numberArg(args, key, float64(fallback)))
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func stringSliceArg(args map[string]any, key string) []string {
	raw, ok := args[key].([]any)
	if !ok {
		return nil
	}
	values := make([]string, 0, len(raw))
	for _, item := range raw {
		if value, ok := item.(string); ok && strings.TrimSpace(value) != "" {
			values = append(values, strings.TrimSpace(value))
		}
	}
	return values
}
