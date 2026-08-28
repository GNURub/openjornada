package app

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/release"
	firmwareupdate "github.com/GNURub/openjornada/cli/openjornada-terminal/internal/update"
	"github.com/spf13/cobra"
)

func newFirmwareCommand(deps runtimeDependencies) *cobra.Command {
	command := &cobra.Command{
		Use:   "firmware",
		Short: "Comprueba e instala firmware del terminal",
		Args:  cobra.NoArgs,
	}
	command.AddCommand(
		newFirmwareCheckCommand(deps),
		newFirmwareUpdateCommand(deps),
		newFirmwareInstallCommand(deps),
	)
	return command
}

func newFirmwareCheckCommand(deps runtimeDependencies) *cobra.Command {
	var port string
	command := &cobra.Command{
		Use:   "check",
		Short: "Compara el firmware instalado con la versión oficial estable",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) (resultErr error) {
			client, status, err := connectFirmwareDevice(command.Context(), deps, port, false)
			if err != nil {
				return err
			}
			defer client.Close()
			firmware, err := fetchVerifiedFirmware(command.Context(), deps, status)
			if err != nil {
				return err
			}
			defer func() {
				if err := firmware.Close(); err != nil && resultErr == nil {
					resultErr = safeCommandError("No se pudo limpiar el firmware temporal.")
				}
			}()
			comparison, err := compareFirmwareVersions(firmware.Version, status.FirmwareVersion)
			if err != nil {
				return safeCommandError("No se pudieron comparar las versiones de firmware.")
			}
			if comparison > 0 {
				_, _ = fmt.Fprintf(command.OutOrStdout(), "Actualización disponible: %s (instalada: %s).\n", firmware.Version, status.FirmwareVersion)
			} else {
				_, _ = fmt.Fprintf(command.OutOrStdout(), "Firmware instalado: %s. Última versión oficial: %s.\n", status.FirmwareVersion, firmware.Version)
			}
			return nil
		},
	}
	command.Flags().StringVar(&port, "port", "auto", "Puerto serie o auto")
	return command
}

func newFirmwareUpdateCommand(deps runtimeDependencies) *cobra.Command {
	var port string
	command := &cobra.Command{
		Use:   "update",
		Short: "Instala una versión oficial estable más reciente",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) (resultErr error) {
			client, status, err := connectFirmwareDevice(command.Context(), deps, port, true)
			if err != nil {
				return err
			}
			defer client.Close()
			if status.PendingCount != 0 {
				return responseCodeError("pending_actions")
			}
			firmware, err := fetchVerifiedFirmware(command.Context(), deps, status)
			if err != nil {
				return err
			}
			defer func() {
				if err := firmware.Close(); err != nil && resultErr == nil {
					resultErr = safeCommandError("No se pudo limpiar el firmware temporal.")
				}
			}()
			comparison, err := compareFirmwareVersions(firmware.Version, status.FirmwareVersion)
			if err != nil || comparison <= 0 {
				return safeCommandError("La actualización oficial no es más reciente que el firmware instalado.")
			}
			transferClient, ok := client.(firmwareupdate.Client)
			if !ok {
				return safeCommandError("El transporte USB no permite transferir firmware.")
			}
			_, _ = fmt.Fprintf(command.OutOrStdout(), "Instalando firmware oficial %s.\n", firmware.Version)
			if err := deps.transferFirmware(command.Context(), transferClient, firmware, firmwareProgress(command)); err != nil {
				return firmwareTransferError(err)
			}
			_, _ = fmt.Fprintln(command.OutOrStdout(), "Firmware verificado; el terminal se está reiniciando.")
			return nil
		},
	}
	command.Flags().StringVar(&port, "port", "auto", "Puerto serie o auto")
	return command
}

func newFirmwareInstallCommand(deps runtimeDependencies) *cobra.Command {
	var port string
	command := &cobra.Command{
		Use:   "install ARCHIVO.bin",
		Short: "Instala firmware OpenJornada personalizado compatible",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) (resultErr error) {
			firmware, err := deps.inspectCustom(args[0])
			if err != nil {
				return safeCommandError("El archivo no contiene firmware OpenJornada personalizado compatible.")
			}
			defer func() {
				if err := firmware.Close(); err != nil && resultErr == nil {
					resultErr = safeCommandError("No se pudo cerrar el firmware personalizado.")
				}
			}()
			client, status, err := connectFirmwareDevice(command.Context(), deps, port, true)
			if err != nil {
				return err
			}
			defer client.Close()
			if status.PendingCount != 0 {
				return responseCodeError("pending_actions")
			}
			transferClient, ok := client.(firmwareupdate.Client)
			if !ok {
				return safeCommandError("El transporte USB no permite transferir firmware.")
			}
			_, _ = fmt.Fprintln(command.OutOrStdout(), "Advertencia: vas a instalar firmware personalizado no oficial.")
			_, _ = fmt.Fprintln(command.OutOrStdout(), "Suelta los botones y mantén SOLO C durante 5 segundos cuando lo solicite el terminal.")
			if err := deps.transferFirmware(command.Context(), transferClient, firmware, firmwareProgress(command)); err != nil {
				return firmwareTransferError(err)
			}
			_, _ = fmt.Fprintln(command.OutOrStdout(), "Firmware personalizado verificado; el terminal se está reiniciando.")
			return nil
		},
	}
	command.Flags().StringVar(&port, "port", "auto", "Puerto serie o auto")
	return command
}

func connectFirmwareDevice(ctx context.Context, deps runtimeDependencies, port string, requireTransfer bool) (DeviceClient, publicStatus, error) {
	client, err := deps.connect(ctx, port)
	if err != nil {
		return nil, publicStatus{}, deviceConnectionError(err)
	}
	status, err := readPublicStatus(ctx, client)
	if err != nil {
		_ = client.Close()
		return nil, publicStatus{}, deviceOperationError("consultar el firmware instalado", err)
	}
	if status.Board != supportedBoard || status.ProtocolVersion != supportedProtocol ||
		(requireTransfer && (!status.Capabilities.FirmwareInstall || !status.Capabilities.NegotiatedBaud)) {
		_ = client.Close()
		return nil, publicStatus{}, safeCommandError("El terminal no admite esta operación de firmware.")
	}
	return client, status, nil
}

func fetchVerifiedFirmware(ctx context.Context, deps runtimeDependencies, status publicStatus) (firmware release.VerifiedFirmware, resultErr error) {
	bundle, err := deps.latestStable(ctx)
	if err != nil {
		return release.VerifiedFirmware{}, safeCommandError("No se pudo descargar la última versión oficial.")
	}
	defer func() {
		if err := bundle.Close(); err != nil && resultErr == nil {
			resultErr = safeCommandError("No se pudo limpiar la descarga temporal.")
		}
	}()
	firmware, err = deps.verifyFirmware(bundle, release.DeviceInfo{
		Board: status.Board, ProtocolVersion: status.ProtocolVersion,
		FirmwareVersion: status.FirmwareVersion,
	})
	if err != nil {
		return release.VerifiedFirmware{}, safeCommandError("La versión oficial descargada no superó la verificación local.")
	}
	return firmware, nil
}

func firmwareProgress(command *cobra.Command) firmwareupdate.ProgressFunc {
	lastPercent := -1
	return func(completed, total uint32) {
		if total == 0 {
			return
		}
		percent := int(uint64(completed) * 100 / uint64(total))
		if percent == lastPercent {
			return
		}
		lastPercent = percent
		_, _ = fmt.Fprintf(command.OutOrStdout(), "Progreso: %d%%\n", percent)
	}
}

func compareFirmwareVersions(left, right string) (int, error) {
	leftParts, err := parseFirmwareVersion(left)
	if err != nil {
		return 0, err
	}
	rightParts, err := parseFirmwareVersion(right)
	if err != nil {
		return 0, err
	}
	for index := range leftParts {
		if leftParts[index] < rightParts[index] {
			return -1, nil
		}
		if leftParts[index] > rightParts[index] {
			return 1, nil
		}
	}
	return 0, nil
}

func parseFirmwareVersion(value string) ([3]uint32, error) {
	var parsed [3]uint32
	parts := strings.Split(value, ".")
	if len(parts) != len(parsed) {
		return parsed, firmwareupdate.ErrTransferPolicy
	}
	for index, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return parsed, firmwareupdate.ErrTransferPolicy
		}
		number, err := strconv.ParseUint(part, 10, 32)
		if err != nil {
			return parsed, firmwareupdate.ErrTransferPolicy
		}
		parsed[index] = uint32(number)
	}
	return parsed, nil
}

func firmwareTransferError(err error) error {
	if errors.Is(err, context.Canceled) {
		return safeCommandError("Transferencia de firmware cancelada.")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return safeCommandError("La transferencia de firmware ha caducado.")
	}
	return safeCommandError("No se pudo completar la transferencia de firmware.")
}
