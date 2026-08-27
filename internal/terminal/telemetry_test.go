package terminal

import (
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func telemetryTerminalRecord(t *testing.T, heartbeat, revoked string) *core.Record {
	t.Helper()
	collection := core.NewBaseCollection("attendance_terminals")
	collection.Fields.Add(
		&core.TextField{Name: "organization"},
		&core.TextField{Name: "createdBy"},
		&core.TextField{Name: "name"},
		&core.TextField{Name: "prefix"},
		&core.TextField{Name: "tokenHash"},
		&core.TextField{Name: "signingMaterial"},
		&core.NumberField{Name: "protocolVersion"},
		&core.TextField{Name: "clientVersion"},
		&core.NumberField{Name: "cacheRevision"},
		&core.DateField{Name: "lastSeenAt"},
		&core.NumberField{Name: "lastPendingCount"},
		&core.DateField{Name: "revokedAt"},
		&core.DateField{Name: "created"},
		&core.DateField{Name: "lastHeartbeatAt"},
		&core.DateField{Name: "lastAttendanceSyncAt"},
		&core.SelectField{Name: "lastClockStatus", MaxSelect: 1, Values: []string{"synced", "stale", "unsynced"}},
		&core.DateField{Name: "lastNtpSyncAt"},
		&core.NumberField{Name: "lastWifiRssiDbm"},
		&core.NumberField{Name: "lastUptimeSeconds"},
	)
	record := core.NewRecord(collection)
	record.Set("organization", "organization-1")
	record.Set("createdBy", "user-1")
	record.Set("name", "Terminal recepción")
	record.Set("prefix", "terminalabcd")
	record.Set("tokenHash", "secret-token-hash")
	record.Set("signingMaterial", "secret-signing-material")
	record.Set("protocolVersion", 1)
	record.Set("clientVersion", "1.2.3")
	record.Set("cacheRevision", 4)
	record.Set("lastSeenAt", "2026-08-27T11:59:50Z")
	record.Set("lastPendingCount", 2)
	record.Set("lastHeartbeatAt", heartbeat)
	record.Set("revokedAt", revoked)
	record.Set("created", "2026-08-01T09:00:00Z")
	return record
}

func TestTerminalConnectionStatus(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name, heartbeat, revoked, want string
	}{
		{"fresh at 44 seconds", now.Add(-44 * time.Second).Format(time.RFC3339Nano), "", "online"},
		{"offline at exact boundary", now.Add(-45 * time.Second).Format(time.RFC3339Nano), "", "offline"},
		{"offline without heartbeat", "", "", "offline"},
		{"revoked overrides fresh heartbeat", now.Add(-time.Second).Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), "revoked"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			record := telemetryTerminalRecord(t, tt.heartbeat, tt.revoked)
			if got := terminalConnectionStatus(record, now); got != tt.want {
				t.Fatalf("terminalConnectionStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestTerminalRecordViewIncludesNonSensitiveTelemetry(t *testing.T) {
	record := telemetryTerminalRecord(t, "2026-08-27T11:59:50Z", "")
	record.Set("lastAttendanceSyncAt", "2026-08-27T11:58:00Z")
	record.Set("lastClockStatus", "synced")
	record.Set("lastNtpSyncAt", "2026-08-27T11:57:00Z")
	record.Set("lastWifiRssiDbm", -61)
	record.Set("lastUptimeSeconds", 7200)
	view := terminalRecordViewAt(record, "", time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC))
	if view.ConnectionStatus != "online" || view.LastWifiRssiDbm == nil || *view.LastWifiRssiDbm != -61 || view.LastUptimeSeconds == nil || *view.LastUptimeSeconds != 7200 {
		t.Fatalf("unexpected telemetry view: %#v", view)
	}
	if view.LastHeartbeatAt == "" || view.LastAttendanceSyncAt == "" || view.LastClockStatus != "synced" || view.LastNtpSyncAt == "" {
		t.Fatalf("missing telemetry timestamps or clock status: %#v", view)
	}
}

func TestTerminalRecordViewNumericTelemetryRequiresHeartbeat(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	withoutHeartbeat := telemetryTerminalRecord(t, "", "")
	withoutHeartbeat.Set("lastWifiRssiDbm", -61)
	withoutHeartbeat.Set("lastUptimeSeconds", 7200)
	view := terminalRecordViewAt(withoutHeartbeat, "", now)
	if view.LastWifiRssiDbm != nil || view.LastUptimeSeconds != nil {
		t.Fatalf("numeric telemetry without heartbeat must be nil: %#v", view)
	}

	withHeartbeat := telemetryTerminalRecord(t, now.Add(-time.Second).Format(time.RFC3339Nano), "")
	withHeartbeat.Set("lastWifiRssiDbm", 0)
	withHeartbeat.Set("lastUptimeSeconds", 0)
	view = terminalRecordViewAt(withHeartbeat, "", now)
	if view.LastWifiRssiDbm == nil || *view.LastWifiRssiDbm != 0 || view.LastUptimeSeconds == nil || *view.LastUptimeSeconds != 0 {
		t.Fatalf("zero numeric telemetry after heartbeat must be preserved: %#v", view)
	}
}
