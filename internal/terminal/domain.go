package terminal

import "time"

type Command string

const (
	CommandClockIn    Command = "clock_in"
	CommandBreakStart Command = "break_start"
	CommandBreakEnd   Command = "break_end"
	CommandClockOut   Command = "clock_out"
)

type StateKind string

const (
	StateIdle    StateKind = "idle"
	StateWorking StateKind = "working"
	StateOnBreak StateKind = "on_break"
)

type Event struct {
	Kind       Command
	OccurredAt time.Time
}

type WorkState struct {
	Kind           StateKind `json:"kind"`
	Since          string    `json:"since,omitempty"`
	WorkedSeconds  int64     `json:"workedSeconds"`
	BreakSeconds   int64     `json:"breakSeconds"`
	LongShift      bool      `json:"longShift"`
	StaleBreak     bool      `json:"staleBreak"`
	AllowedActions []Command `json:"allowedActions"`
}

func allowedCommands(previous Command) []Command {
	switch previous {
	case "", CommandClockOut:
		return []Command{CommandClockIn}
	case CommandClockIn:
		return []Command{CommandBreakStart, CommandClockOut}
	case CommandBreakStart:
		return []Command{CommandBreakEnd}
	case CommandBreakEnd:
		return []Command{CommandBreakStart, CommandClockOut}
	default:
		return nil
	}
}

func validCommand(command Command) bool {
	return command == CommandClockIn || command == CommandBreakStart || command == CommandBreakEnd || command == CommandClockOut
}

func terminalState(events []Event, now time.Time) WorkState {
	state := WorkState{Kind: StateIdle, AllowedActions: []Command{CommandClockIn}}
	if len(events) == 0 {
		return state
	}
	last := events[len(events)-1]
	state.AllowedActions = allowedCommands(last.Kind)
	switch last.Kind {
	case CommandClockIn, CommandBreakEnd:
		state.Kind = StateWorking
		state.Since = last.OccurredAt.UTC().Format(time.RFC3339Nano)
	case CommandBreakStart:
		state.Kind = StateOnBreak
		state.Since = last.OccurredAt.UTC().Format(time.RFC3339Nano)
	case CommandClockOut:
		return state
	}

	var workStart, breakStart time.Time
	for _, event := range events {
		switch event.Kind {
		case CommandClockIn:
			workStart = event.OccurredAt
		case CommandBreakStart:
			if !workStart.IsZero() {
				state.WorkedSeconds += maxSeconds(event.OccurredAt.Sub(workStart))
				workStart = time.Time{}
			}
			breakStart = event.OccurredAt
		case CommandBreakEnd:
			if !breakStart.IsZero() {
				state.BreakSeconds += maxSeconds(event.OccurredAt.Sub(breakStart))
				breakStart = time.Time{}
			}
			workStart = event.OccurredAt
		case CommandClockOut:
			if !workStart.IsZero() {
				state.WorkedSeconds += maxSeconds(event.OccurredAt.Sub(workStart))
				workStart = time.Time{}
			}
		}
	}
	if !workStart.IsZero() {
		state.WorkedSeconds += maxSeconds(now.Sub(workStart))
	}
	if !breakStart.IsZero() {
		state.BreakSeconds += maxSeconds(now.Sub(breakStart))
		state.StaleBreak = now.Sub(breakStart) > 25*time.Minute
	}
	state.LongShift = state.Kind == StateWorking && state.WorkedSeconds >= int64((4*time.Hour)/time.Second)
	return state
}

func maxSeconds(value time.Duration) int64 {
	if value < 0 {
		return 0
	}
	return int64(value / time.Second)
}

func pinDelay(failures int) time.Duration {
	if failures < 3 {
		return 0
	}
	minutes := (failures - 2) * 3
	if minutes > 30 {
		minutes = 30
	}
	return time.Duration(minutes) * time.Minute
}
