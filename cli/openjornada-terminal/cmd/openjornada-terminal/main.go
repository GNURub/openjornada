package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/app"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	command := app.NewRoot(app.Dependencies{
		Stdin:  os.Stdin,
		Stdout: os.Stdout,
		Stderr: os.Stderr,
	})
	if err := command.ExecuteContext(ctx); err != nil {
		_, _ = fmt.Fprintln(command.ErrOrStderr(), err)
		os.Exit(1)
	}
}
