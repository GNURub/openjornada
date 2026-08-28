package app

import (
	"bytes"
	"testing"
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
