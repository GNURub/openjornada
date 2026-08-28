package app

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/release"
	firmwareupdate "github.com/GNURub/openjornada/cli/openjornada-terminal/internal/update"
)

func TestNewRootConfiguresStreamsAndSilencesUsage(t *testing.T) {
	stdin := bytes.NewBufferString("input")
	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	command := NewRoot(Dependencies{Stdin: stdin, Stdout: stdout, Stderr: stderr})

	if !command.SilenceUsage {
		t.Fatal("SilenceUsage = false")
	}
	if !command.SilenceErrors {
		t.Fatal("SilenceErrors = false")
	}
	if command.InOrStdin() != stdin || command.OutOrStdout() != stdout || command.ErrOrStderr() != stderr {
		t.Fatal("command streams were not injected")
	}
}

func TestVersionPrintsOnlyBuildMetadata(t *testing.T) {
	originalVersion, originalCommit, originalBuildDate := version, commit, buildDate
	t.Cleanup(func() {
		version, commit, buildDate = originalVersion, originalCommit, originalBuildDate
	})
	version, commit, buildDate = "v1.2.3", "abc123", "2026-08-28T12:00:00Z"

	stdout := &bytes.Buffer{}
	stderr := &bytes.Buffer{}
	command := NewRoot(Dependencies{Stdout: stdout, Stderr: stderr})
	command.SetArgs([]string{"version"})
	if err := command.Execute(); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}

	want := "version=v1.2.3\ncommit=abc123\nbuildDate=2026-08-28T12:00:00Z\n"
	if stdout.String() != want {
		t.Fatalf("stdout = %q, want %q", stdout.String(), want)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestSelfUpdateUsesInjectedUpdater(t *testing.T) {
	stdout := &bytes.Buffer{}
	called := false
	command := NewRoot(Dependencies{
		Stdout: stdout,
		SelfUpdate: func(context.Context) (string, error) {
			called = true
			return "v2.0.0", nil
		},
	})
	command.SetArgs([]string{"self-update"})
	if err := command.Execute(); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if !called {
		t.Fatal("self updater was not called")
	}
	if got := stdout.String(); got != "Actualización preparada para v2.0.0.\n" {
		t.Fatalf("stdout = %q", got)
	}
}

func TestSelfUpdateReturnsSafeSpanishError(t *testing.T) {
	marker := "private-download-body"
	command := NewRoot(Dependencies{SelfUpdate: func(context.Context) (string, error) { return "", errors.New(marker) }})
	command.SetArgs([]string{"self-update"})
	err := command.Execute()
	if err == nil || strings.Contains(err.Error(), marker) {
		t.Fatalf("Execute() error = %v", err)
	}
}

func TestSelfUpdateReportsCompletedReplacementWithUnconfirmedDurability(t *testing.T) {
	command := NewRoot(Dependencies{SelfUpdate: func(context.Context) (string, error) {
		return "", firmwareupdate.ErrSelfReplacedNotSynced
	}})
	command.SetArgs([]string{"self-update"})
	err := command.Execute()
	if err == nil || !strings.Contains(err.Error(), "fue sustituido") || !strings.Contains(err.Error(), "no repitas") {
		t.Fatalf("Execute() error = %v", err)
	}
}

func TestCompletionIsReproducibleAndDoesNotUseDevicesOrNetwork(t *testing.T) {
	for _, shell := range []string{"bash", "zsh", "fish", "powershell"} {
		t.Run(shell, func(t *testing.T) {
			generate := func() string {
				stdout := &bytes.Buffer{}
				panicCall := func() { panic("completion inspected runtime dependency") }
				command := NewRoot(Dependencies{
					Stdout:       stdout,
					Connect:      func(context.Context, string) (DeviceClient, error) { panicCall(); return nil, nil },
					PortNames:    func() ([]string, error) { panicCall(); return nil, nil },
					LatestStable: func(context.Context) (release.Bundle, error) { panicCall(); return release.Bundle{}, nil },
					SelfUpdate:   func(context.Context) (string, error) { panicCall(); return "", nil },
				})
				command.SetArgs([]string{"completion", shell})
				if err := command.Execute(); err != nil {
					t.Fatalf("Execute() error = %v", err)
				}
				return stdout.String()
			}
			first, second := generate(), generate()
			if first == "" || first != second {
				t.Fatalf("completion is not reproducible (sizes %d and %d)", len(first), len(second))
			}
			if strings.Contains(strings.ToLower(first), "timestamp") {
				t.Fatal("completion contains timestamp marker")
			}
		})
	}
}
