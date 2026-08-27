package terminal

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

type terminalAPIFixture struct {
	app           *tests.TestApp
	service       *Service
	handler       http.Handler
	organization  *core.Record
	terminal      *core.Record
	foreign       *core.Record
	terminalToken string
	userTokens    map[string]string
}

func newTerminalAPIFixture(t *testing.T) *terminalAPIFixture {
	t.Helper()
	t.Setenv("PB_ENCRYPTION_KEY", "terminal-api-route-tests")
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}

	organizations := core.NewBaseCollection("organizations")
	organizations.Fields.Add(
		&core.TextField{Name: "name"},
		&core.TextField{Name: "timezone"},
		&core.NumberField{Name: "rfidCacheRevision"},
	)
	if err := app.Save(organizations); err != nil {
		app.Cleanup()
		t.Fatal(err)
	}
	organization := core.NewRecord(organizations)
	organization.Set("name", "Empresa A")
	organization.Set("timezone", "Europe/Madrid")
	if err := app.Save(organization); err != nil {
		app.Cleanup()
		t.Fatal(err)
	}
	foreignOrganization := core.NewRecord(organizations)
	foreignOrganization.Set("name", "Empresa B")
	if err := app.Save(foreignOrganization); err != nil {
		app.Cleanup()
		t.Fatal(err)
	}

	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		app.Cleanup()
		t.Fatal(err)
	}
	users.Fields.Add(
		&core.BoolField{Name: "active"},
		&core.SelectField{Name: "role", MaxSelect: 1, Values: []string{"admin", "manager", "employee"}},
		&core.TextField{Name: "organization"},
	)
	if err := app.Save(users); err != nil {
		app.Cleanup()
		t.Fatal(err)
	}
	userTokens := make(map[string]string)
	for _, role := range []string{"admin", "manager", "employee"} {
		user := core.NewRecord(users)
		user.Set("email", fmt.Sprintf("%s@example.test", role))
		user.SetPassword("test-password-123")
		user.Set("active", true)
		user.Set("role", role)
		user.Set("organization", organization.Id)
		if err := app.Save(user); err != nil {
			app.Cleanup()
			t.Fatal(err)
		}
		token, err := user.NewAuthToken()
		if err != nil {
			app.Cleanup()
			t.Fatal(err)
		}
		userTokens[role] = token
	}

	terminals := core.NewBaseCollection("attendance_terminals")
	terminals.Fields.Add(
		&core.TextField{Name: "organization", Required: true},
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
		&core.DateField{Name: "lastHeartbeatAt"},
		&core.DateField{Name: "lastAttendanceSyncAt"},
		&core.SelectField{Name: "lastClockStatus", MaxSelect: 1, Values: []string{"synced", "stale", "unsynced"}},
		&core.DateField{Name: "lastNtpSyncAt"},
		&core.NumberField{Name: "lastWifiRssiDbm"},
		&core.NumberField{Name: "lastUptimeSeconds"},
	)
	if err := app.Save(terminals); err != nil {
		app.Cleanup()
		t.Fatal(err)
	}
	rawToken, prefix, signingMaterial, err := createTerminalToken()
	if err != nil {
		app.Cleanup()
		t.Fatal(err)
	}
	terminal := core.NewRecord(terminals)
	terminal.Set("organization", organization.Id)
	terminal.Set("name", "Terminal A")
	terminal.Set("prefix", prefix)
	terminal.Set("tokenHash", hashValue(rawToken))
	terminal.Set("signingMaterial", signingMaterial)
	terminal.Set("protocolVersion", protocolVersion)
	if err := app.Save(terminal); err != nil {
		app.Cleanup()
		t.Fatal(err)
	}
	foreign := core.NewRecord(terminals)
	foreign.Set("organization", foreignOrganization.Id)
	foreign.Set("name", "Terminal B")
	if err := app.Save(foreign); err != nil {
		app.Cleanup()
		t.Fatal(err)
	}

	router, err := apis.NewRouter(app)
	if err != nil {
		app.Cleanup()
		t.Fatal(err)
	}
	service := New(app)
	service.pingTimeout = 100 * time.Millisecond
	service.Register(&core.ServeEvent{App: app, Router: router})
	handler, err := router.BuildMux()
	if err != nil {
		app.Cleanup()
		t.Fatal(err)
	}
	return &terminalAPIFixture{
		app: app, service: service, handler: handler, organization: organization,
		terminal: terminal, foreign: foreign, terminalToken: rawToken, userTokens: userTokens,
	}
}

func (fixture *terminalAPIFixture) request(t *testing.T, method, path, authorization string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, "http://127.0.0.1"+path, bytes.NewReader(payload))
	request.RemoteAddr = "203.0.113.9:43110"
	request.Header.Set("Content-Type", "application/json")
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	return response
}

func responseJSON(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("response is not JSON: %s", response.Body.String())
	}
	return decoded
}

func validHeartbeatBody() map[string]any {
	return map[string]any{
		"protocolVersion": 1,
		"clientVersion":   "m5stack-1.1.0",
		"cacheRevision":   2,
		"pendingCount":    0,
		"wifiRssiDbm":     -61,
		"uptimeSeconds":   90,
		"clockStatus":     "synced",
		"lastNtpSyncAt":   time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano),
	}
}

func TestTerminalTelemetryRoutesRoundTripPermissionsAndRevocation(t *testing.T) {
	fixture := newTerminalAPIFixture(t)
	defer fixture.app.Cleanup()
	terminalAuthorization := "Bearer " + fixture.terminalToken

	invalid := validHeartbeatBody()
	invalid["clockStatus"] = "invented"
	response := fixture.request(t, http.MethodPost, "/api/openjornada/terminal/v1/heartbeat", terminalAuthorization, invalid)
	if response.Code != http.StatusBadRequest || responseJSON(t, response)["code"] != "terminal_telemetry_invalid" {
		t.Fatalf("invalid heartbeat response = %d %s", response.Code, response.Body.String())
	}
	response = fixture.request(t, http.MethodPost, "/api/openjornada/terminal/v1/ping-ack", terminalAuthorization, map[string]any{
		"pingChallenge": "invalid", "localIp": "not-an-ip", "wifiRssiDbm": -61, "uptimeSeconds": 90,
	})
	if response.Code != http.StatusBadRequest || responseJSON(t, response)["code"] != "terminal_ping_ack_invalid" {
		t.Fatalf("invalid ping acknowledgement response = %d %s", response.Code, response.Body.String())
	}

	response = fixture.request(t, http.MethodPost, "/api/openjornada/terminals/"+fixture.terminal.Id+"/ping", fixture.userTokens["employee"], nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("employee ping status = %d, want 403: %s", response.Code, response.Body.String())
	}
	response = fixture.request(t, http.MethodPost, "/api/openjornada/terminals/"+fixture.foreign.Id+"/ping", fixture.userTokens["manager"], nil)
	if response.Code != http.StatusNotFound {
		t.Fatalf("foreign terminal ping status = %d, want 404: %s", response.Code, response.Body.String())
	}

	pingDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		pingDone <- fixture.request(t, http.MethodPost, "/api/openjornada/terminals/"+fixture.terminal.Id+"/ping", fixture.userTokens["manager"], nil)
	}()
	var challenge string
	deadline := time.Now().Add(time.Second)
	for challenge == "" && time.Now().Before(deadline) {
		heartbeat := fixture.request(t, http.MethodPost, "/api/openjornada/terminal/v1/heartbeat", terminalAuthorization, validHeartbeatBody())
		if heartbeat.Code != http.StatusOK {
			t.Fatalf("heartbeat status = %d: %s", heartbeat.Code, heartbeat.Body.String())
		}
		challenge, _ = responseJSON(t, heartbeat)["pingChallenge"].(string)
		if challenge == "" {
			time.Sleep(time.Millisecond)
		}
	}
	if challenge == "" {
		t.Fatal("manager ping did not expose a challenge through heartbeat")
	}
	ack := fixture.request(t, http.MethodPost, "/api/openjornada/terminal/v1/ping-ack", terminalAuthorization, map[string]any{
		"pingChallenge": challenge, "localIp": "192.168.1.44", "wifiRssiDbm": -62, "uptimeSeconds": 91,
	})
	if ack.Code != http.StatusOK || responseJSON(t, ack)["acknowledged"] != true {
		t.Fatalf("ping acknowledgement = %d %s", ack.Code, ack.Body.String())
	}
	ping := <-pingDone
	pingBody := responseJSON(t, ping)
	if ping.Code != http.StatusOK || pingBody["terminalId"] != fixture.terminal.Id || pingBody["localIp"] != "192.168.1.44" || pingBody["publicIp"] != "203.0.113.9" {
		t.Fatalf("manager ping response = %d %s", ping.Code, ping.Body.String())
	}

	fixture.service.pingTimeout = 10 * time.Millisecond
	timedOut := fixture.request(t, http.MethodPost, "/api/openjornada/terminals/"+fixture.terminal.Id+"/ping", fixture.userTokens["admin"], nil)
	if timedOut.Code != http.StatusGatewayTimeout || responseJSON(t, timedOut)["code"] != "terminal_ping_timeout" {
		t.Fatalf("ping timeout response = %d %s", timedOut.Code, timedOut.Body.String())
	}

	waiter, err := fixture.service.pings.begin(fixture.terminal.Id, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	revoked := fixture.request(t, http.MethodPost, "/api/openjornada/terminals/"+fixture.terminal.Id+"/revoke", fixture.userTokens["admin"], nil)
	if revoked.Code != http.StatusOK {
		t.Fatalf("revoke response = %d %s", revoked.Code, revoked.Body.String())
	}
	if completion := <-waiter.Completion; !errors.Is(completion.Err, errTerminalRevoked) {
		t.Fatalf("revoked ping completion = %#v", completion)
	}
	response = fixture.request(t, http.MethodPost, "/api/openjornada/terminals/"+fixture.terminal.Id+"/ping", fixture.userTokens["admin"], nil)
	if response.Code != http.StatusConflict || responseJSON(t, response)["code"] != "terminal_revoked" {
		t.Fatalf("revoked ping response = %d %s", response.Code, response.Body.String())
	}
	response = fixture.request(t, http.MethodPost, "/api/openjornada/terminal/v1/heartbeat", terminalAuthorization, validHeartbeatBody())
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("revoked heartbeat status = %d, want 401: %s", response.Code, response.Body.String())
	}
	response = fixture.request(t, http.MethodPost, "/api/openjornada/terminal/v1/ping-ack", terminalAuthorization, map[string]any{
		"pingChallenge": challenge, "localIp": "192.168.1.44", "wifiRssiDbm": -62, "uptimeSeconds": 92,
	})
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("revoked ping acknowledgement status = %d, want 401: %s", response.Code, response.Body.String())
	}
}
