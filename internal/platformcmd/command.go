package platformcmd

import (
	"errors"
	"fmt"
	"io"
	"net/mail"
	"os"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

const operatorsCollection = "platform_operators"

type createOptions struct {
	email string
	name  string
	role  string
}

// Register adds the commands that bootstrap and manage the isolated SaaS
// control-plane identities. Passwords are deliberately read from the terminal
// and are never accepted as command arguments or flags.
func Register(app core.App, root *cobra.Command) {
	platform := &cobra.Command{
		Use:   "platform",
		Short: "Gestiona el plano de control SaaS",
	}
	operators := &cobra.Command{
		Use:   "operator",
		Short: "Gestiona operadores del área de proveedor",
	}
	operators.AddCommand(newCreateCommand(app))
	platform.AddCommand(operators)
	root.AddCommand(platform)
}

func newCreateCommand(app core.App) *cobra.Command {
	options := createOptions{}
	command := &cobra.Command{
		Use:          "create",
		Short:        "Crea un operador sin exponer la contraseña en el historial",
		SilenceUsage: true,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := validateCreateOptions(options); err != nil {
				return err
			}
			password, err := readConfirmedPassword(command.OutOrStdout())
			if err != nil {
				return err
			}
			record, err := createOperator(app, options, password)
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(command.OutOrStdout(), "Operador %s creado con rol %s.\n", record.Email(), record.GetString("role"))
			return err
		},
	}
	command.Flags().StringVar(&options.email, "email", "", "correo del operador")
	command.Flags().StringVar(&options.name, "name", "", "nombre visible del operador")
	command.Flags().StringVar(&options.role, "role", "admin", "rol: admin o support")
	_ = command.MarkFlagRequired("email")
	_ = command.MarkFlagRequired("name")
	return command
}

func validateCreateOptions(options createOptions) error {
	options.email = strings.TrimSpace(strings.ToLower(options.email))
	options.name = strings.TrimSpace(options.name)
	options.role = strings.TrimSpace(options.role)
	address, err := mail.ParseAddress(options.email)
	if err != nil || address.Address != options.email {
		return errors.New("el correo del operador no es válido")
	}
	if options.name == "" || len(options.name) > 160 {
		return errors.New("el nombre debe tener entre 1 y 160 caracteres")
	}
	if options.role != "admin" && options.role != "support" {
		return errors.New("el rol debe ser admin o support")
	}
	return nil
}

func readConfirmedPassword(output io.Writer) (string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", errors.New("la contraseña sólo puede introducirse desde un terminal interactivo")
	}
	if _, err := fmt.Fprint(output, "Contraseña (mínimo 12 caracteres): "); err != nil {
		return "", err
	}
	first, err := term.ReadPassword(int(os.Stdin.Fd()))
	if err != nil {
		return "", fmt.Errorf("no se pudo leer la contraseña: %w", err)
	}
	if _, err := fmt.Fprint(output, "\nRepite la contraseña: "); err != nil {
		return "", err
	}
	second, err := term.ReadPassword(int(os.Stdin.Fd()))
	if _, printErr := fmt.Fprintln(output); printErr != nil && err == nil {
		err = printErr
	}
	if err != nil {
		return "", fmt.Errorf("no se pudo confirmar la contraseña: %w", err)
	}
	password := string(first)
	if len(password) < 12 {
		return "", errors.New("la contraseña debe tener al menos 12 caracteres")
	}
	if password != string(second) {
		return "", errors.New("las contraseñas no coinciden")
	}
	return password, nil
}

func createOperator(app core.App, options createOptions, password string) (*core.Record, error) {
	if err := validateCreateOptions(options); err != nil {
		return nil, err
	}
	collection, err := app.FindCollectionByNameOrId(operatorsCollection)
	if err != nil {
		return nil, fmt.Errorf("no existe el esquema SaaS; aplica primero las migraciones: %w", err)
	}
	if _, err := app.FindAuthRecordByEmail(collection, options.email); err == nil {
		return nil, errors.New("ya existe un operador con ese correo")
	}
	record := core.NewRecord(collection)
	record.SetEmail(strings.ToLower(strings.TrimSpace(options.email)))
	record.SetPassword(password)
	record.Set("name", strings.TrimSpace(options.name))
	record.Set("role", options.role)
	record.Set("active", true)
	record.SetVerified(true)
	if err := app.Save(record); err != nil {
		return nil, fmt.Errorf("no se pudo crear el operador: %w", err)
	}
	return record, nil
}
