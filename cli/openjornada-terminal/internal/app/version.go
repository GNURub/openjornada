package app

import (
	"fmt"

	"github.com/spf13/cobra"
)

// These values are replaced in release builds with -ldflags -X.
var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func newVersionCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Muestra la versión del CLI",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			_, err := fmt.Fprintf(
				command.OutOrStdout(),
				"version=%s\ncommit=%s\nbuildDate=%s\n",
				version,
				commit,
				buildDate,
			)
			return err
		},
	}
}
