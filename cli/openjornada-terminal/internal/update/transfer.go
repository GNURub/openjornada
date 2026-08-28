package update

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash/crc32"
	"io"
	"os"
	"time"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/protocol"
	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/release"
)

const (
	frameHeaderBytes  = 14
	framePayloadBytes = 2048
	transferBaud      = 460800
	defaultBaud       = 115200
	maxFrameRetries   = 3
)

var (
	ErrTransfer       = errors.New("update: firmware transfer failed")
	ErrTransferPolicy = errors.New("update: firmware transfer rejected")
)

type Client interface {
	CallReceipt(context.Context, string, any, any) (protocol.Receipt, error)
	Events() <-chan protocol.Event
	WriteBinary(context.Context, []byte) error
	SetBaud(int) error
}

type ProgressFunc func(completed, total uint32)

type transferOptions struct {
	ackTimeout          time.Duration
	confirmationTimeout time.Duration
	baudSettle          time.Duration
}

// Transfer negotiates OJUSB control state, sends bounded OJFW frames and
// commits only after every acknowledged byte. Errors contain no image data.
func Transfer(ctx context.Context, client Client, firmware release.VerifiedFirmware, progress ProgressFunc) error {
	return transferWithOptions(ctx, client, firmware, progress, transferOptions{
		ackTimeout: 5 * time.Second, confirmationTimeout: 30 * time.Second,
		baudSettle: 125 * time.Millisecond,
	})
}

func transferWithOptions(ctx context.Context, client Client, firmware release.VerifiedFirmware, progress ProgressFunc, options transferOptions) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if client == nil || firmware.Size == 0 || firmware.Path == "" || !validSemanticVersion(firmware.Version) {
		return ErrTransfer
	}
	if options.ackTimeout <= 0 {
		options.ackTimeout = 5 * time.Second
	}
	if options.confirmationTimeout <= 0 {
		options.confirmationTimeout = 30 * time.Second
	}

	beginCtx, stopBegin := context.WithTimeout(ctx, 5*time.Second)
	receipt, err := client.CallReceipt(beginCtx, "firmware_begin", firmwareIntent(firmware), nil)
	stopBegin()
	if err != nil {
		return safeTransferError(err)
	}
	switch receipt.Code {
	case "firmware_accepted":
	case "physical_confirmation_required":
		waitCtx, cancel := context.WithTimeout(ctx, options.confirmationTimeout)
		err = waitForAccepted(waitCtx, client.Events(), receipt.ID)
		cancel()
		if err != nil {
			abortTransfer(client)
			return safeTransferError(err)
		}
	default:
		return ErrTransferPolicy
	}
	if err := negotiateBaud(ctx, client, receipt.ID, options.baudSettle); err != nil {
		abortTransfer(client)
		return safeTransferError(err)
	}

	reporter := progressReporter{callback: progress}
	lastProgressAt := time.Time{}
	for offset := uint32(0); offset < firmware.Size; {
		payload, err := readPayload(firmware.Path, offset, firmware.Size)
		if err != nil {
			abortTransfer(client)
			return ErrTransfer
		}
		frame := encodeFrame(offset, payload)
		if lastProgressAt.IsZero() {
			lastProgressAt = time.Now()
		}
		acknowledged := false
		progressDeadline := lastProgressAt.Add(options.ackTimeout)
		for attempt := 0; attempt <= maxFrameRetries; attempt++ {
			writeCtx, stopWrite := context.WithDeadline(ctx, progressDeadline)
			writeErr := client.WriteBinary(writeCtx, frame)
			stopWrite()
			if writeErr != nil {
				abortTransfer(client)
				return safeTransferError(writeErr)
			}
			ackCtx, cancel := context.WithDeadline(ctx, progressDeadline)
			next, retry, err := waitForAcknowledgement(ackCtx, client.Events(), receipt.ID, offset, uint32(len(payload)))
			cancel()
			if err != nil {
				abortTransfer(client)
				return safeTransferError(err)
			}
			if retry {
				continue
			}
			offset = next
			acknowledged = true
			lastProgressAt = time.Now()
			if err := reporter.report(ctx, offset, firmware.Size); err != nil {
				abortTransfer(client)
				return safeTransferError(err)
			}
			break
		}
		if !acknowledged {
			abortTransfer(client)
			return ErrTransfer
		}
	}
	commitCtx, stopCommit := context.WithTimeout(ctx, 5*time.Second)
	commit, err := client.CallReceipt(commitCtx, "firmware_commit", struct{}{}, nil)
	stopCommit()
	if err != nil || commit.Code != "rebooting" {
		abortTransfer(client)
		return safeTransferError(err)
	}
	return nil
}

type progressReporter struct {
	callback ProgressFunc
	last     time.Time
	reported bool
}

func (reporter *progressReporter) report(ctx context.Context, completed, total uint32) error {
	if reporter.callback == nil {
		return nil
	}
	now := time.Now()
	if reporter.reported {
		remaining := 100*time.Millisecond - now.Sub(reporter.last)
		if remaining > 0 {
			if completed != total {
				return nil
			}
			timer := time.NewTimer(remaining)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
			}
		}
	}
	reporter.callback(completed, total)
	reporter.last = time.Now()
	reporter.reported = true
	return nil
}

func firmwareIntent(firmware release.VerifiedFirmware) map[string]any {
	payload := map[string]any{
		"size": firmware.Size, "sha256": hex.EncodeToString(firmware.SHA256[:]),
		"version": firmware.Version, "board": firmwareBoard,
		"protocolVersion": firmwareProtocol, "official": firmware.Official,
	}
	if firmware.Official {
		payload["manifest"] = string(firmware.Manifest)
		payload["signature"] = string(firmware.Signature)
	}
	return payload
}

func negotiateBaud(ctx context.Context, client Client, requestID string, settle time.Duration) error {
	setCtx, stopSet := context.WithTimeout(ctx, 2*time.Second)
	receipt, err := client.CallReceipt(setCtx, "set_baud", map[string]any{"baud": transferBaud}, nil)
	stopSet()
	if err != nil || receipt.Code != "baud_accepted" {
		return ErrTransfer
	}
	if settle > 0 {
		timer := time.NewTimer(settle)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
	if err := client.SetBaud(transferBaud); err != nil {
		_ = client.SetBaud(defaultBaud)
		return waitForBaudFallback(ctx, client.Events(), requestID)
	}
	readyCtx, stopReady := context.WithTimeout(ctx, 1500*time.Millisecond)
	ready, err := client.CallReceipt(readyCtx, "baud_ready", struct{}{}, nil)
	stopReady()
	if err == nil && ready.Code == "baud_ready" {
		return nil
	}
	_ = client.SetBaud(defaultBaud)
	return waitForBaudFallback(ctx, client.Events(), requestID)
}

func waitForBaudFallback(ctx context.Context, events <-chan protocol.Event, requestID string) error {
	waitCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for {
		select {
		case <-waitCtx.Done():
			return ErrTransfer
		case event, ok := <-events:
			if !ok {
				return ErrTransfer
			}
			if event.ID == requestID && event.Code == "baud_fallback" {
				return nil
			}
		}
	}
}

func waitForAccepted(ctx context.Context, events <-chan protocol.Event, requestID string) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, ok := <-events:
			if !ok {
				return ErrTransfer
			}
			if event.ID != requestID {
				continue
			}
			switch event.Code {
			case "firmware_accepted":
				return nil
			case "physical_confirmation_cancelled", "physical_confirmation_timeout", "firmware_cancelled":
				return ErrTransferPolicy
			}
		}
	}
}

func waitForAcknowledgement(ctx context.Context, events <-chan protocol.Event, requestID string, offset, length uint32) (uint32, bool, error) {
	for {
		select {
		case <-ctx.Done():
			return 0, false, ctx.Err()
		case event, ok := <-events:
			if !ok {
				return 0, false, ErrTransfer
			}
			if event.ID != requestID {
				continue
			}
			switch event.Code {
			case "firmware_ack", "firmware_retry":
				var data struct {
					NextOffset uint32 `json:"nextOffset"`
				}
				if err := json.Unmarshal(event.Data, &data); err != nil {
					return 0, false, ErrTransfer
				}
				if event.Code == "firmware_retry" && data.NextOffset == offset {
					return offset, true, nil
				}
				if event.Code == "firmware_ack" && data.NextOffset == offset+length {
					return data.NextOffset, false, nil
				}
				return 0, false, ErrTransfer
			case "firmware_timeout", "firmware_frame_invalid", "firmware_cancelled", "firmware_control_invalid":
				return 0, false, ErrTransfer
			}
		}
	}
}

func readPayload(path string, offset, total uint32) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, ErrTransfer
	}
	defer file.Close()
	if _, err := file.Seek(int64(offset), io.SeekStart); err != nil {
		return nil, ErrTransfer
	}
	length := total - offset
	if length > framePayloadBytes {
		length = framePayloadBytes
	}
	payload := make([]byte, int(length))
	if _, err := io.ReadFull(file, payload); err != nil {
		return nil, ErrTransfer
	}
	return payload, nil
}

func encodeFrame(offset uint32, payload []byte) []byte {
	frame := make([]byte, frameHeaderBytes+len(payload))
	copy(frame[:4], "OJFW")
	binary.LittleEndian.PutUint32(frame[4:8], offset)
	binary.LittleEndian.PutUint16(frame[8:10], uint16(len(payload)))
	binary.LittleEndian.PutUint32(frame[10:14], crc32.ChecksumIEEE(payload))
	copy(frame[14:], payload)
	return frame
}

func abortTransfer(client Client) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, _ = client.CallReceipt(ctx, "cancel", struct{}{}, nil)
}

func safeTransferError(err error) error {
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	if errors.Is(err, ErrTransferPolicy) {
		return ErrTransferPolicy
	}
	return ErrTransfer
}
