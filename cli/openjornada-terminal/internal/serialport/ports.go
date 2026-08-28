// Package serialport discovers OpenJornada terminals by protocol handshake.
package serialport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/protocol"
	"go.bug.st/serial"
)

const handshakeTimeout = 750 * time.Millisecond

var (
	ErrNoTerminal        = errors.New("serialport: no OpenJornada terminal")
	ErrMultipleTerminals = errors.New("serialport: multiple OpenJornada terminals")
)

type Port interface {
	io.ReadWriteCloser
	SetReadTimeout(time.Duration) error
	SetDTR(bool) error
	SetRTS(bool) error
	ResetInputBuffer() error
}

type enumerateFunc func() ([]string, error)
type openFunc func(string, *serial.Mode) (Port, error)
type match struct {
	name string
	port Port
}

func Discover(ctx context.Context, requested string) (Port, error) {
	return discover(ctx, requested, serial.GetPortsList, func(name string, mode *serial.Mode) (Port, error) {
		return serial.Open(name, mode)
	})
}

func discover(ctx context.Context, requested string, enumerate enumerateFunc, open openFunc) (Port, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	names := []string{requested}
	if requested == "" || requested == "auto" {
		listed, err := enumerate()
		if err != nil {
			return nil, ErrNoTerminal
		}
		names = uniqueSorted(listed)
	}
	mode := &serial.Mode{
		BaudRate:          115200,
		DataBits:          8,
		Parity:            serial.NoParity,
		StopBits:          serial.OneStopBit,
		InitialStatusBits: &serial.ModemOutputBits{DTR: false, RTS: false},
	}
	matches := make([]match, 0, 1)
	for _, name := range names {
		select {
		case <-ctx.Done():
			closeMatches(matches)
			return nil, contextError(requested, ctx.Err())
		default:
		}
		port, err := open(name, mode)
		if err != nil || port == nil {
			continue
		}
		if err := port.ResetInputBuffer(); err != nil {
			_ = port.Close()
			continue
		}
		probeCtx, cancel := context.WithTimeout(ctx, handshakeTimeout)
		_, err = protocol.Probe(probeCtx, port)
		cancel()
		if err != nil {
			_ = port.Close()
			continue
		}
		if err := port.SetReadTimeout(serial.NoTimeout); err != nil {
			_ = port.Close()
			continue
		}
		matches = append(matches, match{name: name, port: port})
	}
	if len(matches) == 1 {
		return matches[0].port, nil
	}
	if len(matches) == 0 {
		if ctx.Err() != nil {
			return nil, contextError(requested, ctx.Err())
		}
		return nil, noTerminalError(requested)
	}
	matchedNames := make([]string, 0, len(matches))
	for _, found := range matches {
		matchedNames = append(matchedNames, found.name)
	}
	closeMatches(matches)
	return nil, fmt.Errorf("%w: %s", ErrMultipleTerminals, quotedNames(matchedNames))
}

func uniqueSorted(names []string) []string {
	seen := make(map[string]struct{}, len(names))
	result := make([]string, 0, len(names))
	for _, name := range names {
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}

func noTerminalError(requested string) error {
	if requested == "" || requested == "auto" {
		return ErrNoTerminal
	}
	return fmt.Errorf("%w: %q", ErrNoTerminal, requested)
}

func contextError(requested string, cause error) error {
	return fmt.Errorf("%w: %w: %s", ErrNoTerminal, cause, quotedRequested(requested))
}

func quotedRequested(requested string) string {
	if requested == "" || requested == "auto" {
		return "auto"
	}
	return fmt.Sprintf("%q", requested)
}

func quotedNames(names []string) string {
	quoted := make([]string, len(names))
	for index, name := range names {
		quoted[index] = fmt.Sprintf("%q", name)
	}
	return strings.Join(quoted, ", ")
}

func closeMatches(matches []match) {
	for _, match := range matches {
		_ = match.port.Close()
	}
}
