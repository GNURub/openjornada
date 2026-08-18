package terminal

import (
	"net/http/httptest"
	"testing"
)

func TestSecureTerminalRequest(t *testing.T) {
	local := httptest.NewRequest("POST", "http://127.0.0.1:8090/api/openjornada/terminal/v1/bootstrap", nil)
	if !secureTerminalRequest(local) {
		t.Fatal("localhost must remain available for development")
	}

	proxied := httptest.NewRequest("POST", "http://openjornada.internal/api/openjornada/terminal/v1/bootstrap", nil)
	proxied.Host = "jornada.example.com"
	proxied.RemoteAddr = "172.18.0.2:43210"
	proxied.Header.Set("X-Forwarded-Proto", "https")
	if !secureTerminalRequest(proxied) {
		t.Fatal("HTTPS forwarded by the production proxy must be accepted")
	}

	insecure := httptest.NewRequest("POST", "http://jornada.example.com/api/openjornada/terminal/v1/bootstrap", nil)
	if secureTerminalRequest(insecure) {
		t.Fatal("plain HTTP on a public host must be rejected")
	}

	spoofed := httptest.NewRequest("POST", "http://jornada.example.com/api/openjornada/terminal/v1/bootstrap", nil)
	spoofed.Header.Set("X-Forwarded-Proto", "https")
	spoofed.RemoteAddr = "203.0.113.8:43210"
	if secureTerminalRequest(spoofed) {
		t.Fatal("a public client must not be able to spoof the proxy protocol header")
	}
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
