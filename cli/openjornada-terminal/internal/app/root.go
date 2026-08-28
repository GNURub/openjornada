// Package app assembles the openjornada-terminal command tree.
package app

import (
	"io"
	"os"

	"github.com/spf13/cobra"
)

// Dependencies contains process streams so callers and tests can run commands
// without replacing global state.
type Dependencies struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

// NewRoot creates an isolated Cobra command tree. It does not inspect the
// environment or create configuration files.
func NewRoot(dependencies Dependencies) *cobra.Command {
	stdin := dependencies.Stdin
	if stdin == nil {
		stdin = os.Stdin
	}
	stdout := dependencies.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := dependencies.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	command := &cobra.Command{
		Use:           "openjornada-terminal",
		Short:         "Administra terminales OpenJornada por USB",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	command.SetIn(stdin)
	command.SetOut(stdout)
	command.SetErr(stderr)
	command.AddCommand(newVersionCommand())
	return command
}
