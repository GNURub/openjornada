package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/protocol"
	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/serialport"
	"github.com/spf13/cobra"
)

const (
	supportedBoard    = "m5stack-basic-core-v27"
	supportedProtocol = 1
)

type deviceStatus struct {
	Board           string `json:"board"`
	FirmwareVersion string `json:"firmwareVersion"`
	ProtocolVersion int    `json:"protocolVersion"`
	Mode            string `json:"mode"`
	Configured      bool   `json:"configured"`
	WiFiConnected   bool   `json:"wifiConnected"`
	PendingCount    int    `json:"pendingCount"`
}

type deviceHello struct {
	ProtocolVersion int                   `json:"protocolVersion"`
	Board           string                `json:"board"`
	FirmwareVersion string                `json:"firmwareVersion"`
	Mode            string                `json:"mode"`
	Capabilities    protocol.Capabilities `json:"capabilities"`
}

type publicStatus struct {
	deviceStatus
	Capabilities protocol.Capabilities `json:"capabilities"`
}

type doctorResult struct {
	StorageAvailable bool                  `json:"storageAvailable"`
	RFIDAvailable    bool                  `json:"rfidAvailable"`
	Configured       bool                  `json:"configured"`
	Capabilities     protocol.Capabilities `json:"capabilities"`
	ErrorCodes       []string              `json:"errorCodes"`
}

func (status *deviceStatus) UnmarshalJSON(data []byte) error {
	fields, err := exactPublicObject(data, "board", "firmwareVersion", "protocolVersion", "mode", "configured", "wifiConnected", "pendingCount")
	if err != nil {
		return err
	}
	if status.Board, err = publicString(fields["board"]); err != nil {
		return err
	}
	if status.FirmwareVersion, err = publicString(fields["firmwareVersion"]); err != nil {
		return err
	}
	if status.ProtocolVersion, err = publicInt(fields["protocolVersion"]); err != nil {
		return err
	}
	if status.Mode, err = publicString(fields["mode"]); err != nil {
		return err
	}
	if status.Configured, err = publicBool(fields["configured"]); err != nil {
		return err
	}
	if status.WiFiConnected, err = publicBool(fields["wifiConnected"]); err != nil {
		return err
	}
	status.PendingCount, err = publicInt(fields["pendingCount"])
	return err
}

func (hello *deviceHello) UnmarshalJSON(data []byte) error {
	fields, err := exactPublicObject(data, "protocolVersion", "board", "firmwareVersion", "mode", "capabilities")
	if err != nil {
		return err
	}
	if hello.ProtocolVersion, err = publicInt(fields["protocolVersion"]); err != nil {
		return err
	}
	if hello.Board, err = publicString(fields["board"]); err != nil {
		return err
	}
	if hello.FirmwareVersion, err = publicString(fields["firmwareVersion"]); err != nil {
		return err
	}
	if hello.Mode, err = publicString(fields["mode"]); err != nil {
		return err
	}
	hello.Capabilities, err = publicCapabilities(fields["capabilities"])
	return err
}

func (result *doctorResult) UnmarshalJSON(data []byte) error {
	fields, err := exactPublicObject(data, "storageAvailable", "rfidAvailable", "configured", "capabilities", "errorCodes")
	if err != nil {
		return err
	}
	if result.StorageAvailable, err = publicBool(fields["storageAvailable"]); err != nil {
		return err
	}
	if result.RFIDAvailable, err = publicBool(fields["rfidAvailable"]); err != nil {
		return err
	}
	if result.Configured, err = publicBool(fields["configured"]); err != nil {
		return err
	}
	if result.Capabilities, err = publicCapabilities(fields["capabilities"]); err != nil {
		return err
	}
	return decodePublicStringArray(fields["errorCodes"], &result.ErrorCodes)
}

func newPortsCommand(deps runtimeDependencies) *cobra.Command {
	return &cobra.Command{Use: "ports", Short: "Enumera terminales OpenJornada", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		names, err := deps.portNames()
		if err != nil {
			return safeCommandError("No se pudieron enumerar los puertos.")
		}
		sort.Strings(names)
		found := 0
		seen := make(map[string]struct{}, len(names))
		writer := tabwriter.NewWriter(command.OutOrStdout(), 0, 4, 2, ' ', 0)
		for _, name := range names {
			if name == "" {
				continue
			}
			if _, exists := seen[name]; exists {
				continue
			}
			seen[name] = struct{}{}
			client, err := deps.connect(command.Context(), name)
			if err != nil {
				continue
			}
			var hello deviceHello
			receipt, callErr := client.CallReceipt(command.Context(), "hello", struct{}{}, &hello)
			_ = client.Close()
			if callErr != nil || receipt.Code != "ok" || !validHelloMetadata(hello) {
				continue
			}
			if found == 0 {
				_, _ = fmt.Fprintln(writer, "PUERTO\tPLACA\tFIRMWARE\tMODO")
			}
			found++
			board := "incompatible"
			if hello.Board == supportedBoard {
				board = hello.Board
			}
			_, _ = fmt.Fprintf(writer, "%s\t%s\t%s\t%s\n", name, board, hello.FirmwareVersion, hello.Mode)
		}
		_ = writer.Flush()
		if found == 0 {
			return safeCommandError("No se ha encontrado ningún terminal OpenJornada.")
		}
		return nil
	}}
}

func newStatusCommand(deps runtimeDependencies) *cobra.Command {
	var port string
	var asJSON bool
	command := &cobra.Command{Use: "status", Short: "Muestra el estado público del terminal", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		client, err := deps.connect(command.Context(), port)
		if err != nil {
			return deviceConnectionError(err)
		}
		defer client.Close()
		status, err := readPublicStatus(command.Context(), client)
		if err != nil {
			return deviceOperationError("consultar el estado", err)
		}
		if asJSON {
			encoder := json.NewEncoder(command.OutOrStdout())
			encoder.SetEscapeHTML(false)
			if err := encoder.Encode(status); err != nil {
				return safeCommandError("No se pudo escribir el estado.")
			}
			return nil
		}
		writeStatusTable(command, status)
		return nil
	}}
	command.Flags().StringVar(&port, "port", "auto", "Puerto serie o auto")
	command.Flags().BoolVar(&asJSON, "json", false, "Muestra JSON con campos públicos")
	return command
}

func readPublicStatus(ctx context.Context, client DeviceClient) (publicStatus, error) {
	var hello deviceHello
	receipt, err := client.CallReceipt(ctx, "hello", struct{}{}, &hello)
	if err != nil {
		return publicStatus{}, err
	}
	if receipt.Code != "ok" {
		return publicStatus{}, &protocol.DeviceError{Code: receipt.Code}
	}
	if !validHelloMetadata(hello) {
		return publicStatus{}, protocol.ErrInvalidMessage
	}
	var status deviceStatus
	receipt, err = client.CallReceipt(ctx, "status", struct{}{}, &status)
	if err != nil {
		return publicStatus{}, err
	}
	if receipt.Code != "ok" {
		return publicStatus{}, &protocol.DeviceError{Code: receipt.Code}
	}
	if status.Board != hello.Board || status.FirmwareVersion != hello.FirmwareVersion ||
		status.ProtocolVersion != hello.ProtocolVersion || !validMode(status.Mode) || status.PendingCount < 0 {
		return publicStatus{}, protocol.ErrInvalidMessage
	}
	return publicStatus{deviceStatus: status, Capabilities: hello.Capabilities}, nil
}

func writeStatusTable(command *cobra.Command, status publicStatus) {
	writer := tabwriter.NewWriter(command.OutOrStdout(), 0, 4, 2, ' ', 0)
	rows := [][2]string{
		{"Placa", status.Board}, {"Firmware", status.FirmwareVersion},
		{"Protocolo", fmt.Sprint(status.ProtocolVersion)}, {"Modo", status.Mode},
		{"Configurado", yesNo(status.Configured)}, {"Wi-Fi conectado", yesNo(status.WiFiConnected)},
		{"Fichajes pendientes", fmt.Sprint(status.PendingCount)}, {"Capacidades", enabledCapabilities(status.Capabilities)},
	}
	for _, row := range rows {
		_, _ = fmt.Fprintf(writer, "%s:\t%s\n", row[0], row[1])
	}
	_ = writer.Flush()
}

func newDoctorCommand(deps runtimeDependencies) *cobra.Command {
	var port string
	command := &cobra.Command{Use: "doctor", Short: "Comprueba la compatibilidad y salud del terminal", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		client, err := deps.connect(command.Context(), port)
		if err != nil {
			return deviceConnectionError(err)
		}
		defer client.Close()
		var hello deviceHello
		receipt, err := client.CallReceipt(command.Context(), "hello", struct{}{}, &hello)
		if err != nil || receipt.Code != "ok" {
			return deviceOperationError("completar el handshake", err)
		}
		if !validHelloMetadata(hello) {
			return safeCommandError("El handshake devolvió metadatos no válidos.")
		}
		var result doctorResult
		receipt, err = client.CallReceipt(command.Context(), "doctor", struct{}{}, &result)
		if err != nil || receipt.Code != "ok" {
			return deviceOperationError("ejecutar el diagnóstico", err)
		}
		compatibleBoard := hello.Board == supportedBoard
		compatibleProtocol := hello.ProtocolVersion == supportedProtocol
		_, _ = fmt.Fprintf(command.OutOrStdout(), "Handshake: compatible\nPlaca: %s\nProtocolo: %s\nAlmacenamiento: %s\nRFID: %s\nConfiguración: %s\n%s",
			compatibility(compatibleBoard), compatibility(compatibleProtocol), available(result.StorageAvailable), available(result.RFIDAvailable), available(result.Configured), capabilityDiagnostics(result.Capabilities))
		if !compatibleBoard || !compatibleProtocol || len(result.ErrorCodes) != 0 {
			return safeCommandError("El terminal presenta incompatibilidades o incidencias.")
		}
		return nil
	}}
	command.Flags().StringVar(&port, "port", "auto", "Puerto serie o auto")
	return command
}

func newLogsCommand(deps runtimeDependencies) *cobra.Command {
	var port string
	var follow bool
	command := &cobra.Command{Use: "logs", Short: "Sigue eventos estructurados saneados", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		if !follow {
			return safeCommandError("Usa --follow para seguir los eventos.")
		}
		client, err := deps.connect(command.Context(), port)
		if err != nil {
			return deviceConnectionError(err)
		}
		defer client.Close()
		receipt, err := client.CallReceipt(command.Context(), "logs_subscribe", struct{}{}, nil)
		if err != nil || receipt.Code != "subscribed" {
			return deviceOperationError("activar los eventos", err)
		}
		for {
			select {
			case <-command.Context().Done():
				return nil
			case event, ok := <-client.Events():
				if !ok {
					if command.Context().Err() != nil {
						return nil
					}
					return safeCommandError("Se perdió la conexión con el terminal.")
				}
				if event.ID != receipt.ID || !allowedLogCode(event.Code) {
					continue
				}
				var data struct {
					Event    string `json:"event"`
					UptimeMS uint32 `json:"uptimeMs"`
				}
				if err := decodePublicEvent(event.Data, &data); err != nil || data.Event != event.Code {
					continue
				}
				_, _ = fmt.Fprintf(command.OutOrStdout(), "%d\t%s\n", data.UptimeMS, event.Code)
			}
		}
	}}
	command.Flags().StringVar(&port, "port", "auto", "Puerto serie o auto")
	command.Flags().BoolVar(&follow, "follow", false, "Mantiene la suscripción abierta")
	return command
}

func newRebootCommand(deps runtimeDependencies) *cobra.Command {
	var port string
	command := &cobra.Command{Use: "reboot", Short: "Reinicia el terminal sin modificar datos", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		client, err := deps.connect(command.Context(), port)
		if err != nil {
			return deviceConnectionError(err)
		}
		defer client.Close()
		receipt, err := client.CallReceipt(command.Context(), "reboot", struct{}{}, nil)
		if err != nil {
			return deviceOperationError("reiniciar", err)
		}
		if receipt.Code != "rebooting" {
			return responseCodeError(receipt.Code)
		}
		_, _ = fmt.Fprintln(command.OutOrStdout(), "El terminal se está reiniciando.")
		return nil
	}}
	command.Flags().StringVar(&port, "port", "auto", "Puerto serie o auto")
	return command
}

func yesNo(value bool) string {
	if value {
		return "sí"
	}
	return "no"
}
func available(value bool) string {
	if value {
		return "disponible"
	}
	return "no disponible"
}
func compatibility(value bool) string {
	if value {
		return "compatible"
	}
	return "incompatible"
}

func enabledCapabilities(c protocol.Capabilities) string {
	values := make([]string, 0, 8)
	for _, item := range []struct {
		name    string
		enabled bool
	}{
		{"status", c.Status}, {"doctor", c.Doctor}, {"structuredLogs", c.StructuredLogs}, {"reboot", c.Reboot},
		{"physicalFactoryReset", c.PhysicalFactoryReset}, {"provisioningRecovery", c.ProvisioningRecovery},
		{"firmwareInstall", c.FirmwareInstall}, {"negotiatedBaud", c.NegotiatedBaud},
	} {
		if item.enabled {
			values = append(values, item.name)
		}
	}
	if len(values) == 0 {
		return "ninguna"
	}
	return strings.Join(values, ",")
}

func capabilityDiagnostics(c protocol.Capabilities) string {
	var output strings.Builder
	for _, item := range []struct {
		name    string
		enabled bool
	}{
		{"status", c.Status}, {"doctor", c.Doctor}, {"structuredLogs", c.StructuredLogs}, {"reboot", c.Reboot},
		{"physicalFactoryReset", c.PhysicalFactoryReset}, {"provisioningRecovery", c.ProvisioningRecovery},
		{"firmwareInstall", c.FirmwareInstall}, {"negotiatedBaud", c.NegotiatedBaud},
	} {
		_, _ = fmt.Fprintf(&output, "Capacidad %s: %s\n", item.name, available(item.enabled))
	}
	return output.String()
}

func validHelloMetadata(hello deviceHello) bool {
	return hello.ProtocolVersion > 0 && hello.ProtocolVersion <= 255 &&
		validBoard(hello.Board) && validFirmwareVersion(hello.FirmwareVersion) && validMode(hello.Mode)
}

func exactPublicObject(data []byte, names ...string) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || len(fields) != len(names) {
		return nil, protocol.ErrInvalidMessage
	}
	for _, name := range names {
		if _, exists := fields[name]; !exists {
			return nil, protocol.ErrInvalidMessage
		}
	}
	return fields, nil
}

func publicString(data json.RawMessage) (string, error) {
	if len(data) < 2 || data[0] != '"' {
		return "", protocol.ErrInvalidMessage
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return "", protocol.ErrInvalidMessage
	}
	return value, nil
}

func publicInt(data json.RawMessage) (int, error) {
	if len(data) == 0 || (data[0] < '0' || data[0] > '9') {
		return 0, protocol.ErrInvalidMessage
	}
	var value int
	if err := json.Unmarshal(data, &value); err != nil {
		return 0, protocol.ErrInvalidMessage
	}
	return value, nil
}

func publicBool(data json.RawMessage) (bool, error) {
	if bytes.Equal(data, []byte("true")) {
		return true, nil
	}
	if bytes.Equal(data, []byte("false")) {
		return false, nil
	}
	return false, protocol.ErrInvalidMessage
}

func publicCapabilities(data json.RawMessage) (protocol.Capabilities, error) {
	fields, err := exactPublicObject(data, "status", "doctor", "structuredLogs", "reboot", "physicalFactoryReset", "provisioningRecovery", "firmwareInstall", "negotiatedBaud")
	if err != nil {
		return protocol.Capabilities{}, err
	}
	values := []*bool{}
	capabilities := protocol.Capabilities{}
	values = append(values, &capabilities.Status, &capabilities.Doctor, &capabilities.StructuredLogs, &capabilities.Reboot, &capabilities.PhysicalFactoryReset, &capabilities.ProvisioningRecovery, &capabilities.FirmwareInstall, &capabilities.NegotiatedBaud)
	for index, name := range []string{"status", "doctor", "structuredLogs", "reboot", "physicalFactoryReset", "provisioningRecovery", "firmwareInstall", "negotiatedBaud"} {
		value, err := publicBool(fields[name])
		if err != nil {
			return protocol.Capabilities{}, err
		}
		*values[index] = value
	}
	return capabilities, nil
}

func decodePublicStringArray(data json.RawMessage, destination *[]string) error {
	if len(data) == 0 || data[0] != '[' {
		return protocol.ErrInvalidMessage
	}
	if err := json.Unmarshal(data, destination); err != nil || *destination == nil {
		return protocol.ErrInvalidMessage
	}
	for _, value := range *destination {
		if len(value) == 0 || len(value) > 64 {
			return protocol.ErrInvalidMessage
		}
		for _, character := range value {
			if (character < 'a' || character > 'z') && character != '_' {
				return protocol.ErrInvalidMessage
			}
		}
	}
	return nil
}

func validBoard(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
			return false
		}
	}
	return true
}

func validFirmwareVersion(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	parts := strings.SplitN(value, "-", 2)
	core := strings.Split(parts[0], ".")
	if len(core) != 3 {
		return false
	}
	for _, part := range core {
		if part == "" {
			return false
		}
		for _, character := range part {
			if character < '0' || character > '9' {
				return false
			}
		}
	}
	if len(parts) == 2 {
		if parts[1] == "" {
			return false
		}
		for _, character := range parts[1] {
			if (character < 'A' || character > 'Z') && (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '.' && character != '-' {
				return false
			}
		}
	}
	return true
}

func validMode(value string) bool {
	switch value {
	case "booting", "ready", "blocked", "provisioning", "updating", "await_physical_confirmation":
		return true
	default:
		return false
	}
}

func allowedLogCode(code string) bool {
	switch code {
	case "terminal_ready", "terminal_blocked", "network_connected", "network_disconnected", "pending_actions_changed", "storage_unavailable", "rfid_unavailable", "physical_confirmation_started", "physical_confirmation_cancelled", "factory_reset_failed":
		return true
	default:
		return false
	}
}

func decodePublicEvent(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("invalid event")
	}
	return nil
}

func deviceConnectionError(err error) error {
	if errors.Is(err, serialport.ErrMultipleTerminals) {
		return safeCommandError("Hay varios terminales compatibles; indica --port.")
	}
	return safeCommandError("No se pudo conectar con un terminal OpenJornada.")
}

func deviceOperationError(action string, err error) error {
	if err == nil {
		return safeCommandError("El terminal devolvió una respuesta inesperada.")
	}
	var deviceErr *protocol.DeviceError
	if errors.As(err, &deviceErr) {
		return responseCodeError(deviceErr.Code)
	}
	if errors.Is(err, context.Canceled) {
		return safeCommandError("Operación cancelada.")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return safeCommandError("La operación ha caducado.")
	}
	return safeCommandError("No se pudo " + action + ".")
}

func responseCodeError(code string) error {
	switch code {
	case "pending_actions":
		return safeCommandError("Hay fichajes pendientes; la operación ha sido rechazada.")
	case "portal_required", "mode_denied":
		return safeCommandError("El modo actual del terminal no permite esta operación.")
	case "busy":
		return safeCommandError("El terminal ya está ejecutando otra operación.")
	case "invalid_ojp":
		return safeCommandError("El terminal rechazó el payload OJP.")
	case "physical_confirmation_cancelled", "cancelled":
		return safeCommandError("La confirmación física se ha cancelado.")
	case "physical_confirmation_timeout":
		return safeCommandError("La confirmación física ha caducado.")
	case "factory_reset_failed":
		return safeCommandError("El terminal no pudo completar el restablecimiento.")
	default:
		return safeCommandError("El terminal rechazó la operación.")
	}
}

type commandError struct{ message string }

func (err commandError) Error() string      { return err.message }
func safeCommandError(message string) error { return commandError{message: message} }
