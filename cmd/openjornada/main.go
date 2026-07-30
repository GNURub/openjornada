package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/GNURub/openjornada/internal/mcpserver"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/osutils"
)

const pocketBaseVersion = "0.39.10"

func main() {
	pocketbase.Version = pocketBaseVersion
	app := pocketbase.New()

	var hooksDir string
	app.RootCmd.PersistentFlags().StringVar(&hooksDir, "hooksDir", "", "the directory with the JS app hooks")
	var hooksWatch bool
	app.RootCmd.PersistentFlags().BoolVar(&hooksWatch, "hooksWatch", true, "auto restart on pb_hooks changes")
	var hooksPool int
	app.RootCmd.PersistentFlags().IntVar(&hooksPool, "hooksPool", 15, "prewarmed JS runtimes")
	var migrationsDir string
	app.RootCmd.PersistentFlags().StringVar(&migrationsDir, "migrationsDir", "", "the user migrations directory")
	var automigrate bool
	app.RootCmd.PersistentFlags().BoolVar(&automigrate, "automigrate", true, "enable auto migrations")
	var publicDir string
	app.RootCmd.PersistentFlags().StringVar(&publicDir, "publicDir", defaultPublicDir(), "the static frontend directory")
	var indexFallback bool
	app.RootCmd.PersistentFlags().BoolVar(&indexFallback, "indexFallback", true, "serve index.html for unknown frontend routes")
	app.RootCmd.ParseFlags(os.Args[1:])

	jsvm.MustRegister(app, jsvm.Config{
		MigrationsDir: migrationsDir,
		HooksDir:      hooksDir,
		HooksWatch:    hooksWatch,
		HooksPoolSize: hooksPool,
	})
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{
		TemplateLang: migratecmd.TemplateLangJS,
		Automigrate:  automigrate,
		Dir:          migrationsDir,
	})

	mcpService := mcpserver.New(app)
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		mcpService.Register(e)
		return e.Next()
	})

	app.OnServe().Bind(&hook.Handler[*core.ServeEvent]{
		Priority: 999,
		Func: func(e *core.ServeEvent) error {
			if !e.Router.HasRoute(http.MethodGet, "/{path...}") {
				e.Router.GET("/{path...}", apis.Static(os.DirFS(publicDir), indexFallback))
			}
			return e.Next()
		},
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

func defaultPublicDir() string {
	if osutils.IsProbablyGoRun() {
		return "./pb_public"
	}
	return filepath.Join(os.Args[0], "../pb_public")
}
