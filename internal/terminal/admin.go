package terminal

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"golang.org/x/crypto/bcrypt"
)

var pinPattern = regexp.MustCompile(`^\d{4}$`)

const terminalListPageSize = 10

const terminalListSort = "-created,-id"

const terminalOnlineWindow = 45 * time.Second

const terminalPingTimeout = 20 * time.Second

type terminalView struct {
	ID                      string `json:"id"`
	Organization            string `json:"organization"`
	Name                    string `json:"name"`
	Prefix                  string `json:"prefix"`
	ProtocolVersion         int    `json:"protocolVersion"`
	ClientVersion           string `json:"clientVersion"`
	CacheRevision           int    `json:"cacheRevision"`
	LastSeenAt              string `json:"lastSeenAt"`
	LastPendingCount        int    `json:"lastPendingCount"`
	RevokedAt               string `json:"revokedAt"`
	CreatedBy               string `json:"createdBy"`
	Created                 string `json:"created"`
	Token                   string `json:"token,omitempty"`
	PendingQueueWarning     bool   `json:"pendingQueueWarning"`
	ConnectionStatus        string `json:"connectionStatus"`
	LastHeartbeatAt         string `json:"lastHeartbeatAt"`
	LastAttendanceSyncAt    string `json:"lastAttendanceSyncAt"`
	LastClockStatus         string `json:"lastClockStatus"`
	LastNtpSyncAt           string `json:"lastNtpSyncAt"`
	LastWifiRssiDbm         *int   `json:"lastWifiRssiDbm"`
	LastUptimeSeconds       *int   `json:"lastUptimeSeconds"`
	FirmwareUpdateStatus    string `json:"firmwareUpdateStatus"`
	FirmwareTargetVersion   string `json:"firmwareTargetVersion"`
	LastFirmwareCheckAt     string `json:"lastFirmwareCheckAt"`
	FirmwareUpdateErrorCode string `json:"firmwareUpdateErrorCode"`
}

func terminalRecordView(record *core.Record, raw string) terminalView {
	return terminalRecordViewAt(record, raw, time.Now())
}

func terminalConnectionStatus(record *core.Record, now time.Time) string {
	if record.GetString("revokedAt") != "" {
		return "revoked"
	}
	heartbeat := record.GetDateTime("lastHeartbeatAt").Time()
	if heartbeat.IsZero() || !heartbeat.After(now.Add(-terminalOnlineWindow)) {
		return "offline"
	}
	return "online"
}

func terminalRecordViewAt(record *core.Record, raw string, now time.Time) terminalView {
	var lastWifiRssiDbm *int
	var lastUptimeSeconds *int
	if !record.GetDateTime("lastHeartbeatAt").Time().IsZero() {
		wifiRssiDbm := record.GetInt("lastWifiRssiDbm")
		uptimeSeconds := record.GetInt("lastUptimeSeconds")
		lastWifiRssiDbm = &wifiRssiDbm
		lastUptimeSeconds = &uptimeSeconds
	}

	return terminalView{
		ID:                      record.Id,
		Organization:            record.GetString("organization"),
		Name:                    record.GetString("name"),
		Prefix:                  record.GetString("prefix"),
		ProtocolVersion:         record.GetInt("protocolVersion"),
		ClientVersion:           record.GetString("clientVersion"),
		CacheRevision:           record.GetInt("cacheRevision"),
		LastSeenAt:              record.GetDateTime("lastSeenAt").String(),
		LastPendingCount:        record.GetInt("lastPendingCount"),
		RevokedAt:               record.GetDateTime("revokedAt").String(),
		CreatedBy:               record.GetString("createdBy"),
		Created:                 record.GetDateTime("created").String(),
		Token:                   raw,
		PendingQueueWarning:     record.GetInt("lastPendingCount") > 0,
		ConnectionStatus:        terminalConnectionStatus(record, now),
		LastHeartbeatAt:         record.GetDateTime("lastHeartbeatAt").String(),
		LastAttendanceSyncAt:    record.GetDateTime("lastAttendanceSyncAt").String(),
		LastClockStatus:         record.GetString("lastClockStatus"),
		LastNtpSyncAt:           record.GetDateTime("lastNtpSyncAt").String(),
		LastWifiRssiDbm:         lastWifiRssiDbm,
		LastUptimeSeconds:       lastUptimeSeconds,
		FirmwareUpdateStatus:    record.GetString("firmwareUpdateStatus"),
		FirmwareTargetVersion:   record.GetString("firmwareTargetVersion"),
		LastFirmwareCheckAt:     record.GetDateTime("lastFirmwareCheckAt").String(),
		FirmwareUpdateErrorCode: record.GetString("firmwareUpdateErrorCode"),
	}
}

func terminalListPagination(rawPage string, totalItems int64) (int, int, error) {
	page := 1
	if rawPage != "" {
		parsed, err := strconv.Atoi(rawPage)
		if err != nil || parsed < 1 {
			return 0, 0, fmt.Errorf("invalid page")
		}
		page = parsed
	}

	totalPages := int((totalItems + terminalListPageSize - 1) / terminalListPageSize)
	if totalPages == 0 {
		return 1, 0, nil
	}
	if page > totalPages {
		page = totalPages
	}
	return page, totalPages, nil
}

func findTerminalRecordsPage(app core.App, organization string, page int) ([]*core.Record, error) {
	activeCount, err := app.CountRecords(
		"attendance_terminals",
		dbx.HashExp{"organization": organization, "revokedAt": ""},
	)
	if err != nil {
		return nil, err
	}

	offset := (page - 1) * terminalListPageSize
	items := make([]*core.Record, 0, terminalListPageSize)
	if int64(offset) < activeCount {
		active, err := app.FindRecordsByFilter(
			"attendance_terminals",
			"organization = {:organization} && revokedAt = ''",
			terminalListSort,
			terminalListPageSize,
			offset,
			map[string]any{"organization": organization},
		)
		if err != nil {
			return nil, err
		}
		items = append(items, active...)
	}

	remaining := terminalListPageSize - len(items)
	if remaining == 0 {
		return items, nil
	}
	revokedOffset := offset - int(activeCount)
	if revokedOffset < 0 {
		revokedOffset = 0
	}
	revoked, err := app.FindRecordsByFilter(
		"attendance_terminals",
		"organization = {:organization} && revokedAt != ''",
		terminalListSort,
		remaining,
		revokedOffset,
		map[string]any{"organization": organization},
	)
	if err != nil {
		return nil, err
	}
	return append(items, revoked...), nil
}

func (s *Service) listTerminals(e *core.RequestEvent) error {
	if err := requireRFIDManager(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	organizationID := e.Auth.GetString("organization")
	totalItems, err := e.App.CountRecords(
		"attendance_terminals",
		dbx.HashExp{"organization": organizationID},
	)
	if err != nil {
		return e.InternalServerError("No se pudieron contar los terminales.", err)
	}
	page, totalPages, err := terminalListPagination(e.Request.URL.Query().Get("page"), totalItems)
	if err != nil {
		return e.BadRequestError("La página solicitada no es válida.", err)
	}
	records, err := findTerminalRecordsPage(e.App, organizationID, page)
	if err != nil {
		return e.InternalServerError("No se pudieron cargar los terminales.", err)
	}
	items := make([]terminalView, 0, len(records))
	for _, record := range records {
		items = append(items, terminalRecordView(record, ""))
	}
	organization, _ := e.App.FindRecordById("organizations", organizationID)
	return e.JSON(http.StatusOK, map[string]any{
		"items":              items,
		"adminPinConfigured": organization != nil && organization.GetString("terminalAdminPinHash") != "",
		"page":               page,
		"perPage":            terminalListPageSize,
		"totalItems":         totalItems,
		"totalPages":         totalPages,
	})
}

func (s *Service) createTerminal(e *core.RequestEvent) error {
	if err := requireAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("Los datos del terminal no son válidos.", err)
	}
	body.Name = strings.TrimSpace(body.Name)
	if len(body.Name) < 3 || len(body.Name) > 80 {
		return e.BadRequestError("El nombre debe tener entre 3 y 80 caracteres.", nil)
	}
	raw, prefix, signingMaterial, err := createTerminalToken()
	if err != nil {
		return e.InternalServerError("No se pudo crear la credencial del terminal.", err)
	}
	collection, err := e.App.FindCollectionByNameOrId("attendance_terminals")
	if err != nil {
		return e.InternalServerError("La migración de terminales no está disponible.", err)
	}
	record := core.NewRecord(collection)
	record.Set("organization", e.Auth.GetString("organization"))
	record.Set("createdBy", e.Auth.Id)
	record.Set("name", body.Name)
	record.Set("prefix", prefix)
	record.Set("tokenHash", hashValue(raw))
	record.Set("signingMaterial", signingMaterial)
	record.Set("protocolVersion", protocolVersion)
	if err := e.App.Save(record); err != nil {
		return e.InternalServerError("No se pudo guardar el terminal.", err)
	}
	return e.JSON(http.StatusCreated, terminalRecordView(record, raw))
}

func (s *Service) findOwnedTerminal(e *core.RequestEvent) (*core.Record, error) {
	record, err := findTerminalForOrganization(e.App, e.Request.PathValue("id"), e.Auth.GetString("organization"))
	if err != nil {
		return nil, e.NotFoundError("No se ha encontrado el terminal.", err)
	}
	return record, nil
}

func findTerminalForOrganization(app core.App, terminalID, organizationID string) (*core.Record, error) {
	record, err := app.FindFirstRecordByFilter(
		"attendance_terminals",
		"id = {:id} && organization = {:organization}",
		map[string]any{"id": terminalID, "organization": organizationID},
	)
	if err != nil {
		return nil, err
	}
	return record, nil
}

func (s *Service) renameTerminal(e *core.RequestEvent) error {
	if err := requireAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	record, err := s.findOwnedTerminal(e)
	if err != nil {
		return err
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("El nombre no es válido.", err)
	}
	body.Name = strings.TrimSpace(body.Name)
	if len(body.Name) < 3 || len(body.Name) > 80 {
		return e.BadRequestError("El nombre debe tener entre 3 y 80 caracteres.", nil)
	}
	record.Set("name", body.Name)
	if err := e.App.Save(record); err != nil {
		return e.InternalServerError("No se pudo renombrar el terminal.", err)
	}
	return e.JSON(http.StatusOK, terminalRecordView(record, ""))
}

func (s *Service) rotateTerminalKey(e *core.RequestEvent) error {
	if err := requireAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	record, err := s.findOwnedTerminal(e)
	if err != nil {
		return err
	}
	if record.GetString("revokedAt") != "" {
		return e.BadRequestError("No se puede rotar un terminal revocado.", nil)
	}
	raw, prefix, signingMaterial, err := createTerminalToken()
	if err != nil {
		return e.InternalServerError("No se pudo rotar la credencial.", err)
	}
	record.Set("prefix", prefix)
	record.Set("tokenHash", hashValue(raw))
	record.Set("signingMaterial", signingMaterial)
	if err := e.App.Save(record); err != nil {
		return e.InternalServerError("No se pudo rotar la credencial.", err)
	}
	return e.JSON(http.StatusOK, terminalRecordView(record, raw))
}

func (s *Service) revokeTerminal(e *core.RequestEvent) error {
	if err := requireAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	record, err := s.findOwnedTerminal(e)
	if err != nil {
		return err
	}
	if record.GetString("revokedAt") == "" {
		record.Set("revokedAt", time.Now())
		if err := s.pings.cancelTerminalAfter(record.Id, errTerminalRevoked, func() error {
			return e.App.Save(record)
		}); err != nil {
			return e.InternalServerError("No se pudo revocar el terminal.", err)
		}
	}
	return e.JSON(http.StatusOK, terminalRecordView(record, ""))
}

func (s *Service) pingTerminal(e *core.RequestEvent) error {
	if err := requireRFIDManager(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	record, err := s.findOwnedTerminal(e)
	if err != nil {
		return err
	}
	if record.GetString("revokedAt") != "" {
		return apiError(e, http.StatusConflict, "terminal_revoked", "El terminal está revocado.")
	}

	startedAt := time.Now()
	waiter, err := s.beginTerminalPing(record, e.Auth.GetString("organization"), startedAt)
	if errors.Is(err, errPingInProgress) {
		return apiError(e, http.StatusConflict, "ping_in_progress", "Ya hay una comprobación en curso para este terminal.")
	}
	if errors.Is(err, errTerminalRevoked) {
		return apiError(e, http.StatusConflict, "terminal_revoked", "El terminal está revocado.")
	}
	if err != nil {
		return e.InternalServerError("No se pudo iniciar la comprobación del terminal.", err)
	}

	remaining := time.Until(startedAt.Add(s.pingTimeout))
	if remaining <= 0 {
		if s.pings.cancel(record.Id, waiter.Challenge, errPingExpired) {
			return apiError(e, http.StatusGatewayTimeout, "terminal_ping_timeout", "El terminal no respondió.")
		}
		return pingCompletionResponse(e, record.Id, <-waiter.Completion)
	}
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	select {
	case completion := <-waiter.Completion:
		return pingCompletionResponse(e, record.Id, completion)
	case <-timer.C:
		if s.pings.cancel(record.Id, waiter.Challenge, errPingExpired) {
			return apiError(e, http.StatusGatewayTimeout, "terminal_ping_timeout", "El terminal no respondió.")
		}
		return pingCompletionResponse(e, record.Id, <-waiter.Completion)
	case <-e.Request.Context().Done():
		cause := e.Request.Context().Err()
		s.pings.cancel(record.Id, waiter.Challenge, cause)
		return cause
	}
}

func (s *Service) beginTerminalPing(record *core.Record, organizationID string, startedAt time.Time) (pingWaiter, error) {
	waiter, err := s.pings.begin(record.Id, startedAt)
	if err != nil {
		return pingWaiter{}, err
	}
	current, err := findTerminalForOrganization(s.app, record.Id, organizationID)
	if err != nil {
		s.pings.cancel(record.Id, waiter.Challenge, err)
		return pingWaiter{}, err
	}
	if current.GetString("revokedAt") != "" {
		s.pings.cancel(record.Id, waiter.Challenge, errTerminalRevoked)
		return pingWaiter{}, errTerminalRevoked
	}
	return waiter, nil
}

func pingCompletionResponse(e *core.RequestEvent, terminalID string, completion pingCompletion) error {
	if errors.Is(completion.Err, errTerminalRevoked) {
		return apiError(e, http.StatusConflict, "terminal_revoked", "El terminal está revocado.")
	}
	if errors.Is(completion.Err, errPingExpired) {
		return apiError(e, http.StatusGatewayTimeout, "terminal_ping_timeout", "El terminal no respondió.")
	}
	if completion.Err != nil {
		return e.InternalServerError("No se pudo comprobar la conexión del terminal.", completion.Err)
	}
	result := completion.Result
	return e.JSON(http.StatusOK, map[string]any{
		"terminalId":         terminalID,
		"localIp":            result.LocalIP,
		"publicIp":           result.PublicIP,
		"wifiRssiDbm":        result.WifiRSSIDbm,
		"uptimeSeconds":      result.UptimeSeconds,
		"waitForHeartbeatMs": result.WaitForHeartbeatMs,
		"responseMs":         result.ResponseMs,
		"totalLatencyMs":     result.TotalLatencyMs,
		"checkedAt":          result.CheckedAt.UTC().Format(time.RFC3339Nano),
	})
}

func (s *Service) updateAdminPIN(e *core.RequestEvent) error {
	if err := requireAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	var body struct {
		PIN string `json:"pin"`
	}
	if err := e.BindBody(&body); err != nil || !pinPattern.MatchString(body.PIN) {
		return e.BadRequestError("El PIN debe contener exactamente cuatro cifras.", err)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(body.PIN), bcrypt.DefaultCost)
	if err != nil {
		return e.InternalServerError("No se pudo proteger el PIN.", err)
	}
	organization, err := e.App.FindRecordById("organizations", e.Auth.GetString("organization"))
	if err != nil {
		return e.NotFoundError("No se ha encontrado la empresa.", err)
	}
	err = e.App.RunInTransaction(func(tx core.App) error {
		organization, err := tx.FindRecordById("organizations", organization.Id)
		if err != nil {
			return err
		}
		organization.Set("terminalAdminPinHash", string(hash))
		if err := tx.Save(organization); err != nil {
			return err
		}
		for _, collection := range []string{"terminal_admin_sessions", "terminal_pin_attempts"} {
			records, findErr := tx.FindRecordsByFilter(collection, "organization = {:organization}", "id", 10000, 0, map[string]any{"organization": organization.Id})
			if findErr != nil {
				return findErr
			}
			for _, record := range records {
				if err := tx.Delete(record); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return e.InternalServerError("No se pudo actualizar el PIN.", err)
	}
	return e.JSON(http.StatusOK, map[string]any{"configured": true})
}

func (s *Service) listRFIDEmployees(e *core.RequestEvent) error {
	if err := requireRFIDManager(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	return s.respondEmployees(e, e.Auth.GetString("organization"), 500)
}

func (s *Service) respondEmployees(e *core.RequestEvent, organization string, limit int) error {
	records, err := e.App.FindRecordsByFilter("users", "organization = {:organization} && active = true", "name", limit, 0, map[string]any{"organization": organization})
	if err != nil {
		return e.InternalServerError("No se pudieron cargar las personas.", err)
	}
	items := make([]map[string]any, 0, len(records))
	for _, employee := range records {
		items = append(items, map[string]any{
			"id":          employee.Id,
			"name":        employee.GetString("name"),
			"displayName": abbreviatedName(employee.GetString("name")),
			"hasRfidTag":  employee.GetString("rfidUidFingerprint") != "",
		})
	}
	return e.JSON(http.StatusOK, map[string]any{"items": items})
}

func abbreviatedName(name string) string {
	parts := strings.Fields(strings.TrimSpace(name))
	if len(parts) < 2 {
		return strings.TrimSpace(name)
	}
	runes := []rune(parts[1])
	if len(runes) == 0 {
		return parts[0]
	}
	return fmt.Sprintf("%s %c.", parts[0], runes[0])
}

func (s *Service) assignRFIDWeb(e *core.RequestEvent) error {
	if err := requireRFIDManager(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	var body struct {
		UID     string `json:"uid"`
		Replace bool   `json:"replace"`
	}
	if err := e.BindBody(&body); err != nil {
		return e.BadRequestError("La asignación RFID no es válida.", err)
	}
	return s.assignRFID(e, e.Auth.GetString("organization"), e.Request.PathValue("id"), body.UID, body.Replace)
}

func (s *Service) revokeRFIDWeb(e *core.RequestEvent) error {
	if err := requireRFIDManager(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	return s.revokeRFID(e, e.Auth.GetString("organization"), e.Request.PathValue("id"))
}

func (s *Service) assignRFID(e *core.RequestEvent, organization, employeeID, rawUID string, replace bool) error {
	uid, err := normalizeUID(rawUID)
	if err != nil {
		return e.BadRequestError(err.Error(), nil)
	}
	fingerprint, err := uidFingerprint(uid)
	if err != nil {
		return e.InternalServerError("No se pudo proteger el UID.", err)
	}
	ciphertext, err := encryptValue(uid)
	if err != nil {
		return e.InternalServerError("No se pudo proteger el UID.", err)
	}
	err = e.App.RunInTransaction(func(tx core.App) error {
		employee, err := tx.FindRecordById("users", employeeID)
		if err != nil || employee.GetString("organization") != organization || !employee.GetBool("active") {
			return fmt.Errorf("employee_not_found")
		}
		if employee.GetString("rfidUidFingerprint") != "" && !replace {
			return fmt.Errorf("replacement_required")
		}
		if employee.GetString("rfidUidFingerprint") == "" {
			assigned, findErr := tx.FindRecordsByFilter(
				"users",
				"organization = {:organization} && active = true && rfidUidFingerprint != ''",
				"id",
				30,
				0,
				map[string]any{"organization": organization},
			)
			if findErr != nil {
				return findErr
			}
			if len(assigned) >= 30 {
				return fmt.Errorf("rfid_capacity_reached")
			}
		}
		if existing, findErr := tx.FindFirstRecordByFilter("users", "rfidUidFingerprint = {:fingerprint}", map[string]any{"fingerprint": fingerprint}); findErr == nil && existing.Id != employee.Id {
			return fmt.Errorf("uid_in_use")
		}
		employee.Set("rfidUidFingerprint", fingerprint)
		employee.Set("rfidUidCiphertext", ciphertext)
		if err := tx.Save(employee); err != nil {
			return err
		}
		return incrementCacheRevision(tx, organization)
	})
	if err != nil {
		switch err.Error() {
		case "employee_not_found":
			return e.NotFoundError("No se ha encontrado una persona activa de esta empresa.", nil)
		case "replacement_required":
			return apiError(e, http.StatusConflict, "replacement_required", "La persona ya tiene un tag. Confirma la sustitución.")
		case "uid_in_use":
			return apiError(e, http.StatusConflict, "uid_in_use", "Este tag ya pertenece a otra persona.")
		case "rfid_capacity_reached":
			return apiError(e, http.StatusConflict, "rfid_capacity_reached", "La caché RFID admite un máximo de 30 personas activas.")
		default:
			return e.InternalServerError("No se pudo asignar el tag.", err)
		}
	}
	return e.JSON(http.StatusOK, map[string]any{"employee": employeeID, "hasRfidTag": true})
}

func (s *Service) revokeRFID(e *core.RequestEvent, organization, employeeID string) error {
	err := e.App.RunInTransaction(func(tx core.App) error {
		employee, err := tx.FindRecordById("users", employeeID)
		if err != nil || employee.GetString("organization") != organization {
			return fmt.Errorf("employee_not_found")
		}
		employee.Set("rfidUidFingerprint", "")
		employee.Set("rfidUidCiphertext", "")
		if err := tx.Save(employee); err != nil {
			return err
		}
		return incrementCacheRevision(tx, organization)
	})
	if err != nil {
		if err.Error() == "employee_not_found" {
			return e.NotFoundError("No se ha encontrado la persona.", nil)
		}
		return e.InternalServerError("No se pudo revocar el tag.", err)
	}
	return e.JSON(http.StatusOK, map[string]any{"employee": employeeID, "hasRfidTag": false})
}

func incrementCacheRevision(app core.App, organizationID string) error {
	organization, err := app.FindRecordById("organizations", organizationID)
	if err != nil {
		return err
	}
	organization.Set("rfidCacheRevision", organization.GetInt("rfidCacheRevision")+1)
	return app.Save(organization)
}

func (s *Service) listIncidents(e *core.RequestEvent) error {
	if err := requireRFIDManager(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	records, err := e.App.FindRecordsByFilter("terminal_sync_incidents", "organization = {:organization}", "-created", 500, 0, map[string]any{"organization": e.Auth.GetString("organization")})
	if err != nil {
		return e.InternalServerError("No se pudieron cargar las incidencias RFID.", err)
	}
	items := make([]map[string]any, 0, len(records))
	for _, record := range records {
		employeeName, terminalName := "", ""
		if employee, findErr := e.App.FindRecordById("users", record.GetString("employee")); findErr == nil {
			employeeName = employee.GetString("name")
		}
		if terminal, findErr := e.App.FindRecordById("attendance_terminals", record.GetString("terminal")); findErr == nil {
			terminalName = terminal.GetString("name")
		}
		items = append(items, map[string]any{
			"id": record.Id, "organization": record.GetString("organization"), "terminal": record.GetString("terminal"), "employee": record.GetString("employee"),
			"employeeName": employeeName, "terminalName": terminalName, "clientRequestId": record.GetString("clientRequestId"), "command": record.GetString("command"),
			"deviceCapturedAt": record.GetDateTime("deviceCapturedAt").String(), "appliedAt": record.GetDateTime("appliedAt").String(), "reasonCode": record.GetString("reasonCode"),
			"status": record.GetString("status"), "resolvedBy": record.GetString("resolvedBy"), "resolvedAt": record.GetDateTime("resolvedAt").String(), "resolutionNote": record.GetString("resolutionNote"), "created": record.GetDateTime("created").String(),
		})
	}
	return e.JSON(http.StatusOK, map[string]any{"items": items})
}

func (s *Service) resolveIncident(e *core.RequestEvent) error {
	if err := requireRFIDManager(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	var body struct {
		Note string `json:"note"`
	}
	if err := e.BindBody(&body); err != nil || len(strings.TrimSpace(body.Note)) < 8 {
		return e.BadRequestError("Indica una nota de resolución de al menos 8 caracteres.", err)
	}
	record, err := e.App.FindRecordById("terminal_sync_incidents", e.Request.PathValue("id"))
	if err != nil || record.GetString("organization") != e.Auth.GetString("organization") {
		return e.NotFoundError("No se ha encontrado la incidencia.", err)
	}
	if record.GetString("status") == "resolved" {
		return e.JSON(http.StatusOK, map[string]any{"id": record.Id, "status": "resolved"})
	}
	if employeeID := record.GetString("employee"); employeeID != "" {
		corrected, checkErr := incidentDayWasCorrected(e.App, record)
		if checkErr != nil {
			return e.InternalServerError("No se pudo comprobar la corrección de la jornada.", checkErr)
		}
		if !corrected {
			return apiError(e, http.StatusConflict, "correction_required", "Corrige primero la jornada afectada y vuelve después para cerrar la incidencia.")
		}
	}
	record.Set("status", "resolved")
	record.Set("resolvedBy", e.Auth.Id)
	record.Set("resolvedAt", time.Now())
	record.Set("resolutionNote", strings.TrimSpace(body.Note))
	if err := e.App.Save(record); err != nil {
		return e.InternalServerError("No se pudo cerrar la incidencia.", err)
	}
	return e.JSON(http.StatusOK, map[string]any{"id": record.Id, "status": "resolved"})
}

func incidentDayWasCorrected(app core.App, incident *core.Record) (bool, error) {
	organization, err := app.FindRecordById("organizations", incident.GetString("organization"))
	if err != nil {
		return false, err
	}
	location, err := time.LoadLocation(organizationTimezone(organization))
	if err != nil {
		return false, err
	}
	incidentDay := incident.GetDateTime("deviceCapturedAt").Time().In(location).Format("2006-01-02")
	incidentCreatedAt := incident.GetDateTime("created").Time()
	records, err := app.FindRecordsByFilter(
		"work_events",
		"organization = {:organization} && employee = {:employee} && kind = 'correction'",
		"-recordedAt",
		10000,
		0,
		map[string]any{"organization": incident.GetString("organization"), "employee": incident.GetString("employee")},
	)
	if err != nil {
		return false, err
	}
	for _, record := range records {
		if record.GetDateTime("recordedAt").Time().Before(incidentCreatedAt) {
			continue
		}
		if record.GetDateTime("occurredAt").Time().In(location).Format("2006-01-02") == incidentDay {
			return true, nil
		}
	}
	return false, nil
}
