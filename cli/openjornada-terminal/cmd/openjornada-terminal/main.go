package main

import (
	"fmt"
	"os"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/app"
)

func main() {
	command := app.NewRoot(app.Dependencies{
		Stdin:  os.Stdin,
		Stdout: os.Stdout,
		Stderr: os.Stderr,
	})
	if err := command.Execute(); err != nil {
		_, _ = fmt.Fprintln(command.ErrOrStderr(), err)
		os.Exit(1)
	}
}
