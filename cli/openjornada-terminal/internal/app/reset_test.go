package app

import (
	"strings"
	"testing"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/protocol"
)

func TestFactoryResetShowsPendingCountAndHandlesPhysicalCancellation(t *testing.T) {
	replies := healthyReplies("ready")
	replies["factory_reset"] = fakeReply{code: "physical_confirmation_required", data: resetAcceptance{PendingCount: 2}}
	events := make(chan protocol.Event, 1)
	events <- protocol.Event{ID: "AAAAAAAAAAAAAAAAAAAAAA", Type: "event", Code: "physical_confirmation_cancelled", Data: []byte(`{}`)}
	client := &fakeDeviceClient{replies: replies, events: events}
	stdout, _, err := executeWithClient(t, client, "factory-reset")
	if err == nil || !strings.Contains(stdout.String(), "2") || !strings.Contains(stdout.String(), "SOLO C") {
		t.Fatalf("stdout=%q error=%v", stdout.String(), err)
	}
}

func TestFactoryResetHasNoYesFlag(t *testing.T) {
	client := &fakeDeviceClient{replies: healthyReplies("ready"), events: make(chan protocol.Event)}
	_, _, err := executeWithClient(t, client, "factory-reset", "--yes")
	if err == nil {
		t.Fatal("factory-reset accepted --yes")
	}
}

func TestFactoryResetAcceptsCompletionResultAndReboots(t *testing.T) {
	replies := healthyReplies("ready")
	replies["factory_reset"] = fakeReply{code: "physical_confirmation_required", data: resetAcceptance{PendingCount: 2}}
	events := make(chan protocol.Event, 1)
	events <- protocol.Event{ID: "AAAAAAAAAAAAAAAAAAAAAA", Type: "result", Code: "factory_reset_complete", Data: []byte(`{}`)}
	client := &fakeDeviceClient{replies: replies, events: events}
	stdout, _, err := executeWithClient(t, client, "factory-reset")
	if err != nil || !strings.Contains(stdout.String(), "reiniciando") {
		t.Fatalf("stdout=%q error=%v", stdout.String(), err)
	}
}

func TestFactoryResetRejectsIncompleteStatusBeforeShowingPendingCount(t *testing.T) {
	replies := healthyReplies("ready")
	replies["status"] = fakeReply{data: map[string]any{"board": supportedBoard}}
	client := &fakeDeviceClient{replies: replies, events: make(chan protocol.Event)}
	stdout, _, err := executeWithClient(t, client, "factory-reset")
	if err == nil || strings.Contains(stdout.String(), "Fichajes pendientes") {
		t.Fatalf("stdout=%q error=%v", stdout.String(), err)
	}
}
