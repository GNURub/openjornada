package app

import (
	"bytes"
	"fmt"
	"io"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/ojp"
	"github.com/spf13/cobra"
)

func newProvisionCommand(deps runtimeDependencies) *cobra.Command {
	var port string
	var fromStdin bool
	command := &cobra.Command{Use: "provision", Short: "Aprovisiona el terminal mediante OJP", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		client, err := deps.connect(command.Context(), port)
		if err != nil {
			return deviceConnectionError(err)
		}
		defer client.Close()
		status, err := readPublicStatus(command.Context(), client)
		if err != nil {
			return deviceOperationError("consultar el modo", err)
		}
		if status.Mode != "provisioning" {
			return safeCommandError("Activa primero el modo de configuración manteniendo A+B durante 5 segundos.")
		}
		var input []byte
		if fromStdin {
			input, err = readBoundedOJP(command.InOrStdin())
		} else {
			_, _ = fmt.Fprint(command.ErrOrStderr(), "Pega el valor OJP (entrada oculta): ")
			input, err = deps.readPassword()
			_, _ = fmt.Fprintln(command.ErrOrStderr())
		}
		if err != nil {
			return safeCommandError("No se pudo leer el payload OJP.")
		}
		payload, err := ojp.Parse(input)
		if err != nil {
			return safeCommandError("El payload OJP no es válido.")
		}
		receipt, err := client.CallReceipt(command.Context(), "provision", map[string]string{"ojp": string(payload.Encoded)}, nil)
		if err != nil {
			return deviceOperationError("iniciar el aprovisionamiento", err)
		}
		if receipt.Code != "accepted" {
			return responseCodeError(receipt.Code)
		}
		_, _ = fmt.Fprintln(command.OutOrStdout(), "Payload aceptado.")
		for {
			select {
			case <-command.Context().Done():
				return deviceOperationError("completar el aprovisionamiento", command.Context().Err())
			case event, ok := <-client.Events():
				if !ok {
					return safeCommandError("Se perdió la conexión durante el aprovisionamiento.")
				}
				if event.ID != receipt.ID {
					continue
				}
				switch event.Code {
				case "connecting":
					_, _ = fmt.Fprintln(command.OutOrStdout(), "Conectando con la red Wi-Fi.")
				case "validating":
					_, _ = fmt.Fprintln(command.OutOrStdout(), "Validando el servidor de OpenJornada.")
				case "saved":
					_, _ = fmt.Fprintln(command.OutOrStdout(), "Configuración guardada.")
					return nil
				case "provision_failed":
					return safeCommandError("No se pudo completar el aprovisionamiento.")
				case "cancelled", "physical_confirmation_cancelled":
					return responseCodeError(event.Code)
				}
			}
		}
	}}
	command.Flags().StringVar(&port, "port", "auto", "Puerto serie o auto")
	command.Flags().BoolVar(&fromStdin, "ojp-stdin", false, "Lee OJP desde stdin")
	return command
}

func readBoundedOJP(reader io.Reader) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(reader, 602))
	if err != nil || len(raw) == 0 || len(raw) > 601 {
		return nil, io.ErrUnexpectedEOF
	}
	end := len(raw)
	for index, value := range raw {
		if isOJPWhitespace(value) {
			end = index
			break
		}
	}
	if end == 0 || end > 600 {
		return nil, io.ErrUnexpectedEOF
	}
	for _, value := range raw[end:] {
		if !isOJPWhitespace(value) {
			return nil, io.ErrUnexpectedEOF
		}
	}
	return bytes.Clone(raw[:end]), nil
}

func isOJPWhitespace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n'
}
