package protocol

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"time"
	"unicode/utf8"

	"go.bug.st/serial"
)

const readPollInterval = 25 * time.Millisecond

type Transport interface {
	io.ReadWriteCloser
	SetReadTimeout(time.Duration) error
}

type modeTransport interface {
	SetMode(*serial.Mode) error
}

type callResult struct {
	response response
	err      error
}

type Client struct {
	port          Transport
	ctx           context.Context
	cancel        context.CancelFunc
	writeMu       sync.Mutex
	mu            sync.Mutex
	pending       map[string]chan callResult
	closed        bool
	terminal      error
	events        chan Event
	done          chan struct{}
	closeOnce     sync.Once
	closeErr      error
	portCloseOnce sync.Once
	portCloseErr  error
}

func NewClient(port Transport) (*Client, error) {
	if port == nil {
		return nil, ErrTransport
	}
	if err := port.SetReadTimeout(readPollInterval); err != nil {
		return nil, ErrTransport
	}
	ctx, cancel := context.WithCancel(context.Background())
	client := &Client{
		port: port, ctx: ctx, cancel: cancel,
		pending: make(map[string]chan callResult),
		events:  make(chan Event, 64), done: make(chan struct{}),
	}
	go client.readLoop()
	return client, nil
}

func (client *Client) Events() <-chan Event { return client.events }

// WriteBinary writes one complete OJFW frame without allowing control writes
// to interleave with it.
func (client *Client) WriteBinary(ctx context.Context, frame []byte) error {
	if ctx == nil {
		ctx = context.Background()
	}
	client.writeMu.Lock()
	defer client.writeMu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	client.mu.Lock()
	closed := client.closed
	client.mu.Unlock()
	if closed {
		return ErrClosed
	}
	completed := make(chan error, 1)
	go func() {
		_, err := writeAll(client.port, frame)
		completed <- err
	}()
	select {
	case err := <-completed:
		if err == nil {
			return nil
		}
		client.stop(ErrTransport)
		_ = client.closePort()
		return ErrTransport
	case <-ctx.Done():
		client.stop(ErrTransport)
		_ = client.closePort()
		// Closing a serial transport releases its pending write. Waiting here
		// prevents a frame goroutine from surviving the owning Client.
		<-completed
		return ctx.Err()
	}
}

// SetBaud updates the local serial endpoint while retaining 8-N-1 framing.
func (client *Client) SetBaud(baud int) error {
	if baud != 115200 && baud != 460800 {
		return ErrTransport
	}
	setter, ok := client.port.(modeTransport)
	if !ok {
		return ErrTransport
	}
	client.writeMu.Lock()
	defer client.writeMu.Unlock()
	if err := setter.SetMode(&serial.Mode{BaudRate: baud, DataBits: 8, Parity: serial.NoParity, StopBits: serial.OneStopBit}); err != nil {
		return ErrTransport
	}
	return nil
}

func (client *Client) Call(ctx context.Context, command string, payload any, result any) error {
	_, err := client.CallReceipt(ctx, command, payload, result)
	return err
}

// CallReceipt performs a call and retains its safe response ID and code so a
// caller can correlate later responses from a multi-stage operation.
func (client *Client) CallReceipt(ctx context.Context, command string, payload any, result any) (Receipt, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-ctx.Done():
		return Receipt{}, ctx.Err()
	default:
	}
	if !safeToken(command) {
		return Receipt{}, ErrInvalidMessage
	}
	id, err := randomID()
	if err != nil {
		return Receipt{}, ErrTransport
	}
	wire, err := encodeRequest(Request{Version: 1, ID: id, Command: command, Payload: payload})
	if err != nil {
		return Receipt{}, err
	}
	waiter := make(chan callResult, 1)
	client.mu.Lock()
	if client.closed {
		err := client.terminal
		if err == nil {
			err = ErrClosed
		}
		client.mu.Unlock()
		return Receipt{}, err
	}
	client.pending[id] = waiter
	client.mu.Unlock()

	client.writeMu.Lock()
	select {
	case <-ctx.Done():
		client.writeMu.Unlock()
		client.removePending(id)
		return Receipt{}, ctx.Err()
	default:
	}
	client.mu.Lock()
	closed := client.closed
	terminal := client.terminal
	client.mu.Unlock()
	if closed {
		client.writeMu.Unlock()
		client.removePending(id)
		if terminal == nil {
			terminal = ErrClosed
		}
		return Receipt{}, terminal
	}
	_, writeErr := writeAll(client.port, wire)
	client.writeMu.Unlock()
	if writeErr != nil {
		client.stop(ErrTransport)
		_ = client.closePort()
		return Receipt{}, ErrTransport
	}

	select {
	case received := <-waiter:
		if received.err != nil {
			return Receipt{}, received.err
		}
		if received.response.Type == "error" {
			return Receipt{}, &DeviceError{Code: received.response.Code}
		}
		if received.response.Type != "result" {
			return Receipt{}, ErrInvalidMessage
		}
		receipt := Receipt{ID: received.response.ID, Code: received.response.Code}
		if result == nil {
			return receipt, nil
		}
		if err := decodeStrict(received.response.Data, result); err != nil {
			return Receipt{}, ErrInvalidMessage
		}
		return receipt, nil
	case <-ctx.Done():
		client.removePending(id)
		return Receipt{}, ctx.Err()
	case <-client.ctx.Done():
		client.removePending(id)
		client.mu.Lock()
		err := client.terminal
		client.mu.Unlock()
		if err == nil {
			err = ErrClosed
		}
		return Receipt{}, err
	}
}

func (client *Client) Close() error {
	client.closeOnce.Do(func() {
		client.stop(ErrClosed)
		client.closeErr = client.closePort()
		<-client.done
	})
	return client.closeErr
}

func (client *Client) readLoop() {
	defer close(client.done)
	defer close(client.events)
	line := make([]byte, 0, MaxMessageBytes)
	overflow := false
	prefixed := false
	buffer := make([]byte, 256)
	for {
		n, err := client.port.Read(buffer)
		for _, value := range buffer[:n] {
			if value == '\n' {
				if overflow {
					if prefixed {
						client.failPending(ErrMessageTooLarge)
					}
				} else {
					client.processLine(line)
				}
				line = line[:0]
				overflow = false
				prefixed = false
				continue
			}
			if overflow {
				continue
			}
			if len(line) >= MaxMessageBytes-1 {
				overflow = true
				continue
			}
			line = append(line, value)
			if len(line) == len(Prefix) {
				prefixed = bytes.Equal(line, []byte(Prefix))
			}
		}
		if err != nil {
			if isTimeout(err) {
				continue
			}
			if client.ctx.Err() == nil {
				client.stop(ErrTransport)
				_ = client.closePort()
			}
			return
		}
		select {
		case <-client.ctx.Done():
			return
		default:
		}
	}
}

func (client *Client) closePort() error {
	client.portCloseOnce.Do(func() {
		client.portCloseErr = client.port.Close()
	})
	return client.portCloseErr
}

func (client *Client) processLine(line []byte) {
	line = bytes.TrimSuffix(line, []byte{'\r'})
	if !bytes.HasPrefix(line, []byte(Prefix)) {
		return
	}
	parsed, err := parseResponse(line[len(Prefix):])
	if err != nil {
		client.failPending(err)
		return
	}
	if parsed.Type == "event" {
		event := Event{ID: parsed.ID, Type: parsed.Type, Code: parsed.Code, Message: parsed.Message, Data: bytes.Clone(parsed.Data)}
		select {
		case client.events <- event:
		default:
		}
		return
	}
	client.mu.Lock()
	waiter := client.pending[parsed.ID]
	delete(client.pending, parsed.ID)
	client.mu.Unlock()
	if waiter != nil {
		waiter <- callResult{response: parsed}
		return
	}
	event := Event{ID: parsed.ID, Type: parsed.Type, Code: parsed.Code, Message: parsed.Message, Data: bytes.Clone(parsed.Data)}
	select {
	case client.events <- event:
	default:
	}
}

func (client *Client) removePending(id string) {
	client.mu.Lock()
	delete(client.pending, id)
	client.mu.Unlock()
}

func (client *Client) failPending(err error) {
	client.mu.Lock()
	waiters := make([]chan callResult, 0, len(client.pending))
	for id, waiter := range client.pending {
		delete(client.pending, id)
		waiters = append(waiters, waiter)
	}
	client.mu.Unlock()
	for _, waiter := range waiters {
		waiter <- callResult{err: err}
	}
}

func (client *Client) stop(err error) {
	client.mu.Lock()
	if client.closed {
		client.mu.Unlock()
		return
	}
	client.closed = true
	client.terminal = err
	client.mu.Unlock()
	client.failPending(err)
	client.cancel()
}

func Probe(ctx context.Context, port Transport) (Hello, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := port.SetReadTimeout(readPollInterval); err != nil {
		return Hello{}, ErrHandshake
	}
	id, err := randomID()
	if err != nil {
		return Hello{}, ErrHandshake
	}
	wire, err := encodeRequest(Request{Version: 1, ID: id, Command: "hello", Payload: struct{}{}})
	if err != nil {
		return Hello{}, ErrHandshake
	}
	if _, err := writeAll(port, wire); err != nil {
		return Hello{}, ErrHandshake
	}
	for {
		line, err := readFramedLine(ctx, port)
		if err != nil {
			return Hello{}, ErrHandshake
		}
		parsed, err := parseResponse(line)
		if err != nil {
			return Hello{}, ErrHandshake
		}
		if parsed.ID != id || parsed.Type == "event" {
			continue
		}
		if parsed.Type != "result" || parsed.Code != "ok" {
			return Hello{}, ErrHandshake
		}
		var hello Hello
		if err := decodeHello(parsed.Data, &hello); err != nil || !validHello(hello) {
			return Hello{}, ErrHandshake
		}
		return hello, nil
	}
}

func readFramedLine(ctx context.Context, port Transport) ([]byte, error) {
	line := make([]byte, 0, MaxMessageBytes)
	overflow := false
	prefixed := false
	buffer := make([]byte, 128)
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		n, err := port.Read(buffer)
		for _, value := range buffer[:n] {
			if value == '\n' {
				if overflow {
					if prefixed {
						return nil, ErrMessageTooLarge
					}
					line = line[:0]
					overflow, prefixed = false, false
					continue
				}
				candidate := bytes.TrimSuffix(line, []byte{'\r'})
				if bytes.HasPrefix(candidate, []byte(Prefix)) {
					return bytes.Clone(candidate[len(Prefix):]), nil
				}
				line = line[:0]
				prefixed = false
				continue
			}
			if overflow {
				continue
			}
			if len(line) >= MaxMessageBytes-1 {
				overflow = true
				continue
			}
			line = append(line, value)
			if len(line) == len(Prefix) {
				prefixed = bytes.Equal(line, []byte(Prefix))
			}
		}
		if err != nil && !isTimeout(err) {
			return nil, err
		}
	}
}

func encodeRequest(request Request) ([]byte, error) {
	encoded, err := json.Marshal(request)
	if err != nil {
		return nil, ErrInvalidMessage
	}
	wire := make([]byte, 0, len(Prefix)+len(encoded)+1)
	wire = append(wire, Prefix...)
	wire = append(wire, encoded...)
	wire = append(wire, '\n')
	if len(wire) > MaxMessageBytes {
		return nil, ErrMessageTooLarge
	}
	return wire, nil
}

func parseResponse(data []byte) (response, error) {
	if len(data) == 0 || !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return response{}, ErrInvalidMessage
	}
	if err := rejectDuplicateKeys(data); err != nil {
		return response{}, ErrInvalidMessage
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || len(fields) != 6 {
		return response{}, ErrInvalidMessage
	}
	for _, required := range []string{"v", "id", "type", "code", "message", "data"} {
		if _, ok := fields[required]; !ok {
			return response{}, ErrInvalidMessage
		}
	}
	var parsed response
	if err := decodeStrict(data, &parsed); err != nil || parsed.Version != 1 || !validID(parsed.ID) || !safeToken(parsed.Code) {
		return response{}, ErrInvalidMessage
	}
	if parsed.Type != "result" && parsed.Type != "error" && parsed.Type != "event" {
		return response{}, ErrInvalidMessage
	}
	return parsed, nil
}

func decodeStrict(data []byte, destination any) error {
	if err := rejectDuplicateKeys(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidMessage
	}
	return nil
}

func decodeHello(data []byte, hello *Hello) error {
	fields, err := exactObject(data, []string{"protocolVersion", "board", "firmwareVersion", "mode", "capabilities"})
	if err != nil {
		return err
	}
	capabilityNames := []string{
		"status", "doctor", "structuredLogs", "reboot", "physicalFactoryReset",
		"provisioningRecovery", "firmwareInstall", "negotiatedBaud",
	}
	capabilities, err := exactObject(fields["capabilities"], capabilityNames)
	if err != nil {
		return err
	}
	for _, name := range capabilityNames {
		if !bytes.Equal(capabilities[name], []byte("true")) && !bytes.Equal(capabilities[name], []byte("false")) {
			return ErrInvalidMessage
		}
	}
	return decodeStrict(data, hello)
}

func exactObject(data []byte, expected []string) (map[string]json.RawMessage, error) {
	if err := rejectDuplicateKeys(data); err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil || len(fields) != len(expected) {
		return nil, ErrInvalidMessage
	}
	for _, name := range expected {
		if _, exists := fields[name]; !exists {
			return nil, ErrInvalidMessage
		}
	}
	return fields, nil
}

func rejectDuplicateKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var walk func() error
	walk = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			seen := make(map[string]struct{})
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return ErrInvalidMessage
				}
				if _, duplicate := seen[key]; duplicate {
					return ErrInvalidMessage
				}
				seen[key] = struct{}{}
				if err := walk(); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim('}') {
				return ErrInvalidMessage
			}
		case '[':
			for decoder.More() {
				if err := walk(); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim(']') {
				return ErrInvalidMessage
			}
		default:
			return ErrInvalidMessage
		}
		return nil
	}
	if err := walk(); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalidMessage
	}
	return nil
}

func randomID() (string, error) {
	raw := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func validID(id string) bool {
	raw, err := base64.RawURLEncoding.Strict().DecodeString(id)
	return err == nil && len(raw) == 16 && base64.RawURLEncoding.EncodeToString(raw) == id
}

func safeToken(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '_' {
			return false
		}
	}
	return true
}

func validHello(hello Hello) bool {
	if hello.ProtocolVersion != 1 || hello.Board == "" || hello.FirmwareVersion == "" {
		return false
	}
	switch hello.Mode {
	case "booting", "ready", "blocked", "provisioning", "updating", "await_physical_confirmation":
		return true
	default:
		return false
	}
}

func writeAll(writer io.Writer, data []byte) (int, error) {
	written := 0
	for written < len(data) {
		n, err := writer.Write(data[written:])
		written += n
		if err != nil {
			return written, err
		}
		if n == 0 {
			return written, io.ErrNoProgress
		}
	}
	return written, nil
}

func isTimeout(err error) bool {
	var networkError net.Error
	return errors.As(err, &networkError) && networkError.Timeout()
}
