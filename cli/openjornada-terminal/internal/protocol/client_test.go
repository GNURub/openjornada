package protocol

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"go.bug.st/serial"
)

type testTransport struct {
	net.Conn
	mu      sync.Mutex
	timeout time.Duration
}

type firmwareTestTransport struct {
	*testTransport
	muMode sync.Mutex
	modes  []int
}

type blockingFirmwareTransport struct {
	closed    chan struct{}
	closeOnce sync.Once
	closes    atomic.Int32
}

func newBlockingFirmwareTransport() *blockingFirmwareTransport {
	return &blockingFirmwareTransport{closed: make(chan struct{})}
}

func (transport *blockingFirmwareTransport) Read([]byte) (int, error) {
	<-transport.closed
	return 0, io.ErrClosedPipe
}

func (transport *blockingFirmwareTransport) Write([]byte) (int, error) {
	<-transport.closed
	return 0, io.ErrClosedPipe
}

func (transport *blockingFirmwareTransport) Close() error {
	transport.closeOnce.Do(func() {
		transport.closes.Add(1)
		close(transport.closed)
	})
	return nil
}

func (*blockingFirmwareTransport) SetReadTimeout(time.Duration) error { return nil }

func (transport *firmwareTestTransport) SetMode(mode *serial.Mode) error {
	transport.muMode.Lock()
	defer transport.muMode.Unlock()
	transport.modes = append(transport.modes, mode.BaudRate)
	return nil
}

func (transport *testTransport) SetReadTimeout(timeout time.Duration) error {
	transport.mu.Lock()
	transport.timeout = timeout
	transport.mu.Unlock()
	return nil
}

func (transport *testTransport) Read(buffer []byte) (int, error) {
	transport.mu.Lock()
	timeout := transport.timeout
	transport.mu.Unlock()
	if timeout < 0 {
		_ = transport.SetReadDeadline(time.Time{})
	} else {
		_ = transport.SetReadDeadline(time.Now().Add(timeout))
	}
	return transport.Conn.Read(buffer)
}

func newTestClient(t *testing.T) (*Client, net.Conn) {
	t.Helper()
	clientSide, deviceSide := net.Pipe()
	client, err := NewClient(&testTransport{Conn: clientSide})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	t.Cleanup(func() {
		_ = client.Close()
		_ = deviceSide.Close()
	})
	return client, deviceSide
}

func TestFirmwareWritesAreAtomicAndBaudIsRestricted(t *testing.T) {
	clientSide, deviceSide := net.Pipe()
	transport := &firmwareTestTransport{testTransport: &testTransport{Conn: clientSide}}
	client, err := NewClient(transport)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close(); _ = deviceSide.Close() })
	received := make(chan []byte, 1)
	go func() {
		frame := make([]byte, 6)
		_, _ = io.ReadFull(deviceSide, frame)
		received <- frame
	}()
	if err := client.WriteBinary(context.Background(), []byte("OJFWxx")); err != nil {
		t.Fatal(err)
	}
	if got := string(<-received); got != "OJFWxx" {
		t.Fatalf("frame = %q", got)
	}
	if err := client.SetBaud(460800); err != nil {
		t.Fatal(err)
	}
	if err := client.SetBaud(9600); !errors.Is(err, ErrTransport) {
		t.Fatalf("SetBaud(9600) error = %v", err)
	}
	transport.muMode.Lock()
	defer transport.muMode.Unlock()
	if len(transport.modes) != 1 || transport.modes[0] != 460800 {
		t.Fatalf("modes = %v", transport.modes)
	}
}

func TestFirmwareWriteDeadlineClosesPortAndDoesNotLeak(t *testing.T) {
	transport := newBlockingFirmwareTransport()
	client, err := NewClient(transport)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.WriteBinary(ctx, []byte("OJFW-blocked")) }()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("WriteBinary() error = %v", err)
		}
	case <-time.After(100 * time.Millisecond):
		_ = transport.Close()
		<-done
		t.Fatal("WriteBinary() ignored its deadline")
	}
	select {
	case <-client.done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("client read loop leaked after forced close")
	}
	if err := client.Close(); err != nil {
		t.Fatal(err)
	}
	if got := transport.closes.Load(); got != 1 {
		t.Fatalf("Close() calls = %d", got)
	}
}

func readRequest(t *testing.T, reader *bufio.Reader) Request {
	t.Helper()
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("ReadString() error = %v", err)
	}
	if !strings.HasPrefix(line, Prefix) || strings.Count(line, "\n") != 1 {
		t.Fatalf("request framing = %q", line)
	}
	var request Request
	if err := json.Unmarshal([]byte(strings.TrimSuffix(strings.TrimPrefix(line, Prefix), "\n")), &request); err != nil {
		t.Fatalf("request JSON error = %v", err)
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(request.ID)
	if err != nil || len(raw) != 16 {
		t.Fatalf("request ID = %q, decode error = %v, bytes = %d", request.ID, err, len(raw))
	}
	return request
}

func responseLine(id, kind, code, data string) string {
	return Prefix + `{"v":1,"id":"` + id + `","type":"` + kind + `","code":"` + code + `","message":"seguro","data":` + data + "}\n"
}

func TestCallHandlesFragmentationAndBootNoise(t *testing.T) {
	client, device := newTestClient(t)
	done := make(chan struct{})
	go func() {
		defer close(done)
		request := readRequest(t, bufio.NewReader(device))
		_, _ = device.Write([]byte("ESP-ROM:boot\r\n"))
		line := responseLine(request.ID, "result", "ok", `{"mode":"provisioning"}`)
		for index := range line {
			_, _ = device.Write([]byte{line[index]})
		}
	}()

	var result struct {
		Mode string `json:"mode"`
	}
	if err := client.Call(context.Background(), "hello", struct{}{}, &result); err != nil {
		t.Fatalf("Call() error = %v", err)
	}
	if result.Mode != "provisioning" {
		t.Fatalf("mode = %q", result.Mode)
	}
	<-done
}

func TestCallCorrelatesOutOfOrderResponses(t *testing.T) {
	client, device := newTestClient(t)
	reader := bufio.NewReader(device)
	requests := make(chan Request, 2)
	go func() {
		requests <- readRequest(t, reader)
		requests <- readRequest(t, reader)
		close(requests)
	}()

	type output struct {
		command string
		value   string
		err     error
	}
	outputs := make(chan output, 2)
	for _, command := range []string{"status", "doctor"} {
		command := command
		go func() {
			var result struct {
				Value string `json:"value"`
			}
			err := client.Call(context.Background(), command, struct{}{}, &result)
			outputs <- output{command: command, value: result.Value, err: err}
		}()
	}
	var captured []Request
	for request := range requests {
		captured = append(captured, request)
	}
	for index := len(captured) - 1; index >= 0; index-- {
		request := captured[index]
		_, _ = device.Write([]byte(responseLine(request.ID, "result", "ok", `{"value":"`+request.Command+`"}`)))
	}
	for range 2 {
		result := <-outputs
		if result.err != nil || result.value != result.command {
			t.Fatalf("Call(%q) = value %q, error %v", result.command, result.value, result.err)
		}
	}
}

func TestCallDeliversEvents(t *testing.T) {
	client, device := newTestClient(t)
	go func() {
		request := readRequest(t, bufio.NewReader(device))
		_, _ = device.Write([]byte(responseLine(request.ID, "event", "connecting", `{}`)))
		_, _ = device.Write([]byte(responseLine(request.ID, "result", "ok", `{}`)))
	}()
	if err := client.Call(context.Background(), "provision", struct{}{}, nil); err != nil {
		t.Fatalf("Call() error = %v", err)
	}
	select {
	case event := <-client.Events():
		if event.Code != "connecting" {
			t.Fatalf("event code = %q", event.Code)
		}
	case <-time.After(time.Second):
		t.Fatal("event was not delivered")
	}
}

func TestCallReceiptReturnsRoutingMetadataAndDeliversLaterResult(t *testing.T) {
	client, device := newTestClient(t)
	go func() {
		request := readRequest(t, bufio.NewReader(device))
		_, _ = device.Write([]byte(responseLine(request.ID, "result", "physical_confirmation_required", `{"pendingCount":2}`)))
		_, _ = device.Write([]byte(responseLine(request.ID, "result", "factory_reset_complete", `{}`)))
	}()
	var result struct {
		PendingCount int `json:"pendingCount"`
	}
	receipt, err := client.CallReceipt(context.Background(), "factory_reset", struct{}{}, &result)
	if err != nil {
		t.Fatalf("CallReceipt() error = %v", err)
	}
	if receipt.ID == "" || receipt.Code != "physical_confirmation_required" || result.PendingCount != 2 {
		t.Fatalf("receipt = %#v, result = %#v", receipt, result)
	}
	select {
	case event := <-client.Events():
		if event.ID != receipt.ID || event.Type != "result" || event.Code != "factory_reset_complete" {
			t.Fatalf("later response = %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("later result was not delivered")
	}
}

func TestCallRejectsMalformedOrUnknownResponseWithoutReflectingLine(t *testing.T) {
	for _, suffix := range []string{
		`{"v":1,"id":`,
		`{"v":1,"id":"ID","type":"result","code":"ok","message":"x","data":{},"secretMarker":"do-not-reflect"}`,
	} {
		t.Run(suffix[:min(12, len(suffix))], func(t *testing.T) {
			client, device := newTestClient(t)
			go func() {
				request := readRequest(t, bufio.NewReader(device))
				line := suffix
				if strings.Contains(line, `"ID"`) {
					line = strings.Replace(line, `"ID"`, `"`+request.ID+`"`, 1)
				}
				_, _ = device.Write([]byte(Prefix + line + "\n"))
			}()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			err := client.Call(ctx, "hello", struct{}{}, nil)
			if !errors.Is(err, ErrInvalidMessage) {
				t.Fatalf("Call() error = %v", err)
			}
			if strings.Contains(err.Error(), "do-not-reflect") {
				t.Fatal("error reflected rejected input")
			}
		})
	}
}

func TestCallHonorsContextCancellation(t *testing.T) {
	client, device := newTestClient(t)
	requestRead := make(chan struct{})
	go func() {
		_ = readRequest(t, bufio.NewReader(device))
		close(requestRead)
	}()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Call(ctx, "status", struct{}{}, nil) }()
	<-requestRead
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("Call() error = %v", err)
	}
}

func TestCallSurvivesReadTimeoutsAndHonorsDeadline(t *testing.T) {
	client, device := newTestClient(t)
	reader := bufio.NewReader(device)
	firstRead := make(chan struct{})
	go func() {
		_ = readRequest(t, reader)
		close(firstRead)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if err := client.Call(ctx, "status", struct{}{}, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timed Call() error = %v", err)
	}
	<-firstRead

	go func() {
		request := readRequest(t, reader)
		_, _ = device.Write([]byte(responseLine(request.ID, "result", "ok", `{}`)))
	}()
	if err := client.Call(context.Background(), "doctor", struct{}{}, nil); err != nil {
		t.Fatalf("Call() after read timeouts error = %v", err)
	}
}

func TestCallRejectsOversizedPrefixedLine(t *testing.T) {
	client, device := newTestClient(t)
	go func() {
		_ = readRequest(t, bufio.NewReader(device))
		_, _ = device.Write([]byte(Prefix + strings.Repeat("x", MaxMessageBytes) + "\n"))
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := client.Call(ctx, "status", struct{}{}, nil); !errors.Is(err, ErrMessageTooLarge) {
		t.Fatalf("Call() error = %v", err)
	}
}

func TestConcurrentCloseIsIdempotent(t *testing.T) {
	client, device := newTestClient(t)
	_ = device
	var wait sync.WaitGroup
	for range 8 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_ = client.Close()
		}()
	}
	wait.Wait()
	if err := client.Call(context.Background(), "status", struct{}{}, nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("Call() after Close error = %v", err)
	}
}

type controlledTransport struct {
	mu           sync.Mutex
	writes       int
	closes       int
	failWriteAt  int
	blockWrites  bool
	writeStarted chan int
	closed       chan struct{}
	closeOnce    sync.Once
}

func newControlledTransport() *controlledTransport {
	return &controlledTransport{writeStarted: make(chan int, 8), closed: make(chan struct{})}
}

func (transport *controlledTransport) Read([]byte) (int, error) {
	<-transport.closed
	return 0, io.EOF
}

func (transport *controlledTransport) Write(data []byte) (int, error) {
	transport.mu.Lock()
	transport.writes++
	writeNumber := transport.writes
	transport.mu.Unlock()
	transport.writeStarted <- writeNumber
	if transport.blockWrites {
		<-transport.closed
		return 0, errors.New("write interrupted")
	}
	if transport.failWriteAt == writeNumber {
		return 0, errors.New("write failed")
	}
	return len(data), nil
}

func (transport *controlledTransport) Close() error {
	transport.mu.Lock()
	transport.closes++
	transport.mu.Unlock()
	transport.closeOnce.Do(func() { close(transport.closed) })
	return nil
}

func (transport *controlledTransport) closeCount() int {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	return transport.closes
}

func (transport *controlledTransport) SetReadTimeout(time.Duration) error { return nil }

func (transport *controlledTransport) writeCount() int {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	return transport.writes
}

func TestCloseInterruptsBlockedWrite(t *testing.T) {
	transport := newControlledTransport()
	transport.blockWrites = true
	client, err := NewClient(transport)
	if err != nil {
		t.Fatal(err)
	}
	callDone := make(chan error, 1)
	go func() { callDone <- client.Call(context.Background(), "status", struct{}{}, nil) }()
	<-transport.writeStarted

	closeDone := make(chan error, 1)
	go func() { closeDone <- client.Close() }()
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatalf("Close() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Close blocked behind Write")
	}
	select {
	case err := <-callDone:
		if !errors.Is(err, ErrTransport) && !errors.Is(err, ErrClosed) {
			t.Fatalf("blocked Call() error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked Call did not return")
	}
}

func TestCancelledCallWaitingForWriterDoesNotTransmit(t *testing.T) {
	transport := newControlledTransport()
	transport.blockWrites = true
	client, err := NewClient(transport)
	if err != nil {
		t.Fatal(err)
	}
	firstDone := make(chan error, 1)
	go func() { firstDone <- client.Call(context.Background(), "status", struct{}{}, nil) }()
	<-transport.writeStarted

	ctx, cancel := context.WithCancel(context.Background())
	secondDone := make(chan error, 1)
	go func() { secondDone <- client.Call(ctx, "doctor", struct{}{}, nil) }()
	time.Sleep(10 * time.Millisecond)
	cancel()
	_ = client.Close()
	<-firstDone
	if err := <-secondDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled Call() error = %v", err)
	}
	if writes := transport.writeCount(); writes != 1 {
		t.Fatalf("writes = %d, want 1", writes)
	}
}

func TestWriteFailureFailsAllPendingCalls(t *testing.T) {
	transport := newControlledTransport()
	transport.failWriteAt = 2
	client, err := NewClient(transport)
	if err != nil {
		t.Fatal(err)
	}
	firstDone := make(chan error, 1)
	go func() { firstDone <- client.Call(context.Background(), "status", struct{}{}, nil) }()
	<-transport.writeStarted
	secondDone := make(chan error, 1)
	go func() { secondDone <- client.Call(context.Background(), "doctor", struct{}{}, nil) }()
	<-transport.writeStarted
	for _, done := range []chan error{firstDone, secondDone} {
		select {
		case err := <-done:
			if !errors.Is(err, ErrTransport) {
				t.Fatalf("Call() error = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("pending Call was not released")
		}
	}
	_ = client.Close()
	if closes := transport.closeCount(); closes != 1 {
		t.Fatalf("transport closes = %d, want 1", closes)
	}
}

func helloData(capabilities string) string {
	return `{"protocolVersion":1,"board":"m5stack-basic-core-v27","firmwareVersion":"1.2.3","mode":"ready","capabilities":` + capabilities + `}`
}

const completeCapabilities = `{"status":true,"doctor":true,"structuredLogs":true,"reboot":true,"physicalFactoryReset":true,"provisioningRecovery":true,"firmwareInstall":true,"negotiatedBaud":true}`

func TestProbeIgnoresResidualResponsesAndEvents(t *testing.T) {
	clientSide, deviceSide := net.Pipe()
	defer deviceSide.Close()
	transport := &testTransport{Conn: clientSide}
	go func() {
		request := readRequest(t, bufio.NewReader(deviceSide))
		foreignID := base64.RawURLEncoding.EncodeToString(make([]byte, 16))
		_, _ = deviceSide.Write([]byte(responseLine(foreignID, "result", "ok", `{}`)))
		_, _ = deviceSide.Write([]byte(responseLine(request.ID, "event", "connecting", `{}`)))
		_, _ = deviceSide.Write([]byte(responseLine(request.ID, "result", "ok", helloData(completeCapabilities))))
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	hello, err := Probe(ctx, transport)
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if hello.Mode != "ready" || !hello.Capabilities.FirmwareInstall {
		t.Fatalf("Probe() hello = %#v", hello)
	}
	_ = transport.Close()
}

func TestProbeRejectsIncompleteOrMistypedCapabilities(t *testing.T) {
	validWithoutLast := `{"status":true,"doctor":true,"structuredLogs":true,"reboot":true,"physicalFactoryReset":true,"provisioningRecovery":true,"firmwareInstall":true}`
	cases := map[string]string{
		"missing":     validWithoutLast,
		"null":        strings.Replace(completeCapabilities, `"status":true`, `"status":null`, 1),
		"extra":       strings.TrimSuffix(completeCapabilities, "}") + `,"unexpected":false}`,
		"object null": `null`,
		"string":      strings.Replace(completeCapabilities, `"status":true`, `"status":"true"`, 1),
	}
	for name, capabilities := range cases {
		t.Run(name, func(t *testing.T) {
			clientSide, deviceSide := net.Pipe()
			transport := &testTransport{Conn: clientSide}
			go func() {
				request := readRequest(t, bufio.NewReader(deviceSide))
				_, _ = deviceSide.Write([]byte(responseLine(request.ID, "result", "ok", helloData(capabilities))))
			}()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, err := Probe(ctx, transport)
			if !errors.Is(err, ErrHandshake) {
				t.Fatalf("Probe() error = %v", err)
			}
			_ = transport.Close()
			_ = deviceSide.Close()
		})
	}
}

func TestProbeRejectsUnknownHelloField(t *testing.T) {
	data := strings.TrimSuffix(helloData(completeCapabilities), "}") + `,"extra":false}`
	clientSide, deviceSide := net.Pipe()
	transport := &testTransport{Conn: clientSide}
	go func() {
		request := readRequest(t, bufio.NewReader(deviceSide))
		_, _ = deviceSide.Write([]byte(responseLine(request.ID, "result", "ok", data)))
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := Probe(ctx, transport)
	if !errors.Is(err, ErrHandshake) {
		t.Fatalf("Probe() error = %v", err)
	}
	_ = transport.Close()
	_ = deviceSide.Close()
}
