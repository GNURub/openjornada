package terminal

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestPingBrokerRoundTripAndOneTimeChallenge(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	broker := newPingBroker(20 * time.Second)
	waiter, err := broker.begin("terminal-a", now)
	if err != nil {
		t.Fatal(err)
	}
	if waiter.Challenge == "" {
		t.Fatal("missing waiter challenge")
	}
	if _, err := broker.begin("terminal-a", now); !errors.Is(err, errPingInProgress) {
		t.Fatalf("second begin error = %v", err)
	}
	challenge, ok := broker.challenge("terminal-a", now.Add(5*time.Second))
	if !ok || challenge == "" {
		t.Fatal("missing challenge")
	}
	result, err := broker.acknowledge("terminal-a", challenge, pingDeviceResult{
		LocalIP: "192.168.1.44", PublicIP: "203.0.113.9", WifiRSSIDbm: -62, UptimeSeconds: 81,
	}, now.Add(6*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if result.WaitForHeartbeatMs != 5000 || result.ResponseMs != 1000 || result.TotalLatencyMs != 6000 {
		t.Fatalf("unexpected timings: %#v", result)
	}
	if got := <-waiter.Completion; got.Err != nil || got.Result.LocalIP != "192.168.1.44" {
		t.Fatalf("unexpected completion: %#v", got)
	}
	if _, err := broker.acknowledge("terminal-a", challenge, pingDeviceResult{}, now.Add(7*time.Second)); !errors.Is(err, errPingNotPending) {
		t.Fatalf("challenge must be one-time: %v", err)
	}
}

func TestPingBrokerRejectsWrongTerminalAndChallenge(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	broker := newPingBroker(20 * time.Second)
	waiter, err := broker.begin("terminal-a", now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broker.acknowledge("terminal-b", waiter.Challenge, pingDeviceResult{}, now.Add(time.Second)); !errors.Is(err, errPingNotPending) {
		t.Fatalf("wrong terminal error = %v", err)
	}
	if _, err := broker.acknowledge("terminal-a", "wrong", pingDeviceResult{}, now.Add(time.Second)); !errors.Is(err, errPingNotPending) {
		t.Fatalf("wrong challenge error = %v", err)
	}
	if challenge, ok := broker.challenge("terminal-a", now.Add(2*time.Second)); !ok || challenge != waiter.Challenge {
		t.Fatal("failed attempts must leave current ping pending")
	}
}

func TestPingBrokerExpiresAtBoundaryAndCompletesWaiter(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	broker := newPingBroker(20 * time.Second)
	waiter, err := broker.begin("terminal-a", now)
	if err != nil {
		t.Fatal(err)
	}
	if challenge, ok := broker.challenge("terminal-a", now.Add(20*time.Second)); ok || challenge != "" {
		t.Fatal("challenge at expiry boundary must not be delivered")
	}
	if completion := <-waiter.Completion; !errors.Is(completion.Err, errPingExpired) {
		t.Fatalf("expiry completion = %#v", completion)
	}
	if _, err := broker.acknowledge("terminal-a", waiter.Challenge, pingDeviceResult{}, now.Add(20*time.Second)); !errors.Is(err, errPingNotPending) {
		t.Fatalf("expired acknowledge error = %v", err)
	}
}

func TestPingBrokerRepeatedChallengePreservesFirstDelivery(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	broker := newPingBroker(20 * time.Second)
	waiter, err := broker.begin("terminal-a", now)
	if err != nil {
		t.Fatal(err)
	}
	first, ok := broker.challenge("terminal-a", now.Add(4*time.Second))
	if !ok || first != waiter.Challenge {
		t.Fatal("first challenge missing")
	}
	second, ok := broker.challenge("terminal-a", now.Add(9*time.Second))
	if !ok || second != waiter.Challenge {
		t.Fatal("repeated challenge missing")
	}
	result, err := broker.acknowledge("terminal-a", second, pingDeviceResult{}, now.Add(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if result.WaitForHeartbeatMs != 4000 || result.ResponseMs != 6000 || result.TotalLatencyMs != 10000 {
		t.Fatalf("repeated delivery reset timing: %#v", result)
	}
}

func TestPingBrokerCancelIsGenerationSafe(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	broker := newPingBroker(20 * time.Second)
	oldWaiter, err := broker.begin("terminal-a", now)
	if err != nil {
		t.Fatal(err)
	}
	cancelCause := errors.New("request cancelled")
	if !broker.cancel("terminal-a", oldWaiter.Challenge, cancelCause) {
		t.Fatal("current generation was not cancelled")
	}
	if completion := <-oldWaiter.Completion; !errors.Is(completion.Err, cancelCause) {
		t.Fatalf("cancel completion = %#v", completion)
	}

	newWaiter, err := broker.begin("terminal-a", now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if broker.cancel("terminal-a", oldWaiter.Challenge, cancelCause) {
		t.Fatal("old generation unexpectedly cancelled a ping")
	}
	if challenge, ok := broker.challenge("terminal-a", now.Add(2*time.Second)); !ok || challenge != newWaiter.Challenge {
		t.Fatal("old generation cancelled the new ping")
	}
}

func TestPingBrokerCancelReportsLostRaceToAcknowledgement(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	broker := newPingBroker(20 * time.Second)
	waiter, err := broker.begin("terminal-a", now)
	if err != nil {
		t.Fatal(err)
	}
	challenge, ok := broker.challenge("terminal-a", now.Add(time.Second))
	if !ok {
		t.Fatal("missing challenge")
	}
	if _, err := broker.acknowledge("terminal-a", challenge, pingDeviceResult{}, now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if broker.cancel("terminal-a", waiter.Challenge, errPingExpired) {
		t.Fatal("timeout cancellation must report that acknowledgement already won")
	}
	if completion := <-waiter.Completion; completion.Err != nil {
		t.Fatalf("acknowledgement completion = %#v", completion)
	}
}

func TestPingBrokerCancelTerminalCancelsCurrentGeneration(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	broker := newPingBroker(20 * time.Second)
	waiter, err := broker.begin("terminal-a", now)
	if err != nil {
		t.Fatal(err)
	}
	revoked := errors.New("terminal revoked")
	broker.cancelTerminal("terminal-a", revoked)
	if completion := <-waiter.Completion; !errors.Is(completion.Err, revoked) {
		t.Fatalf("revocation completion = %#v", completion)
	}
	if _, err := broker.acknowledge("terminal-a", waiter.Challenge, pingDeviceResult{}, now.Add(time.Second)); !errors.Is(err, errPingNotPending) {
		t.Fatalf("acknowledge after revocation error = %v", err)
	}
}

func TestPingBrokerRevocationPersistenceIsOrderedBeforeAcknowledgement(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	broker := newPingBroker(20 * time.Second)
	waiter, err := broker.begin("terminal-a", now)
	if err != nil {
		t.Fatal(err)
	}
	challenge, ok := broker.challenge("terminal-a", now.Add(time.Second))
	if !ok {
		t.Fatal("missing challenge")
	}

	persistStarted := make(chan struct{})
	allowPersist := make(chan struct{})
	revokeDone := make(chan error, 1)
	go func() {
		revokeDone <- broker.cancelTerminalAfter("terminal-a", errTerminalRevoked, func() error {
			close(persistStarted)
			<-allowPersist
			return nil
		})
	}()
	<-persistStarted

	ackStarted := make(chan struct{})
	ackDone := make(chan error, 1)
	go func() {
		close(ackStarted)
		_, err := broker.acknowledge("terminal-a", challenge, pingDeviceResult{}, now.Add(2*time.Second))
		ackDone <- err
	}()
	<-ackStarted
	close(allowPersist)
	if err := <-revokeDone; err != nil {
		t.Fatal(err)
	}
	if err := <-ackDone; !errors.Is(err, errPingNotPending) {
		t.Fatalf("acknowledgement after persisted revocation error = %v", err)
	}
	if completion := <-waiter.Completion; !errors.Is(completion.Err, errTerminalRevoked) {
		t.Fatalf("revoked waiter completion = %#v", completion)
	}
}

func TestPingBrokerFailedRevocationPersistenceLeavesPingPending(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	broker := newPingBroker(20 * time.Second)
	waiter, err := broker.begin("terminal-a", now)
	if err != nil {
		t.Fatal(err)
	}
	persistErr := errors.New("save failed")
	if err := broker.cancelTerminalAfter("terminal-a", errTerminalRevoked, func() error { return persistErr }); !errors.Is(err, persistErr) {
		t.Fatalf("persistence error = %v", err)
	}
	if challenge, ok := broker.challenge("terminal-a", now.Add(time.Second)); !ok || challenge != waiter.Challenge {
		t.Fatal("failed persistence cancelled pending ping")
	}
}

func TestPingBrokerConcurrentBeginHasOneWinner(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	broker := newPingBroker(20 * time.Second)
	const contenders = 16
	start := make(chan struct{})
	errorsSeen := make(chan error, contenders)
	var group sync.WaitGroup
	for range contenders {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			_, err := broker.begin("terminal-a", now)
			errorsSeen <- err
		}()
	}
	close(start)
	group.Wait()
	close(errorsSeen)

	winners := 0
	for err := range errorsSeen {
		if err == nil {
			winners++
			continue
		}
		if !errors.Is(err, errPingInProgress) {
			t.Fatalf("unexpected begin error: %v", err)
		}
	}
	if winners != 1 {
		t.Fatalf("concurrent begin winners = %d, want 1", winners)
	}
}

func TestBeginTerminalPingCancelsGenerationRevokedAfterInitialRead(t *testing.T) {
	app, terminal := persistedTelemetryTerminal(t)
	defer app.Cleanup()

	// The handler performed its initial ownership and active-state read before
	// this revocation was persisted.
	staleActiveRecord, err := app.FindRecordById("attendance_terminals", terminal.Id)
	if err != nil {
		t.Fatal(err)
	}
	current, err := app.FindRecordById("attendance_terminals", terminal.Id)
	if err != nil {
		t.Fatal(err)
	}
	current.Set("revokedAt", time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC))
	if err := app.Save(current); err != nil {
		t.Fatal(err)
	}

	service := &Service{app: app, pings: newPingBroker(20 * time.Second)}
	if _, err := service.beginTerminalPing(staleActiveRecord, "organization-a", time.Now()); !errors.Is(err, errTerminalRevoked) {
		t.Fatalf("beginTerminalPing() error = %v, want terminal revoked", err)
	}
	if _, err := service.pings.begin(terminal.Id, time.Now()); err != nil {
		t.Fatalf("revoked generation remained pending: %v", err)
	}
}
