package terminal

import (
	"testing"
	"time"
)

func TestAllowedCommands(t *testing.T) {
	tests := map[string][]Command{
		"":            {CommandClockIn},
		"clock_out":   {CommandClockIn},
		"clock_in":    {CommandBreakStart, CommandClockOut},
		"break_start": {CommandBreakEnd},
		"break_end":   {CommandBreakStart, CommandClockOut},
	}
	for previous, want := range tests {
		got := allowedCommands(Command(previous))
		if len(got) != len(want) {
			t.Fatalf("allowedCommands(%q) = %v, want %v", previous, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("allowedCommands(%q) = %v, want %v", previous, got, want)
			}
		}
	}
}

func TestStateWarningsUseApprovedThresholds(t *testing.T) {
	now := time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC)
	working := terminalState([]Event{{Kind: CommandClockIn, OccurredAt: now.Add(-4 * time.Hour)}}, now)
	if !working.LongShift || working.Kind != StateWorking {
		t.Fatalf("working state = %#v", working)
	}

	breakAtLimit := terminalState([]Event{
		{Kind: CommandClockIn, OccurredAt: now.Add(-2 * time.Hour)},
		{Kind: CommandBreakStart, OccurredAt: now.Add(-25 * time.Minute)},
	}, now)
	if breakAtLimit.StaleBreak {
		t.Fatal("a break of exactly 25 minutes must not be stale")
	}

	stale := terminalState([]Event{
		{Kind: CommandClockIn, OccurredAt: now.Add(-2 * time.Hour)},
		{Kind: CommandBreakStart, OccurredAt: now.Add(-25*time.Minute - time.Second)},
	}, now)
	if !stale.StaleBreak || stale.Kind != StateOnBreak {
		t.Fatalf("stale break state = %#v", stale)
	}
}

func TestPINDelay(t *testing.T) {
	tests := map[int]time.Duration{
		1:  0,
		2:  0,
		3:  3 * time.Minute,
		4:  6 * time.Minute,
		12: 30 * time.Minute,
		99: 30 * time.Minute,
	}
	for failures, want := range tests {
		if got := pinDelay(failures); got != want {
			t.Fatalf("pinDelay(%d) = %v, want %v", failures, got, want)
		}
	}
}
