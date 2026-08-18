package terminal

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"golang.org/x/crypto/bcrypt"
)

type bootstrapRequest struct {
	ProtocolVersion int    `json:"protocolVersion"`
	ClientVersion   string `json:"clientVersion"`
	PendingCount    int    `json:"pendingCount"`
}

func (s *Service) bootstrap(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	var body bootstrapRequest
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("El estado del terminal no es válido.", err)
	}
	if body.ProtocolVersion != protocolVersion {
		return apiError(e, http.StatusUpgradeRequired, "protocol_incompatible", "Este terminal necesita una actualización por USB.")
	}
	if body.PendingCount < 0 {
		body.PendingCount = 0
	}
	if body.PendingCount > maxQueuedActions {
		body.PendingCount = maxQueuedActions
	}
	principal.Terminal.Set("protocolVersion", protocolVersion)
	principal.Terminal.Set("clientVersion", strings.TrimSpace(body.ClientVersion))
	principal.Terminal.Set("lastPendingCount", body.PendingCount)
	principal.Terminal.Set("lastSeenAt", time.Now())
	principal.Terminal.Set("cacheRevision", principal.Organization.GetInt("rfidCacheRevision"))
	if err := e.App.Save(principal.Terminal); err != nil {
		return e.InternalServerError("No se pudo actualizar el terminal.", err)
	}
	return e.JSON(http.StatusOK, map[string]any{
		"protocol":          map[string]any{"current": 1, "min": 1, "max": 1},
		"serverTime":        time.Now().UTC().Format(time.RFC3339Nano),
		"timezone":          organizationTimezone(principal.Organization),
		"cacheRevision":     principal.Organization.GetInt("rfidCacheRevision"),
		"maxOfflineSeconds": int(maxOfflineDuration / time.Second),
		"maxQueuedActions":  maxQueuedActions,
		"terminal":          terminalRecordView(principal.Terminal, ""),
	})
}

func organizationTimezone(organization *core.Record) string {
	if timezone := strings.TrimSpace(organization.GetString("timezone")); timezone != "" {
		return timezone
	}
	return "Europe/Madrid"
}

func (s *Service) createAdminSession(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	if retryAfter := s.pinRetryAfter(e.App, principal); retryAfter > 0 {
		return e.JSON(http.StatusTooManyRequests, map[string]any{
			"status": http.StatusTooManyRequests, "code": "pin_rate_limited",
			"message": "Espera antes de volver a intentar el PIN.", "retryAfterSeconds": int(retryAfter.Seconds()),
		})
	}
	var body struct {
		PIN string `json:"pin"`
	}
	if err := e.BindBody(&body); err != nil || !pinPattern.MatchString(body.PIN) {
		return e.BadRequestError("El PIN debe contener cuatro cifras.", err)
	}
	hash := principal.Organization.GetString("terminalAdminPinHash")
	if hash == "" {
		return apiError(e, http.StatusConflict, "pin_not_configured", "Configura primero el PIN desde la web.")
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(body.PIN)) != nil {
		retry := s.recordPINFailure(e.App, principal)
		status := http.StatusUnauthorized
		code := "pin_invalid"
		if retry > 0 {
			status = http.StatusTooManyRequests
			code = "pin_rate_limited"
		}
		return e.JSON(status, map[string]any{
			"status": status, "code": code, "message": "El PIN no es correcto.", "retryAfterSeconds": int(retry.Seconds()),
		})
	}
	if err := s.resetPINAttempts(e.App, principal.Organization.Id); err != nil {
		return e.InternalServerError("No se pudo reiniciar el bloqueo del PIN.", err)
	}
	raw, err := randomURLString(32)
	if err != nil {
		return e.InternalServerError("No se pudo abrir la sesión administrativa.", err)
	}
	collection, err := e.App.FindCollectionByNameOrId("terminal_admin_sessions")
	if err != nil {
		return e.InternalServerError("La migración de terminales no está disponible.", err)
	}
	record := core.NewRecord(collection)
	record.Set("organization", principal.Organization.Id)
	record.Set("terminal", principal.Terminal.Id)
	record.Set("tokenHash", hashValue(raw))
	record.Set("lastUsedAt", time.Now())
	if err := e.App.Save(record); err != nil {
		return e.InternalServerError("No se pudo abrir la sesión administrativa.", err)
	}
	return e.JSON(http.StatusCreated, map[string]any{
		"token":         "ojtadmin_" + raw,
		"idleExpiresAt": time.Now().Add(adminIdleTimeout).UTC().Format(time.RFC3339Nano),
	})
}

func (s *Service) pinRetryAfter(app core.App, principal *terminalPrincipal) time.Duration {
	now := time.Now()
	var remaining time.Duration
	for _, scope := range []string{principal.Terminal.Id, "organization"} {
		record, err := app.FindFirstRecordByFilter("terminal_pin_attempts", "organization = {:organization} && scope = {:scope}", map[string]any{"organization": principal.Organization.Id, "scope": scope})
		if err != nil {
			continue
		}
		blockedUntil := record.GetDateTime("blockedUntil").Time()
		if blockedUntil.After(now) && blockedUntil.Sub(now) > remaining {
			remaining = blockedUntil.Sub(now)
		}
	}
	return remaining
}

func (s *Service) recordPINFailure(app core.App, principal *terminalPrincipal) time.Duration {
	now := time.Now()
	var longest time.Duration
	for _, scope := range []string{principal.Terminal.Id, "organization"} {
		record, err := app.FindFirstRecordByFilter("terminal_pin_attempts", "organization = {:organization} && scope = {:scope}", map[string]any{"organization": principal.Organization.Id, "scope": scope})
		if err != nil {
			collection, findErr := app.FindCollectionByNameOrId("terminal_pin_attempts")
			if findErr != nil {
				continue
			}
			record = core.NewRecord(collection)
			record.Set("organization", principal.Organization.Id)
			record.Set("scope", scope)
			if scope != "organization" {
				record.Set("terminal", principal.Terminal.Id)
			}
		}
		failures := record.GetInt("failures") + 1
		delay := pinDelay(failures)
		record.Set("failures", failures)
		if delay > 0 {
			record.Set("blockedUntil", now.Add(delay))
		}
		_ = app.Save(record)
		if delay > longest {
			longest = delay
		}
	}
	return longest
}

func (s *Service) resetPINAttempts(app core.App, organization string) error {
	records, err := app.FindRecordsByFilter("terminal_pin_attempts", "organization = {:organization}", "updated", 10000, 0, map[string]any{"organization": organization})
	if err != nil {
		return err
	}
	for _, record := range records {
		if err := app.Delete(record); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) requireDeviceAdmin(e *core.RequestEvent, principal *terminalPrincipal) (*core.Record, error) {
	header := strings.TrimSpace(e.Request.Header.Get("X-Terminal-Admin-Session"))
	if !strings.HasPrefix(header, "ojtadmin_") {
		return nil, apiError(e, http.StatusUnauthorized, "admin_session_required", "Abre el modo administración con el PIN.")
	}
	record, err := e.App.FindFirstRecordByFilter("terminal_admin_sessions", "tokenHash = {:hash}", map[string]any{"hash": hashValue(strings.TrimPrefix(header, "ojtadmin_"))})
	if err != nil || record.GetString("terminal") != principal.Terminal.Id || record.GetString("organization") != principal.Organization.Id || record.GetString("revokedAt") != "" {
		return nil, apiError(e, http.StatusUnauthorized, "admin_session_required", "La sesión administrativa no es válida.")
	}
	if time.Since(record.GetDateTime("lastUsedAt").Time()) > adminIdleTimeout {
		record.Set("revokedAt", time.Now())
		_ = e.App.Save(record)
		return nil, apiError(e, http.StatusUnauthorized, "admin_session_expired", "La sesión administrativa ha caducado.")
	}
	record.Set("lastUsedAt", time.Now())
	if err := e.App.Save(record); err != nil {
		return nil, e.InternalServerError("No se pudo actualizar la sesión administrativa.", err)
	}
	return record, nil
}

func (s *Service) closeAdminSession(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	record, err := s.requireDeviceAdmin(e, principal)
	if err != nil {
		return err
	}
	record.Set("revokedAt", time.Now())
	if err := e.App.Save(record); err != nil {
		return e.InternalServerError("No se pudo cerrar la sesión administrativa.", err)
	}
	return e.JSON(http.StatusOK, map[string]any{"closed": true})
}

func (s *Service) listDeviceEmployees(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	if _, err := s.requireDeviceAdmin(e, principal); err != nil {
		return err
	}
	return s.respondEmployees(e, principal.Organization.Id, 30)
}

func (s *Service) assignRFIDDevice(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	if _, err := s.requireDeviceAdmin(e, principal); err != nil {
		return err
	}
	var body struct {
		UID     string `json:"uid"`
		Replace bool   `json:"replace"`
	}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("La asignación RFID no es válida.", err)
	}
	return s.assignRFID(e, principal.Organization.Id, e.Request.PathValue("id"), body.UID, body.Replace)
}

func (s *Service) revokeRFIDDevice(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	if _, err := s.requireDeviceAdmin(e, principal); err != nil {
		return err
	}
	return s.revokeRFID(e, principal.Organization.Id, e.Request.PathValue("id"))
}

func (s *Service) deviceCache(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	revision := principal.Organization.GetInt("rfidCacheRevision")
	if requested, _ := strconv.Atoi(e.Request.URL.Query().Get("revision")); requested == revision {
		return e.JSON(http.StatusOK, map[string]any{"revision": revision, "unchanged": true, "items": []any{}})
	}
	records, err := e.App.FindRecordsByFilter("users", "organization = {:organization} && active = true && rfidUidFingerprint != ''", "name", 30, 0, map[string]any{"organization": principal.Organization.Id})
	if err != nil {
		return e.InternalServerError("No se pudo construir la caché RFID.", err)
	}
	items := make([]map[string]any, 0, len(records))
	for _, employee := range records {
		uid, decryptErr := decryptValue(employee.GetString("rfidUidCiphertext"))
		if decryptErr != nil {
			return e.InternalServerError("No se pudo descifrar la caché RFID.", decryptErr)
		}
		state, stateErr := s.employeeState(e.App, employee.Id, time.Now())
		if stateErr != nil {
			return e.InternalServerError("No se pudo calcular el estado de la persona.", stateErr)
		}
		items = append(items, map[string]any{"employeeId": employee.Id, "displayName": abbreviatedName(employee.GetString("name")), "uid": uid, "state": stateResponse(state)})
	}
	return e.JSON(http.StatusOK, map[string]any{"revision": revision, "unchanged": false, "items": items})
}

func (s *Service) resolveTag(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	var body struct {
		UID string `json:"uid"`
	}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("La lectura RFID no es válida.", err)
	}
	employee, fingerprint, err := s.employeeForUID(e.App, principal.Organization.Id, body.UID)
	if err != nil {
		return apiError(e, http.StatusNotFound, "unknown_tag", "Tag no asignado; avisa a un responsable.")
	}
	state, err := s.employeeState(e.App, employee.Id, time.Now())
	if err != nil {
		return e.InternalServerError("No se pudo calcular el estado actual.", err)
	}
	expiresAt := time.Now().Add(scanContextTTL)
	context := createScanContext(principal.SigningKey, principal.Terminal.Id, employee.Id, fingerprint, expiresAt)
	return e.JSON(http.StatusOK, map[string]any{
		"scanContext": context,
		"expiresAt":   expiresAt.UTC().Format(time.RFC3339Nano),
		"employee":    map[string]any{"id": employee.Id, "displayName": abbreviatedName(employee.GetString("name"))},
		"state":       stateResponse(state),
	})
}

func (s *Service) employeeForUID(app core.App, organization, rawUID string) (*core.Record, string, error) {
	uid, err := normalizeUID(rawUID)
	if err != nil {
		return nil, "", err
	}
	fingerprint, err := uidFingerprint(uid)
	if err != nil {
		return nil, "", err
	}
	employee, err := app.FindFirstRecordByFilter("users", "organization = {:organization} && active = true && rfidUidFingerprint = {:fingerprint}", map[string]any{"organization": organization, "fingerprint": fingerprint})
	if err != nil {
		return nil, "", err
	}
	return employee, fingerprint, nil
}

func createScanContext(key []byte, terminalID, employeeID, fingerprint string, expiresAt time.Time) string {
	payload := strings.Join([]string{terminalID, employeeID, fingerprint, strconv.FormatInt(expiresAt.Unix(), 10)}, "|")
	encoded := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return encoded + "." + signPayload(key, encoded)
}

func parseScanContext(key []byte, value, terminalID string) (employeeID, fingerprint string, err error) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 || !verifySignature(key, parts[0], parts[1]) {
		return "", "", fmt.Errorf("invalid scan context")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", "", err
	}
	fields := strings.Split(string(decoded), "|")
	if len(fields) != 4 || fields[0] != terminalID {
		return "", "", fmt.Errorf("invalid scan context")
	}
	expires, err := strconv.ParseInt(fields[3], 10, 64)
	if err != nil || time.Now().Unix() > expires {
		return "", "", fmt.Errorf("expired scan context")
	}
	return fields[1], fields[2], nil
}

func stateResponse(state WorkState) map[string]any {
	actions := make([]map[string]any, 0, 3)
	switch state.Kind {
	case StateIdle:
		actions = append(actions, map[string]any{"command": CommandClockIn, "label": "Comenzar jornada", "mode": "now", "highlighted": false})
	case StateWorking:
		actions = append(actions,
			map[string]any{"command": CommandBreakStart, "label": "Comenzar pausa", "mode": "now", "highlighted": false},
			map[string]any{"command": CommandClockOut, "label": "Terminar ahora", "mode": "now", "highlighted": false},
		)
		if state.LongShift {
			actions = append(actions, map[string]any{"command": CommandClockOut, "label": "Ya terminé antes", "mode": "choose_time", "highlighted": true})
		}
	case StateOnBreak:
		actions = append(actions,
			map[string]any{"command": CommandBreakEnd, "label": "Terminar pausa", "mode": "now", "highlighted": false},
			map[string]any{"command": CommandClockOut, "label": "Acabar jornada", "mode": "close_from_break", "highlighted": state.StaleBreak},
		)
	}
	return map[string]any{
		"kind": state.Kind, "since": state.Since, "workedSeconds": state.WorkedSeconds, "breakSeconds": state.BreakSeconds,
		"longShift": state.LongShift, "staleBreak": state.StaleBreak, "actions": actions,
	}
}

func sortQueuedActions(actions []queuedAction) {
	sort.SliceStable(actions, func(i, j int) bool {
		left, _ := time.Parse(time.RFC3339Nano, actions[i].DeviceCapturedAt)
		right, _ := time.Parse(time.RFC3339Nano, actions[j].DeviceCapturedAt)
		if left.Equal(right) {
			return actions[i].DeviceSequence < actions[j].DeviceSequence
		}
		return left.Before(right)
	})
}
