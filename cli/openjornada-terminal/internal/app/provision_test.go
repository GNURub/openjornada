package app

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/protocol"
)

func TestProvisionReadsStdinNormalizesPayloadAndNeverLeaksSecret(t *testing.T) {
	replies := healthyReplies("provisioning")
	replies["provision"] = fakeReply{code: "accepted"}
	events := make(chan protocol.Event, 1)
	events <- protocol.Event{ID: "AAAAAAAAAAAAAAAAAAAAAA", Type: "event", Code: "saved", Data: []byte(`{}`)}
	client := &fakeDeviceClient{replies: replies, events: events}
	secret := "http://192.168.4.1/#ojp=" + validOJP()
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command := NewRoot(Dependencies{
		Stdin: strings.NewReader(secret + "\n\t"), Stdout: stdout, Stderr: stderr,
		Connect: func(context.Context, string) (DeviceClient, error) { return client, nil },
	})
	command.SetArgs([]string{"provision", "--ojp-stdin"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	payload := client.payloads[len(client.payloads)-1].(map[string]string)
	if payload["ojp"] != validOJP() {
		t.Fatalf("normalized payload mismatch")
	}
	if strings.Contains(stdout.String()+stderr.String(), secret) || strings.Contains(stdout.String()+stderr.String(), "clave secreta") {
		t.Fatal("OJP leaked")
	}
}

func TestProvisionInteractiveUsesReadPasswordAndNotStdin(t *testing.T) {
	replies := healthyReplies("provisioning")
	replies["provision"] = fakeReply{code: "accepted"}
	events := make(chan protocol.Event, 1)
	events <- protocol.Event{ID: "AAAAAAAAAAAAAAAAAAAAAA", Type: "event", Code: "saved", Data: []byte(`{}`)}
	client := &fakeDeviceClient{replies: replies, events: events}
	readPassword := false
	command := NewRoot(Dependencies{
		Stdin: strings.NewReader("must-not-be-read"), Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
		Connect:      func(context.Context, string) (DeviceClient, error) { return client, nil },
		ReadPassword: func() ([]byte, error) { readPassword = true; return []byte(validOJP()), nil },
	})
	command.SetArgs([]string{"provision"})
	if err := command.Execute(); err != nil || !readPassword {
		t.Fatalf("error=%v readPassword=%v", err, readPassword)
	}
}

func TestReadBoundedOJPAllowsOnlyTrailingWhitespaceWithinBound(t *testing.T) {
	valid := validOJP()
	got, err := readBoundedOJP(strings.NewReader(valid + "\r\n\t"))
	if err != nil || string(got) != valid {
		t.Fatalf("readBoundedOJP()=%q error=%v", got, err)
	}
	for _, input := range []string{valid + "\nextra", strings.Repeat("A", 601)} {
		if _, err := readBoundedOJP(strings.NewReader(input)); err == nil {
			t.Fatalf("readBoundedOJP accepted invalid input length=%d", len(input))
		}
	}
	padding := strings.Repeat(" ", 601-len(valid))
	if _, err := readBoundedOJP(strings.NewReader(valid + padding + "extra")); err == nil {
		t.Fatal("readBoundedOJP ignored bytes after its previous limit")
	}
}

func TestProvisionReadFailureNeverReflectsInputOrDependencyError(t *testing.T) {
	client := &fakeDeviceClient{replies: healthyReplies("provisioning"), events: make(chan protocol.Event)}
	marker := "secret-marker"
	command := NewRoot(Dependencies{
		Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
		Connect:      func(context.Context, string) (DeviceClient, error) { return client, nil },
		ReadPassword: func() ([]byte, error) { return nil, errors.New(marker) },
	})
	command.SetArgs([]string{"provision"})
	err := command.Execute()
	if err == nil || strings.Contains(err.Error(), marker) {
		t.Fatalf("error=%v", err)
	}
}

func TestProvisionRejectsWrongModeBeforeReadingPassword(t *testing.T) {
	client := &fakeDeviceClient{replies: healthyReplies("ready"), events: make(chan protocol.Event)}
	read := false
	command := NewRoot(Dependencies{
		Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
		Connect:      func(context.Context, string) (DeviceClient, error) { return client, nil },
		ReadPassword: func() ([]byte, error) { read = true; return []byte(validOJP()), nil },
	})
	command.SetArgs([]string{"provision"})
	if err := command.Execute(); err == nil || read {
		t.Fatalf("error=%v readPassword=%v", err, read)
	}
}

func TestProvisionReportsPendingActionsWithoutWaitingForEvents(t *testing.T) {
	replies := healthyReplies("provisioning")
	replies["provision"] = fakeReply{code: "pending_actions"}
	client := &fakeDeviceClient{replies: replies, events: make(chan protocol.Event)}
	command := NewRoot(Dependencies{
		Stdin: strings.NewReader(validOJP()), Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
		Connect: func(context.Context, string) (DeviceClient, error) { return client, nil },
	})
	command.SetArgs([]string{"provision", "--ojp-stdin"})
	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "pendientes") {
		t.Fatalf("error=%v", err)
	}
}
