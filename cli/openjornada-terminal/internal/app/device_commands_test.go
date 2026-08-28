package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/protocol"
)

type fakeDeviceClient struct {
	replies  map[string]fakeReply
	events   chan protocol.Event
	commands []string
	payloads []any
	closed   bool
	called   chan string
}

type fakeReply struct {
	code string
	data any
	err  error
}

func (client *fakeDeviceClient) Call(ctx context.Context, command string, payload any, result any) error {
	_, err := client.CallReceipt(ctx, command, payload, result)
	return err
}

func (client *fakeDeviceClient) CallReceipt(_ context.Context, command string, payload any, result any) (protocol.Receipt, error) {
	client.commands = append(client.commands, command)
	client.payloads = append(client.payloads, payload)
	if client.called != nil {
		client.called <- command
	}
	reply := client.replies[command]
	if reply.err != nil {
		return protocol.Receipt{}, reply.err
	}
	if result != nil && reply.data != nil {
		encoded, _ := json.Marshal(reply.data)
		if err := json.Unmarshal(encoded, result); err != nil {
			return protocol.Receipt{}, err
		}
	}
	code := reply.code
	if code == "" {
		code = "ok"
	}
	return protocol.Receipt{ID: "AAAAAAAAAAAAAAAAAAAAAA", Code: code}, nil
}

func (client *fakeDeviceClient) Events() <-chan protocol.Event { return client.events }
func (client *fakeDeviceClient) Close() error                  { client.closed = true; return nil }

func healthyReplies(mode string) map[string]fakeReply {
	caps := protocol.Capabilities{Status: true, Doctor: true, StructuredLogs: true, Reboot: true, PhysicalFactoryReset: true, ProvisioningRecovery: true}
	return map[string]fakeReply{
		"hello":  {data: protocol.Hello{ProtocolVersion: 1, Board: supportedBoard, FirmwareVersion: "1.2.3", Mode: mode, Capabilities: caps}},
		"status": {data: deviceStatus{Board: supportedBoard, FirmwareVersion: "1.2.3", ProtocolVersion: 1, Mode: mode, Configured: true, WiFiConnected: true, PendingCount: 2}},
		"doctor": {data: doctorResult{StorageAvailable: true, RFIDAvailable: true, Configured: true, Capabilities: caps, ErrorCodes: []string{}}},
	}
}

func executeWithClient(t *testing.T, client *fakeDeviceClient, args ...string) (*bytes.Buffer, *bytes.Buffer, error) {
	t.Helper()
	stdout, stderr := &bytes.Buffer{}, &bytes.Buffer{}
	command := NewRoot(Dependencies{
		Stdin: bytes.NewBuffer(nil), Stdout: stdout, Stderr: stderr,
		Connect:      func(context.Context, string) (DeviceClient, error) { return client, nil },
		PortNames:    func() ([]string, error) { return []string{"COM7"}, nil },
		ReadPassword: func() ([]byte, error) { return nil, errors.New("not configured") },
		ResetTimeout: 20 * time.Millisecond,
	})
	command.SetArgs(args)
	err := command.Execute()
	return stdout, stderr, err
}

func TestStatusJSONContainsOnlyPublicSchema(t *testing.T) {
	client := &fakeDeviceClient{replies: healthyReplies("ready"), events: make(chan protocol.Event, 1)}
	stdout, _, err := executeWithClient(t, client, "status", "--json")
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"board"`, `"firmwareVersion"`, `"protocolVersion"`, `"mode"`, `"configured"`, `"wifiConnected"`, `"pendingCount"`, `"capabilities"`} {
		if !strings.Contains(stdout.String(), field) {
			t.Fatalf("status JSON lacks %s: %s", field, stdout.String())
		}
	}
	for _, forbidden := range []string{"ssid", "password", "token", "uid", "ip"} {
		if strings.Contains(strings.ToLower(stdout.String()), forbidden) {
			t.Fatalf("status leaked forbidden field %q", forbidden)
		}
	}
}

func TestStatusRejectsOmittedAndNullRequiredFields(t *testing.T) {
	valid := map[string]any{"board": supportedBoard, "firmwareVersion": "1.2.3", "protocolVersion": 1, "mode": "ready", "configured": true, "wifiConnected": true, "pendingCount": 0}
	for _, field := range []string{"board", "firmwareVersion", "protocolVersion", "mode", "configured", "wifiConnected", "pendingCount"} {
		for _, replacement := range []any{"omit", nil} {
			data := make(map[string]any, len(valid))
			for name, value := range valid {
				data[name] = value
			}
			if replacement == "omit" {
				delete(data, field)
			} else {
				data[field] = nil
			}
			replies := healthyReplies("ready")
			replies["status"] = fakeReply{data: data}
			client := &fakeDeviceClient{replies: replies, events: make(chan protocol.Event)}
			_, _, err := executeWithClient(t, client, "status", "--json")
			if err == nil {
				t.Fatalf("status accepted %s=%v", field, replacement)
			}
		}
	}
}

func TestDoctorRejectsOmittedAndNullRequiredFields(t *testing.T) {
	caps := protocol.Capabilities{Status: true, Doctor: true}
	valid := map[string]any{"storageAvailable": true, "rfidAvailable": true, "configured": true, "capabilities": caps, "errorCodes": []string{}}
	for _, field := range []string{"storageAvailable", "rfidAvailable", "configured", "capabilities", "errorCodes"} {
		for _, replacement := range []any{"omit", nil} {
			data := make(map[string]any, len(valid))
			for name, value := range valid {
				data[name] = value
			}
			if replacement == "omit" {
				delete(data, field)
			} else {
				data[field] = nil
			}
			replies := healthyReplies("ready")
			replies["doctor"] = fakeReply{data: data}
			client := &fakeDeviceClient{replies: replies, events: make(chan protocol.Event)}
			_, _, err := executeWithClient(t, client, "doctor")
			if err == nil {
				t.Fatalf("doctor accepted %s=%v", field, replacement)
			}
		}
	}
}

func TestDoctorReturnsErrorForIncompatibleBoard(t *testing.T) {
	replies := healthyReplies("ready")
	hello := replies["hello"].data.(protocol.Hello)
	hello.Board = "other-board"
	replies["hello"] = fakeReply{data: hello}
	client := &fakeDeviceClient{replies: replies, events: make(chan protocol.Event, 1)}
	stdout, _, err := executeWithClient(t, client, "doctor")
	if err == nil || !strings.Contains(stdout.String(), "incompatible") {
		t.Fatalf("doctor output=%q error=%v", stdout.String(), err)
	}
}

func TestPortsListsMultipleCompatibleTerminals(t *testing.T) {
	stdout := &bytes.Buffer{}
	clients := map[string]*fakeDeviceClient{}
	command := NewRoot(Dependencies{
		Stdout: stdout, Stderr: &bytes.Buffer{},
		PortNames: func() ([]string, error) { return []string{"COM7", "COM3"}, nil },
		Connect: func(_ context.Context, port string) (DeviceClient, error) {
			client := &fakeDeviceClient{replies: healthyReplies("ready"), events: make(chan protocol.Event, 1)}
			clients[port] = client
			return client, nil
		},
	})
	command.SetArgs([]string{"ports"})
	if err := command.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "COM3") || !strings.Contains(stdout.String(), "COM7") || len(clients) != 2 {
		t.Fatalf("ports output=%q", stdout.String())
	}
}

func TestPortsFailsWhenNoTerminalHandshakes(t *testing.T) {
	command := NewRoot(Dependencies{
		Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{},
		PortNames: func() ([]string, error) { return []string{"COM3"}, nil },
		Connect:   func(context.Context, string) (DeviceClient, error) { return nil, errors.New("raw secret response") },
	})
	command.SetArgs([]string{"ports"})
	err := command.Execute()
	if err == nil || strings.Contains(err.Error(), "raw secret response") {
		t.Fatalf("ports error=%v", err)
	}
}

func TestLogsFollowStopsCleanlyWhenContextIsCancelled(t *testing.T) {
	replies := healthyReplies("ready")
	replies["logs_subscribe"] = fakeReply{code: "subscribed"}
	client := &fakeDeviceClient{replies: replies, events: make(chan protocol.Event), called: make(chan string, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	command := NewRoot(Dependencies{Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}, Connect: func(context.Context, string) (DeviceClient, error) { return client, nil }})
	command.SetArgs([]string{"logs", "--follow"})
	command.SetContext(ctx)
	done := make(chan error, 1)
	go func() { done <- command.Execute() }()
	<-client.called
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("logs error=%v", err)
	}
}

func validOJP() string {
	raw := `{"v":1,"s":"Red Demo","p":"clave secreta","u":"http://192.168.1.20:8090","t":"ojterm_marker_123456"}`
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}
