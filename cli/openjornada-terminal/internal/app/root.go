// Package app assembles the openjornada-terminal command tree.
package app

import (
	"context"
	"io"
	"os"
	"time"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/protocol"
	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/serialport"
	"github.com/spf13/cobra"
	"go.bug.st/serial"
	"golang.org/x/term"
)

// DeviceClient is the bounded control surface used by device commands.
type DeviceClient interface {
	Call(context.Context, string, any, any) error
	CallReceipt(context.Context, string, any, any) (protocol.Receipt, error)
	Events() <-chan protocol.Event
	Close() error
}

// Dependencies contains process streams so callers and tests can run commands
// without replacing global state.
type Dependencies struct {
	Stdin        io.Reader
	Stdout       io.Writer
	Stderr       io.Writer
	Connect      func(context.Context, string) (DeviceClient, error)
	PortNames    func() ([]string, error)
	ReadPassword func() ([]byte, error)
	ResetTimeout time.Duration
}

type runtimeDependencies struct {
	connect      func(context.Context, string) (DeviceClient, error)
	portNames    func() ([]string, error)
	readPassword func() ([]byte, error)
	resetTimeout time.Duration
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
	connect := dependencies.Connect
	if connect == nil {
		connect = func(ctx context.Context, requested string) (DeviceClient, error) {
			port, err := serialport.Discover(ctx, requested)
			if err != nil {
				return nil, err
			}
			client, err := protocol.NewClient(port)
			if err != nil {
				_ = port.Close()
				return nil, err
			}
			return client, nil
		}
	}
	portNames := dependencies.PortNames
	if portNames == nil {
		portNames = serial.GetPortsList
	}
	readPassword := dependencies.ReadPassword
	if readPassword == nil {
		readPassword = func() ([]byte, error) { return term.ReadPassword(int(os.Stdin.Fd())) }
	}
	resetTimeout := dependencies.ResetTimeout
	if resetTimeout <= 0 {
		resetTimeout = 35 * time.Second
	}
	runtime := runtimeDependencies{connect: connect, portNames: portNames, readPassword: readPassword, resetTimeout: resetTimeout}

	command := &cobra.Command{
		Use:           "openjornada-terminal",
		Short:         "Administra terminales OpenJornada por USB",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	command.SetIn(stdin)
	command.SetOut(stdout)
	command.SetErr(stderr)
	command.AddCommand(
		newVersionCommand(),
		newPortsCommand(runtime),
		newStatusCommand(runtime),
		newDoctorCommand(runtime),
		newLogsCommand(runtime),
		newProvisionCommand(runtime),
		newRebootCommand(runtime),
		newFactoryResetCommand(runtime),
	)
	return command
}
