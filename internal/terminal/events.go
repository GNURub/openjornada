package terminal

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

const automaticAdjustmentReason = "Olvido de cierre corregido desde terminal RFID"

type actionRequest struct {
	ClientRequestID  string  `json:"clientRequestId"`
	ScanContext      string  `json:"scanContext"`
	Command          Command `json:"command"`
	DeviceCapturedAt string  `json:"deviceCapturedAt"`
	AppliedAt        string  `json:"appliedAt"`
	ClockSyncedAt    string  `json:"clockSyncedAt"`
	DeviceSequence   int     `json:"deviceSequence"`
}

type queuedAction struct {
	ClientRequestID   string  `json:"clientRequestId"`
	UID               string  `json:"uid"`
	Command           Command `json:"command"`
	DeviceCapturedAt  string  `json:"deviceCapturedAt"`
	AppliedAt         string  `json:"appliedAt"`
	ClockSyncedAt     string  `json:"clockSyncedAt"`
	DeviceSequence    int     `json:"deviceSequence"`
	RebootID          string  `json:"rebootId"`
	PreviousLocalHash string  `json:"previousLocalHash"`
	Signature         string  `json:"signature"`
	originalIndex     int
}

type actionOutcome struct {
	ClientRequestID string         `json:"clientRequestId"`
	Status          string         `json:"status"`
	WorkEventID     string         `json:"workEventId,omitempty"`
	IncidentID      string         `json:"incidentId,omitempty"`
	ErrorCode       string         `json:"errorCode,omitempty"`
	State           map[string]any `json:"state"`
}

func (s *Service) employeeState(app core.App, employeeID string, now time.Time) (WorkState, error) {
	events, err := effectiveEvents(app, employeeID)
	if err != nil {
		return WorkState{}, err
	}
	lastClockOut := -1
	for index, event := range events {
		if event.Kind == CommandClockOut {
			lastClockOut = index
		}
	}
	if lastClockOut >= 0 {
		events = events[lastClockOut+1:]
	}
	return terminalState(events, now), nil
}

func effectiveEvents(app core.App, employeeID string) ([]Event, error) {
	records, err := app.FindRecordsByFilter("work_events", "employee = {:employee}", "occurredAt", 10000, 0, map[string]any{"employee": employeeID})
	if err != nil {
		return nil, err
	}
	type stored struct {
		id    string
		event Event
	}
	events := map[string]stored{}
	corrections := make([]*core.Record, 0)
	for _, record := range records {
		if record.GetString("kind") == "correction" {
			corrections = append(corrections, record)
			continue
		}
		events[record.Id] = stored{id: record.Id, event: Event{Kind: Command(record.GetString("kind")), OccurredAt: record.GetDateTime("occurredAt").Time()}}
	}
	for _, correction := range corrections {
		target := correction.GetString("corrects")
		if _, found := events[target]; !found {
			continue
		}
		if correction.GetBool("voidsTarget") {
			delete(events, target)
			continue
		}
		kind := Command(correction.GetString("correctedKind"))
		if validCommand(kind) {
			events[target] = stored{id: target, event: Event{Kind: kind, OccurredAt: correction.GetDateTime("occurredAt").Time()}}
		}
	}
	result := make([]Event, 0, len(events))
	for _, item := range events {
		result = append(result, item.event)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].OccurredAt.Before(result[j].OccurredAt) })
	return result, nil
}

func (s *Service) performAction(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	var request actionRequest
	if err := e.BindBody(&request); err != nil {
		return e.BadRequestError("La acción del terminal no es válida.", err)
	}
	employeeID, fingerprint, err := parseScanContext(principal.SigningKey, request.ScanContext, principal.Terminal.Id)
	if err != nil {
		return apiError(e, http.StatusUnauthorized, "scan_context_expired", "Vuelve a acercar el tag.")
	}
	employee, err := e.App.FindRecordById("users", employeeID)
	if err != nil || !employee.GetBool("active") || employee.GetString("organization") != principal.Organization.Id || employee.GetString("rfidUidFingerprint") != fingerprint {
		return apiError(e, http.StatusNotFound, "unknown_tag", "El tag ya no está asignado.")
	}
	outcome, err := s.recordTerminalAction(e.App, principal, employee, request, false)
	if err != nil {
		if strings.Contains(err.Error(), "state_conflict") {
			state, _ := s.employeeState(e.App, employee.Id, time.Now())
			return e.JSON(http.StatusConflict, map[string]any{"status": http.StatusConflict, "code": "state_conflict", "message": "El estado de la jornada ha cambiado.", "state": stateResponse(state)})
		}
		return e.BadRequestError(err.Error(), nil)
	}
	return e.JSON(http.StatusOK, outcome)
}

func (s *Service) recordTerminalAction(app core.App, principal *terminalPrincipal, employee *core.Record, request actionRequest, offline bool) (actionOutcome, error) {
	if !validCommand(request.Command) || request.ClientRequestID == "" || len(request.ClientRequestID) > 64 {
		return actionOutcome{}, fmt.Errorf("la acción o su identificador no son válidos")
	}
	if receipt, err := app.FindFirstRecordByFilter("terminal_action_receipts", "terminal = {:terminal} && clientRequestId = {:request}", map[string]any{"terminal": principal.Terminal.Id, "request": request.ClientRequestID}); err == nil {
		state, _ := s.employeeState(app, employee.Id, time.Now())
		return actionOutcome{ClientRequestID: request.ClientRequestID, Status: "duplicate", WorkEventID: receipt.GetString("workEvent"), IncidentID: receipt.GetString("incident"), State: stateResponse(state)}, nil
	}
	capturedAt, err := time.Parse(time.RFC3339Nano, request.DeviceCapturedAt)
	if err != nil {
		return actionOutcome{}, fmt.Errorf("la hora capturada no es válida")
	}
	clockSyncedAt, err := time.Parse(time.RFC3339Nano, request.ClockSyncedAt)
	if err != nil || clockSyncedAt.After(capturedAt) || capturedAt.Sub(clockSyncedAt) > maxOfflineDuration {
		return actionOutcome{}, fmt.Errorf("clock_untrusted")
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if capturedAt.After(now.Add(5 * time.Minute)) {
		return actionOutcome{}, fmt.Errorf("clock_untrusted")
	}
	var outcome actionOutcome
	err = app.RunInTransaction(func(tx core.App) error {
		if receipt, findErr := tx.FindFirstRecordByFilter("terminal_action_receipts", "terminal = {:terminal} && clientRequestId = {:request}", map[string]any{"terminal": principal.Terminal.Id, "request": request.ClientRequestID}); findErr == nil {
			state, _ := s.employeeState(tx, employee.Id, now)
			outcome = actionOutcome{ClientRequestID: request.ClientRequestID, Status: "duplicate", WorkEventID: receipt.GetString("workEvent"), IncidentID: receipt.GetString("incident"), State: stateResponse(state)}
			return nil
		}
		state, err := s.employeeState(tx, employee.Id, now)
		if err != nil {
			return err
		}
		allowed := false
		for _, command := range state.AllowedActions {
			if command == request.Command {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("state_conflict")
		}
		effectiveAt := now
		if offline {
			effectiveAt = capturedAt
		}
		adjustmentSeconds := int64(0)
		adjustmentReason := ""
		if request.AppliedAt != "" {
			if request.Command != CommandBreakEnd && request.Command != CommandClockOut {
				return fmt.Errorf("solo se puede ajustar un cierre")
			}
			appliedAt, parseErr := time.Parse(time.RFC3339Nano, request.AppliedAt)
			if parseErr != nil || appliedAt.After(capturedAt) {
				return fmt.Errorf("la hora aplicada no es válida")
			}
			if state.Since != "" {
				latestAt, _ := time.Parse(time.RFC3339Nano, state.Since)
				if appliedAt.Before(latestAt) {
					return fmt.Errorf("la hora aplicada es anterior al último fichaje")
				}
			}
			effectiveAt = appliedAt
			adjustmentSeconds = int64(capturedAt.Sub(appliedAt) / time.Second)
			if adjustmentSeconds >= 60 {
				adjustmentReason = automaticAdjustmentReason
			}
		}
		latestAt, latestErr := latestEffectiveEventAt(tx, employee.Id)
		if latestErr != nil {
			return latestErr
		}
		if !latestAt.IsZero() && effectiveAt.Before(latestAt) {
			return fmt.Errorf("state_conflict")
		}
		effectiveAt = effectiveAt.UTC().Truncate(time.Millisecond)
		capturedAt = capturedAt.UTC().Truncate(time.Millisecond)
		clockSyncedAt = clockSyncedAt.UTC().Truncate(time.Millisecond)
		collection, err := tx.FindCollectionByNameOrId("work_events")
		if err != nil {
			return err
		}
		event := core.NewRecord(collection)
		event.Set("employee", employee.Id)
		event.Set("organization", principal.Organization.Id)
		event.Set("kind", request.Command)
		event.Set("occurredAt", effectiveAt)
		event.Set("recordedAt", now)
		event.Set("deviceCapturedAt", capturedAt)
		event.Set("clockSyncedAt", clockSyncedAt)
		event.Set("deviceSequence", request.DeviceSequence)
		event.Set("queuedOffline", offline)
		event.Set("timezone", organizationTimezone(principal.Organization))
		event.Set("source", "terminal")
		event.Set("terminal", principal.Terminal.Id)
		event.Set("createdBy", employee.Id)
		event.Set("clientRequestId", request.ClientRequestID)
		event.Set("adjustmentSeconds", adjustmentSeconds)
		event.Set("adjustmentReason", adjustmentReason)
		event.Set("note", adjustmentReason)
		event.Set("integrityVersion", "v3")
		previousHash, err := integrityTipHash(tx, employee.Id)
		if err != nil {
			return err
		}
		event.Set("previousHash", previousHash)
		integrityPayload := strings.Join([]string{
			"v3", employee.Id, principal.Organization.Id, string(request.Command), "", "",
			formatIntegrityTime(effectiveAt), formatIntegrityTime(now), strconv.FormatInt(adjustmentSeconds, 10), adjustmentReason, request.ClientRequestID, previousHash,
			principal.Terminal.Id, formatIntegrityTime(capturedAt), formatIntegrityTime(clockSyncedAt), strconv.Itoa(request.DeviceSequence), strconv.FormatBool(offline),
		}, "|")
		sum := sha256.Sum256([]byte(integrityPayload))
		event.Set("integrityHash", hex.EncodeToString(sum[:]))
		if err := tx.Save(event); err != nil {
			return err
		}
		if err := createWorkEventAudit(tx, event); err != nil {
			return err
		}
		receiptCollection, err := tx.FindCollectionByNameOrId("terminal_action_receipts")
		if err != nil {
			return err
		}
		receipt := core.NewRecord(receiptCollection)
		receipt.Set("organization", principal.Organization.Id)
		receipt.Set("terminal", principal.Terminal.Id)
		receipt.Set("clientRequestId", request.ClientRequestID)
		receipt.Set("status", "accepted")
		receipt.Set("workEvent", event.Id)
		if err := tx.Save(receipt); err != nil {
			return err
		}
		updatedState, err := s.employeeState(tx, employee.Id, now)
		if err != nil {
			return err
		}
		outcome = actionOutcome{ClientRequestID: request.ClientRequestID, Status: "accepted", WorkEventID: event.Id, State: stateResponse(updatedState)}
		return nil
	})
	return outcome, err
}

func latestEffectiveEventAt(app core.App, employeeID string) (time.Time, error) {
	events, err := effectiveEvents(app, employeeID)
	if err != nil || len(events) == 0 {
		return time.Time{}, err
	}
	return events[len(events)-1].OccurredAt, nil
}

func formatIntegrityTime(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}

func integrityTipHash(app core.App, employeeID string) (string, error) {
	records, err := app.FindRecordsByFilter("work_events", "employee = {:employee}", "-created", 10000, 0, map[string]any{"employee": employeeID})
	if err != nil {
		return "", err
	}
	referenced := map[string]bool{}
	for _, record := range records {
		if previous := record.GetString("previousHash"); previous != "" {
			referenced[previous] = true
		}
	}
	for _, record := range records {
		if hash := record.GetString("integrityHash"); hash != "" && !referenced[hash] {
			return hash, nil
		}
	}
	return "", nil
}

func createWorkEventAudit(app core.App, event *core.Record) error {
	collection, err := app.FindCollectionByNameOrId("audit_logs")
	if err != nil {
		return err
	}
	audit := core.NewRecord(collection)
	audit.Set("organization", event.GetString("organization"))
	audit.Set("actor", event.GetString("createdBy"))
	audit.Set("action", "work_event.created")
	audit.Set("entityType", "work_event")
	audit.Set("entityId", event.Id)
	audit.Set("metadata", map[string]any{
		"kind": event.GetString("kind"), "employee": event.GetString("employee"), "integrityHash": event.GetString("integrityHash"),
		"occurredAt": event.GetDateTime("occurredAt").String(), "recordedAt": event.GetDateTime("recordedAt").String(),
		"adjustmentSeconds": event.GetInt("adjustmentSeconds"), "adjustmentReason": event.GetString("adjustmentReason"), "integrityVersion": event.GetString("integrityVersion"),
		"terminal": event.GetString("terminal"), "deviceCapturedAt": event.GetDateTime("deviceCapturedAt").String(),
		"clockSyncedAt": event.GetDateTime("clockSyncedAt").String(), "deviceSequence": event.GetInt("deviceSequence"),
		"queuedOffline": event.GetBool("queuedOffline"),
	})
	audit.Set("occurredAt", time.Now())
	return app.Save(audit)
}

func canonicalQueuedAction(terminalID string, action queuedAction) string {
	return strings.Join([]string{
		terminalID, action.ClientRequestID, action.UID, string(action.Command), action.DeviceCapturedAt,
		action.AppliedAt, action.ClockSyncedAt, strconv.Itoa(action.DeviceSequence), action.RebootID, action.PreviousLocalHash,
	}, "|")
}

func (s *Service) syncActions(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	var body struct {
		Actions      []queuedAction `json:"actions"`
		PendingCount int            `json:"pendingCount"`
	}
	if err := e.BindBody(&body); err != nil || len(body.Actions) > 500 {
		return e.BadRequestError("El lote offline no es válido.", err)
	}
	for index := range body.Actions {
		action := body.Actions[index]
		body.Actions[index].originalIndex = index
		if !verifySignature(principal.SigningKey, canonicalQueuedAction(principal.Terminal.Id, action), action.Signature) {
			return apiError(e, http.StatusUnauthorized, "invalid_signature", "La firma de la cola offline no es válida.")
		}
	}
	sortQueuedActions(body.Actions)
	for index := 1; index < len(body.Actions); index++ {
		previous, current := body.Actions[index-1], body.Actions[index]
		if current.RebootID == previous.RebootID {
			if current.PreviousLocalHash != previous.Signature || current.DeviceSequence <= previous.DeviceSequence {
				return apiError(e, http.StatusUnauthorized, "invalid_signature", "La cadena de la cola offline no es válida.")
			}
		} else if current.PreviousLocalHash != "" {
			return apiError(e, http.StatusUnauthorized, "invalid_signature", "La cadena no se reinició junto con el terminal.")
		}
	}
	type indexedOutcome struct {
		index   int
		outcome actionOutcome
	}
	indexedResults := make([]indexedOutcome, 0, len(body.Actions))
	for _, queued := range body.Actions {
		employee, _, resolveErr := s.employeeForUID(e.App, principal.Organization.Id, queued.UID)
		request := actionRequest{
			ClientRequestID: queued.ClientRequestID, Command: queued.Command, DeviceCapturedAt: queued.DeviceCapturedAt,
			AppliedAt: queued.AppliedAt, ClockSyncedAt: queued.ClockSyncedAt, DeviceSequence: queued.DeviceSequence,
		}
		if resolveErr != nil {
			indexedResults = append(indexedResults, indexedOutcome{queued.originalIndex, s.createIncident(e.App, principal, nil, request, "uid_revoked")})
			continue
		}
		outcome, recordErr := s.recordTerminalAction(e.App, principal, employee, request, true)
		if recordErr != nil {
			reason := "state_conflict"
			if strings.Contains(recordErr.Error(), "clock_untrusted") {
				reason = "clock_untrusted"
			}
			indexedResults = append(indexedResults, indexedOutcome{queued.originalIndex, s.createIncident(e.App, principal, employee, request, reason)})
			continue
		}
		indexedResults = append(indexedResults, indexedOutcome{queued.originalIndex, outcome})
	}
	sort.Slice(indexedResults, func(i, j int) bool { return indexedResults[i].index < indexedResults[j].index })
	results := make([]actionOutcome, 0, len(indexedResults))
	for _, result := range indexedResults {
		results = append(results, result.outcome)
	}
	principal.Terminal.Set("lastSeenAt", time.Now())
	principal.Terminal.Set("lastPendingCount", maxInt(0, body.PendingCount-len(results)))
	_ = e.App.Save(principal.Terminal)
	return e.JSON(http.StatusOK, map[string]any{"items": results, "serverTime": time.Now().UTC().Format(time.RFC3339Nano)})
}

func (s *Service) createIncident(app core.App, principal *terminalPrincipal, employee *core.Record, request actionRequest, reason string) actionOutcome {
	if receipt, err := app.FindFirstRecordByFilter("terminal_action_receipts", "terminal = {:terminal} && clientRequestId = {:request}", map[string]any{"terminal": principal.Terminal.Id, "request": request.ClientRequestID}); err == nil {
		state := WorkState{Kind: StateIdle}
		if employee != nil {
			state, _ = s.employeeState(app, employee.Id, time.Now())
		}
		return actionOutcome{ClientRequestID: request.ClientRequestID, Status: "duplicate", IncidentID: receipt.GetString("incident"), State: stateResponse(state)}
	}
	var outcome actionOutcome
	err := app.RunInTransaction(func(tx core.App) error {
		incidentCollection, err := tx.FindCollectionByNameOrId("terminal_sync_incidents")
		if err != nil {
			return err
		}
		incident := core.NewRecord(incidentCollection)
		incident.Set("organization", principal.Organization.Id)
		incident.Set("terminal", principal.Terminal.Id)
		if employee != nil {
			incident.Set("employee", employee.Id)
		}
		incident.Set("clientRequestId", request.ClientRequestID)
		incident.Set("command", request.Command)
		incident.Set("deviceCapturedAt", request.DeviceCapturedAt)
		incident.Set("appliedAt", request.AppliedAt)
		incident.Set("evidence", map[string]any{"clockSyncedAt": request.ClockSyncedAt, "deviceSequence": request.DeviceSequence})
		incident.Set("reasonCode", reason)
		incident.Set("status", "pending")
		if err := tx.Save(incident); err != nil {
			return err
		}
		receiptCollection, err := tx.FindCollectionByNameOrId("terminal_action_receipts")
		if err != nil {
			return err
		}
		receipt := core.NewRecord(receiptCollection)
		receipt.Set("organization", principal.Organization.Id)
		receipt.Set("terminal", principal.Terminal.Id)
		receipt.Set("clientRequestId", request.ClientRequestID)
		receipt.Set("status", "incident")
		receipt.Set("incident", incident.Id)
		if err := tx.Save(receipt); err != nil {
			return err
		}
		if err := notifyIncidentReviewers(tx, principal.Organization.Id); err != nil {
			return err
		}
		state := WorkState{Kind: StateIdle}
		if employee != nil {
			state, _ = s.employeeState(tx, employee.Id, time.Now())
		}
		outcome = actionOutcome{ClientRequestID: request.ClientRequestID, Status: "incident", IncidentID: incident.Id, ErrorCode: reason, State: stateResponse(state)}
		return nil
	})
	if err != nil {
		return actionOutcome{ClientRequestID: request.ClientRequestID, Status: "rejected", ErrorCode: "incident_failed", State: stateResponse(WorkState{Kind: StateIdle})}
	}
	return outcome
}

func notifyIncidentReviewers(app core.App, organizationID string) error {
	recipients, err := app.FindRecordsByFilter(
		"users",
		"organization = {:organization} && active = true && (role = 'admin' || role = 'manager')",
		"id",
		500,
		0,
		map[string]any{"organization": organizationID},
	)
	if err != nil {
		return err
	}
	collection, err := app.FindCollectionByNameOrId("notifications")
	if err != nil {
		return err
	}
	for _, recipient := range recipients {
		notification := core.NewRecord(collection)
		notification.Set("organization", organizationID)
		notification.Set("recipient", recipient.Id)
		notification.Set("title", "Incidencia RFID pendiente")
		notification.Set("message", "Hay un fichaje offline que necesita revisión antes del cierre mensual.")
		notification.Set("kind", "warning")
		notification.Set("link", "/registros")
		notification.Set("read", false)
		if err := app.Save(notification); err != nil {
			return err
		}
	}
	return nil
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
