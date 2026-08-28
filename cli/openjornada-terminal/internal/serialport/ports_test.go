package serialport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/protocol"
	"go.bug.st/serial"
)

type fakePort struct {
	mu          sync.Mutex
	mode        string
	response    []byte
	closed      bool
	reset       bool
	dtrCalls    int
	rtsCalls    int
	readTimeout time.Duration
}

func (port *fakePort) Read(buffer []byte) (int, error) {
	port.mu.Lock()
	if port.closed {
		port.mu.Unlock()
		return 0, io.EOF
	}
	if len(port.response) == 0 {
		port.mu.Unlock()
		time.Sleep(time.Millisecond)
		return 0, nil
	}
	n := copy(buffer, port.response[:1])
	port.response = port.response[n:]
	port.mu.Unlock()
	return n, nil
}

func (port *fakePort) Write(buffer []byte) (int, error) {
	port.mu.Lock()
	defer port.mu.Unlock()
	var request protocol.Request
	line := bytes.TrimSuffix(bytes.TrimPrefix(buffer, []byte(protocol.Prefix)), []byte("\n"))
	if err := json.Unmarshal(line, &request); err != nil {
		return 0, err
	}
	if port.mode != "" {
		port.response = []byte("boot noise\r\n" + protocol.Prefix + `{"v":1,"id":"` + request.ID + `","type":"result","code":"ok","message":"Terminal disponible.","data":{"protocolVersion":1,"board":"m5stack-basic-core-v27","firmwareVersion":"1.2.3","mode":"` + port.mode + `","capabilities":{"status":true,"doctor":true,"structuredLogs":false,"reboot":false,"physicalFactoryReset":false,"provisioningRecovery":true,"firmwareInstall":false,"negotiatedBaud":false}}}` + "\n")
	}
	return len(buffer), nil
}

func (port *fakePort) Close() error { port.mu.Lock(); port.closed = true; port.mu.Unlock(); return nil }
func (port *fakePort) SetReadTimeout(timeout time.Duration) error {
	port.readTimeout = timeout
	return nil
}
func (port *fakePort) SetDTR(bool) error       { port.dtrCalls++; return nil }
func (port *fakePort) SetRTS(bool) error       { port.rtsCalls++; return nil }
func (port *fakePort) ResetInputBuffer() error { port.reset = true; return nil }

func TestDiscoverSelectsExactlyOneHandshakingPort(t *testing.T) {
	ports := map[string]*fakePort{
		"/dev/tty0": {mode: ""},
		"/dev/tty1": {mode: "ready"},
	}
	openedModes := map[string]*serial.Mode{}
	got, err := discover(context.Background(), "auto",
		func() ([]string, error) { return []string{"/dev/tty0", "/dev/tty1"}, nil },
		func(name string, mode *serial.Mode) (Port, error) {
			openedModes[name] = mode
			return ports[name], nil
		})
	if err != nil {
		t.Fatalf("discover() error = %v", err)
	}
	if got != ports["/dev/tty1"] {
		t.Fatal("discover() returned wrong port")
	}
	for name, mode := range openedModes {
		if mode.BaudRate != 115200 || mode.DataBits != 8 || mode.Parity != serial.NoParity || mode.StopBits != serial.OneStopBit {
			t.Fatalf("mode for %s = %#v", name, mode)
		}
		if mode.InitialStatusBits == nil || mode.InitialStatusBits.DTR || mode.InitialStatusBits.RTS {
			t.Fatalf("initial modem bits for %s = %#v", name, mode.InitialStatusBits)
		}
		if ports[name].dtrCalls != 0 || ports[name].rtsCalls != 0 || !ports[name].reset {
			t.Fatalf("port %s DTR=%d RTS=%d reset=%v", name, ports[name].dtrCalls, ports[name].rtsCalls, ports[name].reset)
		}
	}
	if !ports["/dev/tty0"].closed || ports["/dev/tty1"].closed {
		t.Fatalf("closed states: bad=%v selected=%v", ports["/dev/tty0"].closed, ports["/dev/tty1"].closed)
	}
}

func TestDiscoverRequestedPathStillRequiresHandshake(t *testing.T) {
	port := &fakePort{}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err := discover(ctx, "/dev/secret-safe-name",
		func() ([]string, error) { t.Fatal("requested path enumerated"); return nil, nil },
		func(string, *serial.Mode) (Port, error) { return port, nil })
	if !errors.Is(err, ErrNoTerminal) {
		t.Fatalf("discover() error = %v", err)
	}
	if !port.closed {
		t.Fatal("failed requested port was not closed")
	}
}

func TestDiscoverRejectsMultipleTerminalsWithSafeNames(t *testing.T) {
	ports := map[string]*fakePort{"COM3": {mode: "provisioning"}, "COM7": {mode: "ready"}}
	_, err := discover(context.Background(), "auto",
		func() ([]string, error) { return []string{"COM7", "COM3"}, nil },
		func(name string, _ *serial.Mode) (Port, error) { return ports[name], nil })
	if !errors.Is(err, ErrMultipleTerminals) {
		t.Fatalf("discover() error = %v", err)
	}
	if !strings.Contains(err.Error(), "COM3") || !strings.Contains(err.Error(), "COM7") {
		t.Fatalf("error lacks safe port names: %v", err)
	}
	if !ports["COM3"].closed || !ports["COM7"].closed {
		t.Fatal("ambiguous ports were not closed")
	}
}

func TestDiscoverFailsClosedWhenEnumerationFails(t *testing.T) {
	_, err := discover(context.Background(), "auto",
		func() ([]string, error) { return nil, errors.New("secret lower-level detail") },
		func(string, *serial.Mode) (Port, error) { t.Fatal("opened a port"); return nil, nil })
	if !errors.Is(err, ErrNoTerminal) || strings.Contains(err.Error(), "secret lower-level detail") {
		t.Fatalf("discover() error = %v", err)
	}
}
