package terminal

import (
	"errors"
	"math"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

const (
	maxTerminalClientVersionBytes = 40
	maxTerminalCacheRevision      = math.MaxUint32
	maxTerminalUptimeSeconds      = uint64(4294967295)
	maxTerminalIPLength           = 45
	maxPingChallengeLength        = 128
	maxNTPFutureSkew              = 5 * time.Minute
)

type heartbeatRequest struct {
	ProtocolVersion         int    `json:"protocolVersion"`
	ClientVersion           string `json:"clientVersion"`
	CacheRevision           int    `json:"cacheRevision"`
	PendingCount            int    `json:"pendingCount"`
	WifiRSSIDbm             int    `json:"wifiRssiDbm"`
	UptimeSeconds           uint64 `json:"uptimeSeconds"`
	ClockStatus             string `json:"clockStatus"`
	LastNtpSyncAt           string `json:"lastNtpSyncAt"`
	FirmwareUpdateStatus    string `json:"firmwareUpdateStatus"`
	FirmwareTargetVersion   string `json:"firmwareTargetVersion"`
	LastFirmwareCheckAt     string `json:"lastFirmwareCheckAt"`
	FirmwareUpdateErrorCode string `json:"firmwareUpdateErrorCode"`
}

type pingAckRequest struct {
	PingChallenge string `json:"pingChallenge"`
	LocalIP       string `json:"localIp"`
	WifiRSSIDbm   int    `json:"wifiRssiDbm"`
	UptimeSeconds uint64 `json:"uptimeSeconds"`
}

func (request heartbeatRequest) validate(now time.Time) error {
	clientVersion := strings.TrimSpace(request.ClientVersion)
	if request.ProtocolVersion != protocolVersion {
		return errors.New("unsupported protocol version")
	}
	if clientVersion == "" || len([]byte(clientVersion)) > maxTerminalClientVersionBytes {
		return errors.New("invalid client version")
	}
	if request.CacheRevision < 0 || request.CacheRevision > maxTerminalCacheRevision {
		return errors.New("invalid cache revision")
	}
	if request.PendingCount < 0 || request.PendingCount > maxQueuedActions {
		return errors.New("invalid pending count")
	}
	if request.WifiRSSIDbm < -127 || request.WifiRSSIDbm > 0 {
		return errors.New("invalid wifi signal")
	}
	if request.UptimeSeconds > maxTerminalUptimeSeconds {
		return errors.New("invalid uptime")
	}

	lastNTP := strings.TrimSpace(request.LastNtpSyncAt)
	switch request.ClockStatus {
	case "synced", "stale":
		if lastNTP == "" {
			return errors.New("missing NTP evidence")
		}
		syncedAt, err := time.Parse(time.RFC3339Nano, lastNTP)
		if err != nil || syncedAt.After(now.Add(maxNTPFutureSkew)) {
			return errors.New("invalid NTP evidence")
		}
	case "unsynced":
		if lastNTP != "" {
			return errors.New("unexpected NTP evidence")
		}
	default:
		return errors.New("invalid clock status")
	}
	validFirmwareStatuses := map[string]bool{
		"": true, "idle": true, "checking": true, "available": true,
		"downloading": true, "verifying": true, "pending_reboot": true,
		"updated": true, "failed": true, "rolled_back": true, "blocked": true,
	}
	validFirmwareErrors := map[string]bool{
		"": true, "manifest_fetch": true, "manifest_signature": true,
		"manifest_invalid": true, "incompatible": true, "download": true,
		"size": true, "hash": true, "flash": true,
		"boot_validation": true, "rollback": true,
	}
	if !validFirmwareStatuses[request.FirmwareUpdateStatus] ||
		!validFirmwareErrors[request.FirmwareUpdateErrorCode] ||
		len(request.FirmwareTargetVersion) > 32 ||
		strings.ContainsAny(request.FirmwareTargetVersion, "\r\n\x00") {
		return errors.New("invalid firmware update status")
	}
	if request.LastFirmwareCheckAt != "" {
		checkedAt, err := time.Parse(time.RFC3339Nano, request.LastFirmwareCheckAt)
		if err != nil || checkedAt.After(now.Add(maxNTPFutureSkew)) {
			return errors.New("invalid firmware check time")
		}
	}
	return nil
}

func (request pingAckRequest) validate() (string, error) {
	if request.PingChallenge == "" || len(request.PingChallenge) > maxPingChallengeLength {
		return "", errors.New("invalid ping challenge")
	}
	if request.WifiRSSIDbm < -127 || request.WifiRSSIDbm > 0 {
		return "", errors.New("invalid wifi signal")
	}
	if request.UptimeSeconds > maxTerminalUptimeSeconds {
		return "", errors.New("invalid uptime")
	}
	return canonicalIP(request.LocalIP)
}

func canonicalIP(raw string) (string, error) {
	if raw == "" || len(raw) > maxTerminalIPLength {
		return "", errors.New("invalid IP address")
	}
	parsed := net.ParseIP(raw)
	if parsed == nil {
		return "", errors.New("invalid IP address")
	}
	return parsed.String(), nil
}

func observedPingPublicIP(e *core.RequestEvent) (string, error) {
	return canonicalIP(e.RealIP())
}

func applyHeartbeat(record *core.Record, request heartbeatRequest, serverNow time.Time) {
	record.Set("protocolVersion", request.ProtocolVersion)
	record.Set("clientVersion", strings.TrimSpace(request.ClientVersion))
	record.Set("cacheRevision", request.CacheRevision)
	record.Set("lastPendingCount", request.PendingCount)
	record.Set("lastSeenAt", serverNow)
	record.Set("lastHeartbeatAt", serverNow)
	record.Set("lastClockStatus", request.ClockStatus)
	record.Set("lastNtpSyncAt", strings.TrimSpace(request.LastNtpSyncAt))
	record.Set("lastWifiRssiDbm", request.WifiRSSIDbm)
	record.Set("lastUptimeSeconds", request.UptimeSeconds)
	record.Set("firmwareUpdateStatus", request.FirmwareUpdateStatus)
	record.Set("firmwareTargetVersion", strings.TrimSpace(request.FirmwareTargetVersion))
	record.Set("lastFirmwareCheckAt", strings.TrimSpace(request.LastFirmwareCheckAt))
	record.Set("firmwareUpdateErrorCode", request.FirmwareUpdateErrorCode)
}

func persistHeartbeat(app core.App, terminalID string, request heartbeatRequest, serverNow time.Time) error {
	return app.RunInTransaction(func(tx core.App) error {
		record, err := tx.FindRecordById("attendance_terminals", terminalID)
		if err != nil {
			return err
		}
		if record.GetString("revokedAt") != "" {
			return errTerminalRevoked
		}
		applyHeartbeat(record, request, serverNow)
		record.IgnoreUnchangedFields(true)
		return tx.Save(record)
	})
}

func (s *Service) heartbeat(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	var body heartbeatRequest
	if err := e.BindBody(&body); err != nil {
		return apiError(e, http.StatusBadRequest, "terminal_telemetry_invalid", "La telemetría del terminal no es válida.")
	}
	now := time.Now()
	if err := body.validate(now); err != nil {
		return apiError(e, http.StatusBadRequest, "terminal_telemetry_invalid", "La telemetría del terminal no es válida.")
	}
	if err := persistHeartbeat(e.App, principal.Terminal.Id, body, now); errors.Is(err, errTerminalRevoked) {
		return apiError(e, http.StatusUnauthorized, "authentication_required", "La credencial del terminal no es válida.")
	} else if err != nil {
		return e.InternalServerError("No se pudo actualizar la telemetría del terminal.", err)
	}
	challengeAt := time.Now()
	challenge, _ := s.pings.challenge(principal.Terminal.Id, challengeAt)
	return e.JSON(http.StatusOK, map[string]any{
		"serverTime":    challengeAt.UTC().Format(time.RFC3339Nano),
		"pingChallenge": challenge,
	})
}

func (s *Service) ackPing(e *core.RequestEvent) error {
	principal, err := s.terminalOrUnauthorized(e)
	if err != nil {
		return err
	}
	var body pingAckRequest
	if err := e.BindBody(&body); err != nil {
		return apiError(e, http.StatusBadRequest, "terminal_ping_ack_invalid", "El acuse del terminal no es válido.")
	}
	localIP, err := body.validate()
	if err != nil {
		return apiError(e, http.StatusBadRequest, "terminal_ping_ack_invalid", "El acuse del terminal no es válido.")
	}
	publicIP, err := observedPingPublicIP(e)
	if err != nil {
		return e.InternalServerError("No se pudo resolver la conexión del terminal.", nil)
	}
	_, err = s.pings.acknowledge(principal.Terminal.Id, body.PingChallenge, pingDeviceResult{
		LocalIP:       localIP,
		PublicIP:      publicIP,
		WifiRSSIDbm:   body.WifiRSSIDbm,
		UptimeSeconds: body.UptimeSeconds,
	}, time.Now())
	if errors.Is(err, errPingExpired) {
		return apiError(e, http.StatusGone, "terminal_ping_expired", "La comprobación del terminal ha caducado.")
	}
	if err != nil {
		return apiError(e, http.StatusConflict, "terminal_ping_not_pending", "No hay una comprobación pendiente para este terminal.")
	}
	return e.JSON(http.StatusOK, map[string]any{"acknowledged": true})
}
