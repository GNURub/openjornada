package terminal

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

var (
	errPingInProgress  = errors.New("ping already in progress")
	errPingNotPending  = errors.New("ping not pending")
	errPingExpired     = errors.New("ping expired")
	errPingCancelled   = errors.New("ping cancelled")
	errTerminalRevoked = errors.New("terminal revoked")
)

type pingDeviceResult struct {
	LocalIP       string
	PublicIP      string
	WifiRSSIDbm   int
	UptimeSeconds uint64
}

type pingResult struct {
	pingDeviceResult
	WaitForHeartbeatMs int64
	ResponseMs         int64
	TotalLatencyMs     int64
	CheckedAt          time.Time
}

type pingCompletion struct {
	Result pingResult
	Err    error
}

type pingWaiter struct {
	Challenge  string
	Completion <-chan pingCompletion
}

type pendingPing struct {
	challenge   string
	createdAt   time.Time
	deliveredAt time.Time
	result      chan pingCompletion
}

type pingBroker struct {
	mu      sync.Mutex
	ttl     time.Duration
	pending map[string]*pendingPing
}

func newPingBroker(ttl time.Duration) *pingBroker {
	return &pingBroker{ttl: ttl, pending: make(map[string]*pendingPing)}
}

func (b *pingBroker) begin(terminalID string, now time.Time) (pingWaiter, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if current := b.pending[terminalID]; current != nil {
		if !b.expired(current, now) {
			return pingWaiter{}, errPingInProgress
		}
		b.completeLocked(terminalID, current, pingCompletion{Err: errPingExpired})
	}

	challengeBytes := make([]byte, 24)
	if _, err := rand.Read(challengeBytes); err != nil {
		return pingWaiter{}, err
	}
	challenge := base64.RawURLEncoding.EncodeToString(challengeBytes)
	completion := make(chan pingCompletion, 1)
	pending := &pendingPing{
		challenge: challenge,
		createdAt: now,
		result:    completion,
	}
	b.pending[terminalID] = pending
	return pingWaiter{Challenge: challenge, Completion: completion}, nil
}

func (b *pingBroker) challenge(terminalID string, now time.Time) (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()

	pending := b.pending[terminalID]
	if pending == nil {
		return "", false
	}
	if b.expired(pending, now) {
		b.completeLocked(terminalID, pending, pingCompletion{Err: errPingExpired})
		return "", false
	}
	if pending.deliveredAt.IsZero() {
		pending.deliveredAt = now
	}
	return pending.challenge, true
}

func (b *pingBroker) acknowledge(terminalID, challenge string, device pingDeviceResult, now time.Time) (pingResult, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	pending := b.pending[terminalID]
	if pending == nil {
		return pingResult{}, errPingNotPending
	}
	if b.expired(pending, now) {
		b.completeLocked(terminalID, pending, pingCompletion{Err: errPingExpired})
		return pingResult{}, errPingExpired
	}
	if subtle.ConstantTimeCompare([]byte(pending.challenge), []byte(challenge)) != 1 {
		return pingResult{}, errPingNotPending
	}
	if pending.deliveredAt.IsZero() {
		return pingResult{}, errPingNotPending
	}

	result := pingResult{
		pingDeviceResult:   device,
		WaitForHeartbeatMs: millisecondsBetween(pending.createdAt, pending.deliveredAt),
		ResponseMs:         millisecondsBetween(pending.deliveredAt, now),
		TotalLatencyMs:     millisecondsBetween(pending.createdAt, now),
		CheckedAt:          now,
	}
	b.completeLocked(terminalID, pending, pingCompletion{Result: result})
	return result, nil
}

func (b *pingBroker) cancel(terminalID, challenge string, cause error) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	pending := b.pending[terminalID]
	if pending == nil || subtle.ConstantTimeCompare([]byte(pending.challenge), []byte(challenge)) != 1 {
		return false
	}
	if cause == nil {
		cause = errPingCancelled
	}
	b.completeLocked(terminalID, pending, pingCompletion{Err: cause})
	return true
}

func (b *pingBroker) cancelTerminal(terminalID string, cause error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.cancelTerminalLocked(terminalID, cause)
}

func (b *pingBroker) cancelTerminalAfter(terminalID string, cause error, persist func() error) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := persist(); err != nil {
		return err
	}
	b.cancelTerminalLocked(terminalID, cause)
	return nil
}

func (b *pingBroker) cancelTerminalLocked(terminalID string, cause error) {
	if pending := b.pending[terminalID]; pending != nil {
		if cause == nil {
			cause = errPingCancelled
		}
		b.completeLocked(terminalID, pending, pingCompletion{Err: cause})
	}
}

func (b *pingBroker) completeLocked(terminalID string, pending *pendingPing, completion pingCompletion) {
	if b.pending[terminalID] != pending {
		return
	}
	delete(b.pending, terminalID)
	select {
	case pending.result <- completion:
	default:
	}
}

func (b *pingBroker) expired(pending *pendingPing, now time.Time) bool {
	return !now.Before(pending.createdAt.Add(b.ttl))
}

func millisecondsBetween(start, end time.Time) int64 {
	if end.Before(start) {
		return 0
	}
	return end.Sub(start).Milliseconds()
}
