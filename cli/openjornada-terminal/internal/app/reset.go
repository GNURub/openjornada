package app

import (
	"context"
	"fmt"
	"time"

	"github.com/spf13/cobra"
)

type resetAcceptance struct {
	PendingCount int `json:"pendingCount"`
}

func newFactoryResetCommand(deps runtimeDependencies) *cobra.Command {
	var port string
	command := &cobra.Command{Use: "factory-reset", Short: "Borra los datos locales con confirmación física", Args: cobra.NoArgs, RunE: func(command *cobra.Command, _ []string) error {
		client, err := deps.connect(command.Context(), port)
		if err != nil {
			return deviceConnectionError(err)
		}
		defer client.Close()
		var status deviceStatus
		statusReceipt, err := client.CallReceipt(command.Context(), "status", struct{}{}, &status)
		if err != nil || statusReceipt.Code != "ok" {
			return deviceOperationError("consultar los fichajes pendientes", err)
		}
		_, _ = fmt.Fprintf(command.OutOrStdout(), "Fichajes pendientes: %d\n", status.PendingCount)
		_, _ = fmt.Fprintln(command.OutOrStdout(), "El borrado no es reversible.")
		var acceptance resetAcceptance
		receipt, err := client.CallReceipt(command.Context(), "factory_reset", struct{}{}, &acceptance)
		if err != nil {
			return deviceOperationError("solicitar el restablecimiento", err)
		}
		if receipt.Code != "physical_confirmation_required" && receipt.Code != "confirmation_required" {
			return responseCodeError(receipt.Code)
		}
		if acceptance.PendingCount != status.PendingCount {
			_, _ = fmt.Fprintf(command.OutOrStdout(), "Fichajes pendientes actualizados: %d\n", acceptance.PendingCount)
		}
		_, _ = fmt.Fprintln(command.OutOrStdout(), "Suelta los botones y mantén SOLO C durante 5 segundos.")
		waitContext, cancel := context.WithTimeout(command.Context(), deps.resetTimeout)
		defer cancel()
		for {
			select {
			case <-waitContext.Done():
				cancelContext, stopCancel := context.WithTimeout(context.Background(), time.Second)
				_, _ = client.CallReceipt(cancelContext, "cancel", struct{}{}, nil)
				stopCancel()
				if command.Context().Err() != nil {
					return deviceOperationError("completar el restablecimiento", command.Context().Err())
				}
				return safeCommandError("No se recibió confirmación física dentro del plazo.")
			case event, ok := <-client.Events():
				if !ok {
					return safeCommandError("Se perdió la conexión durante el restablecimiento.")
				}
				if event.ID != receipt.ID {
					continue
				}
				switch event.Code {
				case "factory_reset_complete", "rebooting":
					_, _ = fmt.Fprintln(command.OutOrStdout(), "Datos borrados. El terminal se está reiniciando.")
					return nil
				case "physical_confirmation_cancelled", "physical_confirmation_timeout", "factory_reset_failed", "cancelled":
					return responseCodeError(event.Code)
				}
			}
		}
	}}
	command.Flags().StringVar(&port, "port", "auto", "Puerto serie o auto")
	return command
}
