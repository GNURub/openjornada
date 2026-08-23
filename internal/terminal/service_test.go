package terminal

import (
	"crypto/tls"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
)

func TestTerminalListPagination(t *testing.T) {
	tests := []struct {
		name           string
		rawPage        string
		totalItems     int64
		wantPage       int
		wantTotalPages int
		wantErr        bool
	}{
		{name: "defaults to first page", totalItems: 21, wantPage: 1, wantTotalPages: 3},
		{name: "keeps requested page", rawPage: "2", totalItems: 21, wantPage: 2, wantTotalPages: 3},
		{name: "clamps page after last item disappears", rawPage: "4", totalItems: 21, wantPage: 3, wantTotalPages: 3},
		{name: "empty list stays on first page", rawPage: "8", totalItems: 0, wantPage: 1, wantTotalPages: 0},
		{name: "rejects zero", rawPage: "0", totalItems: 21, wantErr: true},
		{name: "rejects negative", rawPage: "-1", totalItems: 21, wantErr: true},
		{name: "rejects text", rawPage: "next", totalItems: 21, wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			page, totalPages, err := terminalListPagination(test.rawPage, test.totalItems)
			if test.wantErr {
				if err == nil {
					t.Fatal("terminalListPagination() expected an error")
				}
				return
			}
			if err != nil {
				t.Fatalf("terminalListPagination() unexpected error: %v", err)
			}
			if page != test.wantPage || totalPages != test.wantTotalPages {
				t.Fatalf(
					"terminalListPagination() = (%d, %d), want (%d, %d)",
					page,
					totalPages,
					test.wantPage,
					test.wantTotalPages,
				)
			}
		})
	}
}

func TestFindTerminalRecordsPageOrdersActiveThenNewestAndScopesOrganization(t *testing.T) {
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	collection := core.NewBaseCollection("attendance_terminals")
	collection.Fields.Add(
		&core.TextField{Name: "organization", Required: true},
		&core.TextField{Name: "name", Required: true},
		&core.DateField{Name: "revokedAt"},
		&core.DateField{Name: "created", Required: true},
	)
	if err := app.Save(collection); err != nil {
		t.Fatal(err)
	}

	save := func(name, organization, created, revokedAt string) {
		record := core.NewRecord(collection)
		record.Set("name", name)
		record.Set("organization", organization)
		record.Set("created", created)
		record.Set("revokedAt", revokedAt)
		if err := app.Save(record); err != nil {
			t.Fatal(err)
		}
	}
	for day := 1; day <= 11; day++ {
		save(
			fmt.Sprintf("active-%02d", day),
			"organization-1",
			fmt.Sprintf("2026-08-%02d 10:00:00.000Z", day),
			"",
		)
	}
	save("revoked-older", "organization-1", "2026-08-20 10:00:00.000Z", "2026-08-21 10:00:00.000Z")
	save("revoked-newer", "organization-1", "2026-08-21 10:00:00.000Z", "2026-08-22 10:00:00.000Z")
	save("other-organization", "organization-2", "2026-08-31 10:00:00.000Z", "")

	first, err := findTerminalRecordsPage(app, "organization-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	second, err := findTerminalRecordsPage(app, "organization-1", 2)
	if err != nil {
		t.Fatal(err)
	}

	firstNames := make([]string, 0, len(first))
	for _, record := range first {
		firstNames = append(firstNames, record.GetString("name"))
	}
	secondNames := make([]string, 0, len(second))
	for _, record := range second {
		secondNames = append(secondNames, record.GetString("name"))
	}
	if got, want := fmt.Sprint(firstNames), "[active-11 active-10 active-09 active-08 active-07 active-06 active-05 active-04 active-03 active-02]"; got != want {
		t.Fatalf("first page = %s, want %s", got, want)
	}
	if got, want := fmt.Sprint(secondNames), "[active-01 revoked-newer revoked-older]"; got != want {
		t.Fatalf("second page = %s, want %s", got, want)
	}
}

func TestSecureTerminalRequest(t *testing.T) {
	tests := []struct {
		name             string
		host             string
		remoteAddr       string
		tls              bool
		forwardedProto   string
		demoEnabled      bool
		allowPrivateHTTP bool
		want             bool
	}{
		{name: "TLS public host", host: "jornada.example.com", remoteAddr: "203.0.113.8:43210", tls: true, want: true},
		{name: "HTTP localhost", host: "localhost:8090", remoteAddr: "203.0.113.8:43210", want: true},
		{name: "HTTP loopback IPv4", host: "127.0.0.1:8090", remoteAddr: "203.0.113.8:43210", want: true},
		{name: "HTTP loopback IPv6", host: "[::1]:8090", remoteAddr: "203.0.113.8:43210", want: true},
		{name: "private HTTP with both flags", host: "192.168.1.20:8090", remoteAddr: "192.168.1.40:43210", demoEnabled: true, allowPrivateHTTP: true, want: true},
		{name: "private HTTP without demo", host: "192.168.1.20:8090", remoteAddr: "192.168.1.40:43210", allowPrivateHTTP: true, want: false},
		{name: "private HTTP without explicit allowance", host: "192.168.1.20:8090", remoteAddr: "192.168.1.40:43210", demoEnabled: true, want: false},
		{name: "public host with both flags", host: "jornada.example.com", remoteAddr: "192.168.1.40:43210", demoEnabled: true, allowPrivateHTTP: true, want: false},
		{name: "private host with public peer", host: "192.168.1.20:8090", remoteAddr: "203.0.113.8:43210", demoEnabled: true, allowPrivateHTTP: true, want: false},
		{name: "trusted proxy HTTPS", host: "jornada.example.com", remoteAddr: "172.18.0.2:43210", forwardedProto: "https", want: true},
		{name: "proxy HTTPS from loopback", host: "jornada.example.com", remoteAddr: "127.0.0.1:43210", forwardedProto: "https", want: true},
		{name: "spoofed proxy HTTPS from public peer", host: "jornada.example.com", remoteAddr: "203.0.113.8:43210", forwardedProto: "https", demoEnabled: true, allowPrivateHTTP: true, want: false},
		{name: "first forwarded protocol must be HTTPS", host: "jornada.example.com", remoteAddr: "172.18.0.2:43210", forwardedProto: "http, https", want: false},
		{name: "RFC1918 10 range without port", host: "10.20.30.40", remoteAddr: "127.0.0.1:43210", demoEnabled: true, allowPrivateHTTP: true, want: true},
		{name: "RFC1918 172 range", host: "172.16.0.1:8090", remoteAddr: "10.0.0.2:43210", demoEnabled: true, allowPrivateHTTP: true, want: true},
		{name: "outside RFC1918 172 range", host: "172.15.255.255:8090", remoteAddr: "10.0.0.2:43210", demoEnabled: true, allowPrivateHTTP: true, want: false},
		{name: "link local host is not RFC1918", host: "169.254.1.20:8090", remoteAddr: "10.0.0.2:43210", demoEnabled: true, allowPrivateHTTP: true, want: false},
		{name: "IPv6 ULA host is not RFC1918", host: "[fd00::20]:8090", remoteAddr: "[fd00::40]:43210", demoEnabled: true, allowPrivateHTTP: true, want: false},
		{name: "malformed host port", host: "192.168.1.20:not-a-port", remoteAddr: "192.168.1.40:43210", demoEnabled: true, allowPrivateHTTP: true, want: false},
		{name: "missing remote peer", host: "192.168.1.20:8090", remoteAddr: "", demoEnabled: true, allowPrivateHTTP: true, want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "http://openjornada.invalid/api/openjornada/terminal/v1/bootstrap", nil)
			request.Host = test.host
			request.RemoteAddr = test.remoteAddr
			request.Header.Set("X-Forwarded-Proto", test.forwardedProto)
			if test.tls {
				request.TLS = &tls.ConnectionState{}
			}
			if got := secureTerminalRequest(request, test.demoEnabled, test.allowPrivateHTTP); got != test.want {
				t.Fatalf("secureTerminalRequest() = %t, want %t", got, test.want)
			}
		})
	}
}

func TestNewServiceReadsTerminalHTTPPolicy(t *testing.T) {
	t.Run("disabled by default", func(t *testing.T) {
		t.Setenv("PB_DEMO_ENABLED", "")
		t.Setenv("PB_TERMINAL_DEV_INSECURE_HTTP", "")
		service := New(nil)
		if service.demoEnabled || service.allowPrivateHTTP {
			t.Fatal("private HTTP policy must be disabled by default")
		}
	})

	t.Run("both flags enabled", func(t *testing.T) {
		t.Setenv("PB_DEMO_ENABLED", "true")
		t.Setenv("PB_TERMINAL_DEV_INSECURE_HTTP", "true")
		service := New(nil)
		if !service.demoEnabled || !service.allowPrivateHTTP {
			t.Fatal("service must inject both explicit environment flags")
		}
	})

	t.Run("other values remain disabled", func(t *testing.T) {
		t.Setenv("PB_DEMO_ENABLED", "TRUE")
		t.Setenv("PB_TERMINAL_DEV_INSECURE_HTTP", "yes")
		service := New(nil)
		if service.demoEnabled || service.allowPrivateHTTP {
			t.Fatal("only the explicit true value may enable private HTTP")
		}
	})
}

func TestOfflineSignatureIsBoundToTerminalAndChain(t *testing.T) {
	action := queuedAction{
		ClientRequestID:   "request-1",
		UID:               "04A1B2C3",
		Command:           CommandClockIn,
		DeviceCapturedAt:  "2026-08-18T10:00:00.000Z",
		ClockSyncedAt:     "2026-08-18T09:59:00.000Z",
		DeviceSequence:    1,
		RebootID:          "boot-1",
		PreviousLocalHash: "previous",
	}
	first := canonicalQueuedAction("terminal-a", action)
	if first == canonicalQueuedAction("terminal-b", action) {
		t.Fatal("canonical payload must be bound to one terminal")
	}
	action.PreviousLocalHash = "different"
	if first == canonicalQueuedAction("terminal-a", action) {
		t.Fatal("canonical payload must include the previous local hash")
	}
}

func TestFirmwareSignatureVector(t *testing.T) {
	const token = "ojterm_abcdefghijkl_secret0123456789012345678901234567890123456789"
	const expectedCanonical = "terminal-a|req-1|04A1B2C3|clock_in|2026-08-21T08:00:00.000Z||2026-08-21T07:59:59.000Z|1|boot-1|"
	const expected = "f6d92375cab26283b16c1174a19c60cdaff19ac4c646f6e34f6748a90fc6b118"
	action := queuedAction{
		ClientRequestID:  "req-1",
		UID:              "04A1B2C3",
		Command:          CommandClockIn,
		DeviceCapturedAt: "2026-08-21T08:00:00.000Z",
		ClockSyncedAt:    "2026-08-21T07:59:59.000Z",
		DeviceSequence:   1,
		RebootID:         "boot-1",
	}
	canonical := canonicalQueuedAction("terminal-a", action)
	if canonical != expectedCanonical {
		t.Fatal("firmware canonical vector mismatch")
	}

	if got := signPayload(signingKeyForToken(token), canonical); got != expected {
		t.Fatalf("firmware signature vector mismatch: got %s", got)
	}
}
