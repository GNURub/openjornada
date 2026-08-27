package terminal

import (
	"errors"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/router"
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

func TestHeartbeatRequestValidation(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	valid := heartbeatRequest{ProtocolVersion: 1, ClientVersion: "m5stack-1.1.0", CacheRevision: 2, PendingCount: 0, WifiRSSIDbm: -61, UptimeSeconds: 90, ClockStatus: "synced", LastNtpSyncAt: "2026-08-27T11:59:00Z"}
	if err := valid.validate(now); err != nil {
		t.Fatal(err)
	}
	maximumCacheRevision := valid
	maximumCacheRevision.CacheRevision = int(maxTerminalCacheRevision)
	if err := maximumCacheRevision.validate(now); err != nil {
		t.Fatalf("maximum cache revision rejected: %v", err)
	}
	for name, mutate := range map[string]func(*heartbeatRequest){
		"protocol":       func(v *heartbeatRequest) { v.ProtocolVersion = 2 },
		"client empty":   func(v *heartbeatRequest) { v.ClientVersion = " " },
		"client long":    func(v *heartbeatRequest) { v.ClientVersion = "12345678901234567890123456789012345678901" },
		"cache negative": func(v *heartbeatRequest) { v.CacheRevision = -1 },
		"cache too high": func(v *heartbeatRequest) { v.CacheRevision = int(maxTerminalCacheRevision) + 1 },
		"pending":        func(v *heartbeatRequest) { v.PendingCount = 10001 },
		"rssi":           func(v *heartbeatRequest) { v.WifiRSSIDbm = 1 },
		"uptime":         func(v *heartbeatRequest) { v.UptimeSeconds = 4294967296 },
		"clock":          func(v *heartbeatRequest) { v.ClockStatus = "invented" },
		"ntp missing":    func(v *heartbeatRequest) { v.LastNtpSyncAt = "" },
		"ntp future":     func(v *heartbeatRequest) { v.LastNtpSyncAt = now.Add(6 * time.Minute).Format(time.RFC3339) },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := valid
			mutate(&candidate)
			if candidate.validate(now) == nil {
				t.Fatal("expected validation error")
			}
		})
	}

	unsynced := valid
	unsynced.ClockStatus = "unsynced"
	unsynced.LastNtpSyncAt = ""
	if err := unsynced.validate(now); err != nil {
		t.Fatalf("valid unsynced request: %v", err)
	}
	unsynced.LastNtpSyncAt = valid.LastNtpSyncAt
	if err := unsynced.validate(now); err == nil {
		t.Fatal("unsynced request must not contain NTP evidence")
	}
}

func TestObservedPingPublicIP(t *testing.T) {
	for _, test := range []struct {
		name, remoteAddr, headerName, headerValue, want string
		trustedHeaders                                  []string
		useLeftmost                                     bool
	}{
		{name: "unconfigured headers ignore spoof", remoteAddr: "203.0.113.9:43110", headerName: "X-Forwarded-For", headerValue: "198.51.100.44", want: "203.0.113.9"},
		{name: "configured header uses leftmost", remoteAddr: "10.0.0.5:43110", trustedHeaders: []string{"X-Forwarded-For"}, useLeftmost: true, headerName: "X-Forwarded-For", headerValue: "198.51.100.41, 198.51.100.42", want: "198.51.100.41"},
		{name: "configured header uses rightmost", remoteAddr: "10.0.0.5:43110", trustedHeaders: []string{"X-Forwarded-For"}, headerName: "X-Forwarded-For", headerValue: "198.51.100.41, 198.51.100.42", want: "198.51.100.42"},
		{name: "unconfigured header name is ignored", remoteAddr: "192.168.1.20:43110", trustedHeaders: []string{"CF-Connecting-IP"}, headerName: "X-Forwarded-For", headerValue: "198.51.100.44", want: "192.168.1.20"},
		{name: "invalid trusted values fall back", remoteAddr: "192.168.1.20:43110", trustedHeaders: []string{"X-Forwarded-For"}, headerName: "X-Forwarded-For", headerValue: "invalid, also-invalid", want: "192.168.1.20"},
		{name: "forwarded IPv6 is canonicalized", remoteAddr: "127.0.0.1:43110", trustedHeaders: []string{"X-Forwarded-For"}, headerName: "X-Forwarded-For", headerValue: "2001:0db8:0000:0000:0000:0000:0000:0001", want: "2001:db8::1"},
		{name: "direct IPv6 is canonicalized", remoteAddr: "[2001:0db8:0000:0000:0000:0000:0000:0002]:43110", want: "2001:db8::2"},
	} {
		t.Run(test.name, func(t *testing.T) {
			app, err := tests.NewTestApp()
			if err != nil {
				t.Fatal(err)
			}
			defer app.Cleanup()
			app.Settings().TrustedProxy.Headers = test.trustedHeaders
			app.Settings().TrustedProxy.UseLeftmostIP = test.useLeftmost

			request := httptest.NewRequest("POST", "http://127.0.0.1/api/openjornada/terminal/v1/ping-ack", nil)
			request.RemoteAddr = test.remoteAddr
			if test.headerName != "" {
				request.Header.Set(test.headerName, test.headerValue)
			}
			event := &core.RequestEvent{App: app, Event: router.Event{Request: request}}
			got, err := observedPingPublicIP(event)
			if err != nil || got != test.want {
				t.Fatalf("observedPingPublicIP() = (%q, %v), want %q", got, err, test.want)
			}
		})
	}
}

func TestCanonicalIP(t *testing.T) {
	for _, test := range []struct {
		name, input, want string
		valid             bool
	}{
		{name: "IPv4", input: "192.168.001.44", valid: false},
		{name: "canonical IPv4", input: "192.168.1.44", want: "192.168.1.44", valid: true},
		{name: "IPv6", input: "2001:0db8:0000:0000:0000:0000:0000:0001", want: "2001:db8::1", valid: true},
		{name: "invalid", input: "not-an-ip", valid: false},
		{name: "oversized", input: "2001:db8::1                                      ", valid: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := canonicalIP(test.input)
			if test.valid && (err != nil || got != test.want) {
				t.Fatalf("canonicalIP() = (%q, %v), want %q", got, err, test.want)
			}
			if !test.valid && err == nil {
				t.Fatalf("canonicalIP() = %q, expected error", got)
			}
		})
	}
}

func TestApplyHeartbeatWritesOnlyApprovedFields(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	record := telemetryTerminalRecord(t, "", "")
	request := heartbeatRequest{ProtocolVersion: 1, ClientVersion: "m5stack-1.1.0", CacheRevision: 2, PendingCount: 3, WifiRSSIDbm: -61, UptimeSeconds: 90, ClockStatus: "synced", LastNtpSyncAt: "2026-08-27T11:59:00Z"}
	applyHeartbeat(record, request, now)

	want := map[string]any{
		"protocolVersion": 1, "clientVersion": "m5stack-1.1.0", "cacheRevision": 2, "lastPendingCount": 3,
		"lastSeenAt": now, "lastHeartbeatAt": now, "lastClockStatus": "synced", "lastNtpSyncAt": time.Date(2026, 8, 27, 11, 59, 0, 0, time.UTC),
		"lastWifiRssiDbm": -61, "lastUptimeSeconds": 90,
	}
	for field, expected := range want {
		var got any
		switch expected.(type) {
		case time.Time:
			got = record.GetDateTime(field).Time()
		case int:
			got = record.GetInt(field)
		default:
			got = record.GetString(field)
		}
		if !reflect.DeepEqual(got, expected) {
			t.Errorf("field %s = %#v, want %#v", field, got, expected)
		}
	}
	for _, forbidden := range []string{"ip", "localIp", "publicIp"} {
		if record.Collection().Fields.GetByName(forbidden) != nil {
			t.Fatalf("heartbeat record must not define %q", forbidden)
		}
	}
}

func TestPersistHeartbeatRejectsRevocationAfterAuthentication(t *testing.T) {
	app, terminal := persistedTelemetryTerminal(t)
	defer app.Cleanup()

	// This record represents the principal loaded while authentication still
	// considered the terminal active.
	authenticatedBeforeRevocation, err := app.FindRecordById("attendance_terminals", terminal.Id)
	if err != nil {
		t.Fatal(err)
	}
	revoked, err := app.FindRecordById("attendance_terminals", terminal.Id)
	if err != nil {
		t.Fatal(err)
	}
	revokedAt := time.Date(2026, 8, 27, 11, 59, 59, 0, time.UTC)
	revoked.Set("revokedAt", revokedAt)
	if err := app.Save(revoked); err != nil {
		t.Fatal(err)
	}

	request := heartbeatRequest{ProtocolVersion: 1, ClientVersion: "m5stack-1.1.0", CacheRevision: 2, PendingCount: 3, WifiRSSIDbm: -61, UptimeSeconds: 90, ClockStatus: "synced", LastNtpSyncAt: "2026-08-27T11:59:00Z"}
	if err := persistHeartbeat(app, authenticatedBeforeRevocation.Id, request, revokedAt.Add(time.Second)); !errors.Is(err, errTerminalRevoked) {
		t.Fatalf("persistHeartbeat() error = %v, want terminal revoked", err)
	}
	stored, err := app.FindRecordById("attendance_terminals", terminal.Id)
	if err != nil {
		t.Fatal(err)
	}
	if stored.GetDateTime("revokedAt").Time() != revokedAt {
		t.Fatalf("revocation was overwritten: %s", stored.GetDateTime("revokedAt"))
	}
	if !stored.GetDateTime("lastHeartbeatAt").Time().IsZero() {
		t.Fatalf("revoked terminal accepted heartbeat: %s", stored.GetDateTime("lastHeartbeatAt"))
	}
}

func TestPersistHeartbeatUpdatesActiveTerminal(t *testing.T) {
	app, terminal := persistedTelemetryTerminal(t)
	defer app.Cleanup()
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	request := heartbeatRequest{ProtocolVersion: 1, ClientVersion: " m5stack-1.1.0 ", CacheRevision: 2, PendingCount: 3, WifiRSSIDbm: -61, UptimeSeconds: 90, ClockStatus: "synced", LastNtpSyncAt: "2026-08-27T11:59:00Z"}
	if err := persistHeartbeat(app, terminal.Id, request, now); err != nil {
		t.Fatal(err)
	}
	stored, err := app.FindRecordById("attendance_terminals", terminal.Id)
	if err != nil {
		t.Fatal(err)
	}
	if stored.GetDateTime("lastHeartbeatAt").Time() != now || stored.GetString("clientVersion") != "m5stack-1.1.0" || stored.GetInt("lastWifiRssiDbm") != -61 {
		t.Fatalf("unexpected persisted heartbeat: %#v", terminalRecordViewAt(stored, "", now))
	}
}

func persistedTelemetryTerminal(t *testing.T) (*tests.TestApp, *core.Record) {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	collection := core.NewBaseCollection("attendance_terminals")
	collection.Fields.Add(
		&core.TextField{Name: "organization", Required: true},
		&core.TextField{Name: "name"},
		&core.NumberField{Name: "protocolVersion"},
		&core.TextField{Name: "clientVersion"},
		&core.NumberField{Name: "cacheRevision"},
		&core.NumberField{Name: "lastPendingCount"},
		&core.DateField{Name: "lastSeenAt"},
		&core.DateField{Name: "lastHeartbeatAt"},
		&core.SelectField{Name: "lastClockStatus", MaxSelect: 1, Values: []string{"synced", "stale", "unsynced"}},
		&core.DateField{Name: "lastNtpSyncAt"},
		&core.NumberField{Name: "lastWifiRssiDbm"},
		&core.NumberField{Name: "lastUptimeSeconds"},
		&core.DateField{Name: "revokedAt"},
	)
	if err := app.Save(collection); err != nil {
		app.Cleanup()
		t.Fatal(err)
	}
	record := core.NewRecord(collection)
	record.Set("organization", "organization-a")
	record.Set("name", "Terminal A")
	if err := app.Save(record); err != nil {
		app.Cleanup()
		t.Fatal(err)
	}
	return app, record
}

func TestFindTerminalForOrganizationHidesForeignTerminal(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()
	collection := core.NewBaseCollection("attendance_terminals")
	collection.Fields.Add(&core.TextField{Name: "organization", Required: true})
	if err := app.Save(collection); err != nil {
		t.Fatal(err)
	}
	save := func(organization string) *core.Record {
		record := core.NewRecord(collection)
		record.Set("organization", organization)
		if err := app.Save(record); err != nil {
			t.Fatal(err)
		}
		return record
	}
	terminalA := save("organization-a")
	terminalB := save("organization-b")
	if got, err := findTerminalForOrganization(app, terminalA.Id, "organization-a"); err != nil || got.Id != terminalA.Id {
		t.Fatalf("own terminal lookup = (%v, %v)", got, err)
	}
	if got, err := findTerminalForOrganization(app, terminalB.Id, "organization-a"); err == nil || got != nil {
		t.Fatalf("foreign terminal must be hidden, got (%v, %v)", got, err)
	}
}
