// Package app assembles the openjornada-terminal command tree.
package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/protocol"
	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/release"
	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/serialport"
	firmwareupdate "github.com/GNURub/openjornada/cli/openjornada-terminal/internal/update"
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
	Stdin            io.Reader
	Stdout           io.Writer
	Stderr           io.Writer
	Connect          func(context.Context, string) (DeviceClient, error)
	PortNames        func() ([]string, error)
	ReadPassword     func() ([]byte, error)
	ResetTimeout     time.Duration
	LatestStable     func(context.Context) (release.Bundle, error)
	VerifyFirmware   func(release.Bundle, release.DeviceInfo) (release.VerifiedFirmware, error)
	InspectCustom    func(string) (release.VerifiedFirmware, error)
	TransferFirmware func(context.Context, firmwareupdate.Client, release.VerifiedFirmware, firmwareupdate.ProgressFunc) error
	SelfUpdate       func(context.Context) (string, error)
}

type runtimeDependencies struct {
	connect          func(context.Context, string) (DeviceClient, error)
	portNames        func() ([]string, error)
	readPassword     func() ([]byte, error)
	resetTimeout     time.Duration
	latestStable     func(context.Context) (release.Bundle, error)
	verifyFirmware   func(release.Bundle, release.DeviceInfo) (release.VerifiedFirmware, error)
	inspectCustom    func(string) (release.VerifiedFirmware, error)
	transferFirmware func(context.Context, firmwareupdate.Client, release.VerifiedFirmware, firmwareupdate.ProgressFunc) error
	selfUpdate       func(context.Context) (string, error)
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
	latestStable := dependencies.LatestStable
	if latestStable == nil {
		latestStable = release.LatestStable
	}
	verifyFirmware := dependencies.VerifyFirmware
	if verifyFirmware == nil {
		verifyFirmware = release.VerifyBundle
	}
	inspectCustom := dependencies.InspectCustom
	if inspectCustom == nil {
		inspectCustom = firmwareupdate.InspectCustom
	}
	transferFirmware := dependencies.TransferFirmware
	if transferFirmware == nil {
		transferFirmware = firmwareupdate.Transfer
	}
	selfUpdate := dependencies.SelfUpdate
	if selfUpdate == nil {
		selfUpdate = firmwareupdate.UpdateSelf
	}
	runtime := runtimeDependencies{
		connect: connect, portNames: portNames, readPassword: readPassword,
		resetTimeout: resetTimeout, latestStable: latestStable,
		verifyFirmware: verifyFirmware, inspectCustom: inspectCustom,
		transferFirmware: transferFirmware, selfUpdate: selfUpdate,
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
	command.AddCommand(
		newVersionCommand(),
		newPortsCommand(runtime),
		newStatusCommand(runtime),
		newDoctorCommand(runtime),
		newLogsCommand(runtime),
		newProvisionCommand(runtime),
		newRebootCommand(runtime),
		newFactoryResetCommand(runtime),
		newFirmwareCommand(runtime),
		newSelfUpdateCommand(runtime),
		newCompletionCommand(),
	)
	return command
}

func newSelfUpdateCommand(runtime runtimeDependencies) *cobra.Command {
	return &cobra.Command{
		Use:   "self-update",
		Short: "Actualiza este CLI desde la última release estable",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			tag, err := runtime.selfUpdate(command.Context())
			if err != nil {
				if errors.Is(err, firmwareupdate.ErrSelfReplacedNotSynced) {
					return errors.New("el CLI fue sustituido, pero no se pudo confirmar la persistencia del directorio; no repitas la actualización y verifica la versión")
				}
				return errors.New("no se pudo verificar e instalar la actualización del CLI")
			}
			_, err = fmt.Fprintf(command.OutOrStdout(), "Actualización preparada para %s.\n", tag)
			return err
		},
	}
}

func newCompletionCommand() *cobra.Command {
	command := &cobra.Command{
		Use:       "completion bash|zsh|fish|powershell",
		Short:     "Genera completado reproducible para el shell indicado",
		Args:      cobra.ExactArgs(1),
		ValidArgs: []string{"bash", "zsh", "fish", "powershell"},
		RunE: func(command *cobra.Command, args []string) error {
			root := command.Root()
			root.DisableAutoGenTag = true
			output := command.OutOrStdout()
			switch args[0] {
			case "bash":
				return root.GenBashCompletionV2(output, true)
			case "zsh":
				return root.GenZshCompletion(output)
			case "fish":
				return root.GenFishCompletion(output, true)
			case "powershell":
				return root.GenPowerShellCompletion(output)
			default:
				return errors.New("shell no compatible; usa bash, zsh, fish o powershell")
			}
		},
	}
	command.ValidArgsFunction = cobra.NoFileCompletions
	return command
}
