package update

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/crc32"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/protocol"
	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/release"
)

type memoryTransferClient struct {
	mu           sync.Mutex
	events       chan protocol.Event
	commands     []string
	frames       [][]byte
	bauds        []int
	payloads     []any
	beginCode    string
	retryAlways  bool
	noAck        bool
	failHighBaud bool
	ackDelay     time.Duration
}

func newMemoryTransferClient() *memoryTransferClient {
	return &memoryTransferClient{events: make(chan protocol.Event, 32)}
}

func (client *memoryTransferClient) CallReceipt(_ context.Context, command string, payload any, _ any) (protocol.Receipt, error) {
	client.mu.Lock()
	client.commands = append(client.commands, command)
	client.payloads = append(client.payloads, payload)
	client.mu.Unlock()
	code := map[string]string{"firmware_begin": "firmware_accepted", "set_baud": "baud_accepted", "baud_ready": "baud_ready", "firmware_commit": "rebooting", "cancel": "cancelled"}[command]
	if command == "firmware_begin" && client.beginCode != "" {
		code = client.beginCode
	}
	return protocol.Receipt{ID: "AAAAAAAAAAAAAAAAAAAAAA", Code: code}, nil
}

func (client *memoryTransferClient) Events() <-chan protocol.Event { return client.events }
func (client *memoryTransferClient) SetBaud(baud int) error {
	client.mu.Lock()
	client.bauds = append(client.bauds, baud)
	fail := baud == transferBaud && client.failHighBaud
	client.mu.Unlock()
	if fail {
		client.events <- protocol.Event{ID: "AAAAAAAAAAAAAAAAAAAAAA", Type: "event", Code: "baud_fallback", Data: []byte(`{}`)}
		return errors.New("unsupported baud")
	}
	return nil
}

func (client *memoryTransferClient) WriteBinary(_ context.Context, frame []byte) error {
	client.mu.Lock()
	client.frames = append(client.frames, append([]byte(nil), frame...))
	retry := client.retryAlways
	noAck := client.noAck
	delay := client.ackDelay
	client.mu.Unlock()
	if noAck {
		return nil
	}
	offset := binary.LittleEndian.Uint32(frame[4:8])
	length := binary.LittleEndian.Uint16(frame[8:10])
	next := offset + uint32(length)
	code := "firmware_ack"
	if retry {
		code = "firmware_retry"
		next = offset
	}
	data, _ := json.Marshal(struct {
		NextOffset uint32 `json:"nextOffset"`
	}{next})
	event := protocol.Event{ID: "AAAAAAAAAAAAAAAAAAAAAA", Type: "event", Code: code, Data: data}
	if delay > 0 {
		time.AfterFunc(delay, func() { client.events <- event })
	} else {
		client.events <- event
	}
	return nil
}

func transferFixture(t *testing.T, size int) release.VerifiedFirmware {
	t.Helper()
	contents := make([]byte, size)
	for index := range contents {
		contents[index] = byte(index * 31)
	}
	path := filepath.Join(t.TempDir(), "fixture.bin")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	return release.VerifiedFirmware{Path: path, Size: uint32(size), SHA256: [32]byte{0xaa}, Version: "2.0.0", Official: false}
}

func TestTransferFramesLittleEndianAndCommits(t *testing.T) {
	client := newMemoryTransferClient()
	firmware := transferFixture(t, framePayloadBytes*2+17)
	var progress []uint32
	err := transferWithOptions(context.Background(), client, firmware, func(done, _ uint32) { progress = append(progress, done) }, transferOptions{ackTimeout: time.Second})
	if err != nil {
		t.Fatalf("Transfer() error = %v", err)
	}
	if len(client.frames) != 3 {
		t.Fatalf("frames = %d", len(client.frames))
	}
	for index, frame := range client.frames {
		if string(frame[:4]) != "OJFW" {
			t.Fatalf("frame %d magic = %q", index, frame[:4])
		}
		offset := binary.LittleEndian.Uint32(frame[4:8])
		length := binary.LittleEndian.Uint16(frame[8:10])
		if offset != uint32(index*framePayloadBytes) || int(length) > framePayloadBytes || len(frame) != frameHeaderBytes+int(length) {
			t.Fatalf("frame %d offset=%d length=%d bytes=%d", index, offset, length, len(frame))
		}
		if got, want := binary.LittleEndian.Uint32(frame[10:14]), crc32.ChecksumIEEE(frame[14:]); got != want {
			t.Fatalf("frame %d crc=%08x want=%08x", index, got, want)
		}
	}
	if got := strings.Join(client.commands, ","); got != "firmware_begin,set_baud,baud_ready,firmware_commit" {
		t.Fatalf("commands = %s", got)
	}
	if len(client.bauds) != 1 || client.bauds[0] != transferBaud {
		t.Fatalf("bauds = %v", client.bauds)
	}
	if len(progress) == 0 || progress[len(progress)-1] != firmware.Size {
		t.Fatalf("progress = %v", progress)
	}
}

func TestTransferStopsAfterThreeRetriesOfSameFrame(t *testing.T) {
	client := newMemoryTransferClient()
	client.retryAlways = true
	firmware := transferFixture(t, 32)
	err := transferWithOptions(context.Background(), client, firmware, nil, transferOptions{ackTimeout: time.Second})
	if err == nil || len(client.frames) != 4 {
		t.Fatalf("error=%v writes=%d", err, len(client.frames))
	}
	if strings.Contains(err.Error(), "aa") || strings.Contains(err.Error(), firmware.Path) {
		t.Fatalf("unsafe error = %v", err)
	}
}

func TestTransferRetryDoesNotResetProgressDeadline(t *testing.T) {
	client := newMemoryTransferClient()
	client.retryAlways = true
	client.ackDelay = 20 * time.Millisecond
	started := time.Now()
	err := transferWithOptions(context.Background(), client, transferFixture(t, 32), nil, transferOptions{ackTimeout: 45 * time.Millisecond})
	if err == nil {
		t.Fatal("Transfer() succeeded")
	}
	if elapsed := time.Since(started); elapsed >= 80*time.Millisecond {
		t.Fatalf("retry reset the progress deadline: elapsed=%v", elapsed)
	}
}

func TestTransferProgressIsRenderedAtMostTenTimesPerSecond(t *testing.T) {
	client := newMemoryTransferClient()
	client.ackDelay = 60 * time.Millisecond
	firmware := transferFixture(t, framePayloadBytes*3)
	var rendered []time.Time
	if err := transferWithOptions(context.Background(), client, firmware, func(uint32, uint32) {
		rendered = append(rendered, time.Now())
	}, transferOptions{ackTimeout: time.Second}); err != nil {
		t.Fatal(err)
	}
	if len(rendered) < 2 {
		t.Fatalf("renders = %d", len(rendered))
	}
	for index := 1; index < len(rendered); index++ {
		if interval := rendered[index].Sub(rendered[index-1]); interval < 100*time.Millisecond {
			t.Fatalf("render interval = %v", interval)
		}
	}
}

func TestTransferSendsOfficialManifestAndSignature(t *testing.T) {
	client := newMemoryTransferClient()
	firmware := transferFixture(t, 32)
	firmware.Official = true
	firmware.Manifest = []byte("signed manifest\n")
	firmware.Signature = []byte("encoded-signature")
	if err := transferWithOptions(context.Background(), client, firmware, nil, transferOptions{ackTimeout: time.Second}); err != nil {
		t.Fatal(err)
	}
	payload, ok := client.payloads[0].(map[string]any)
	if !ok || payload["official"] != true || payload["manifest"] != "signed manifest\n" || payload["signature"] != "encoded-signature" {
		t.Fatalf("firmware_begin payload = %#v", client.payloads[0])
	}
}

func TestTransferWaitsForPhysicalConfirmationBeforeFirmwareBytes(t *testing.T) {
	client := newMemoryTransferClient()
	client.beginCode = "physical_confirmation_required"
	firmware := transferFixture(t, 32)
	done := make(chan error, 1)
	go func() {
		done <- transferWithOptions(context.Background(), client, firmware, nil, transferOptions{ackTimeout: time.Second, confirmationTimeout: time.Second})
	}()
	time.Sleep(10 * time.Millisecond)
	client.mu.Lock()
	writesBeforeConfirmation := len(client.frames)
	client.mu.Unlock()
	if writesBeforeConfirmation != 0 {
		t.Fatalf("frames before confirmation = %d", writesBeforeConfirmation)
	}
	client.events <- protocol.Event{ID: "AAAAAAAAAAAAAAAAAAAAAA", Type: "result", Code: "firmware_accepted", Data: []byte(`{}`)}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestTransferFallsBackOnceToDefaultBaud(t *testing.T) {
	client := newMemoryTransferClient()
	client.failHighBaud = true
	if err := transferWithOptions(context.Background(), client, transferFixture(t, 32), nil, transferOptions{ackTimeout: time.Second}); err != nil {
		t.Fatal(err)
	}
	if len(client.bauds) != 2 || client.bauds[0] != transferBaud || client.bauds[1] != defaultBaud {
		t.Fatalf("bauds = %v", client.bauds)
	}
	if strings.Contains(strings.Join(client.commands, ","), "baud_ready") {
		t.Fatalf("commands = %v", client.commands)
	}
}

func TestTransferCancelsOnProgressTimeoutAndContextCancellation(t *testing.T) {
	for _, test := range []struct {
		name string
		ctx  func() (context.Context, context.CancelFunc)
	}{
		{"timeout", func() (context.Context, context.CancelFunc) { return context.WithCancel(context.Background()) }},
		{"context", func() (context.Context, context.CancelFunc) { return context.WithCancel(context.Background()) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := newMemoryTransferClient()
			client.noAck = true
			ctx, cancel := test.ctx()
			defer cancel()
			if test.name == "context" {
				time.AfterFunc(10*time.Millisecond, cancel)
			}
			err := transferWithOptions(ctx, client, transferFixture(t, 32), nil, transferOptions{ackTimeout: 25 * time.Millisecond})
			if err == nil {
				t.Fatal("Transfer() succeeded")
			}
			if got := client.commands[len(client.commands)-1]; got != "cancel" {
				t.Fatalf("last command = %s", got)
			}
		})
	}
}
