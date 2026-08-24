// Command generate-go-third-party-notices creates a deterministic license
// bundle for every external Go module linked by a target package.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type module struct {
	Path    string
	Version string
	Dir     string
	Main    bool
	Replace *module
}

type listedPackage struct {
	Module *module
}

type component struct {
	name    string
	version string
	dir     string
	files   []string
}

func main() {
	target := flag.String("target", "./cmd/openjornada", "Go package whose linked dependencies are audited")
	output := flag.String("output", "-", "output file, or - for standard output")
	flag.Parse()

	components, err := collectComponents(*target)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	contents, err := render(components)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	if *output == "-" {
		if _, err := os.Stdout.Write(contents); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := os.MkdirAll(filepath.Dir(*output), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(*output, contents, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func collectComponents(target string) ([]component, error) {
	standardLibrary, err := standardLibraryComponent()
	if err != nil {
		return nil, err
	}

	command := exec.Command("go", "list", "-deps", "-json", target)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("prepare go list: %w", err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start go list: %w", err)
	}

	byModule := make(map[string]component)
	decoder := json.NewDecoder(stdout)
	for {
		var pkg listedPackage
		err := decoder.Decode(&pkg)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("decode go list output: %w", err)
		}
		if pkg.Module == nil || pkg.Module.Main {
			continue
		}

		resolved := pkg.Module
		if pkg.Module.Replace != nil {
			resolved = pkg.Module.Replace
		}
		if resolved.Dir == "" {
			return nil, fmt.Errorf("module %s has no resolved source directory", pkg.Module.Path)
		}

		key := pkg.Module.Path + "@" + pkg.Module.Version
		if _, exists := byModule[key]; exists {
			continue
		}
		files, err := licenseFiles(resolved.Dir)
		if err != nil {
			return nil, fmt.Errorf("audit %s: %w", key, err)
		}
		byModule[key] = component{
			name:    pkg.Module.Path,
			version: pkg.Module.Version,
			dir:     resolved.Dir,
			files:   files,
		}
	}
	if err := command.Wait(); err != nil {
		return nil, fmt.Errorf("go list failed: %w: %s", err, strings.TrimSpace(stderr.String()))
	}

	components := make([]component, 0, len(byModule)+1)
	components = append(components, standardLibrary)
	for _, item := range byModule {
		components = append(components, item)
	}
	sort.Slice(components[1:], func(i, j int) bool {
		left := components[i+1]
		right := components[j+1]
		if left.name == right.name {
			return left.version < right.version
		}
		return left.name < right.name
	})
	return components, nil
}

func standardLibraryComponent() (component, error) {
	command := exec.Command("go", "env", "GOROOT")
	output, err := command.Output()
	if err != nil {
		return component{}, fmt.Errorf("resolve GOROOT: %w", err)
	}
	root := strings.TrimSpace(string(output))
	license := filepath.Join(root, "LICENSE")
	if _, err := os.Stat(license); err != nil {
		return component{}, fmt.Errorf("locate Go standard library LICENSE: %w", err)
	}
	return component{
		name:  "Go standard library",
		dir:   root,
		files: []string{"LICENSE"},
	}, nil
}

func licenseFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		upper := strings.ToUpper(name)
		if strings.Contains(upper, "LOGO") {
			continue
		}
		if upper == "LICENSE" || strings.HasPrefix(upper, "LICENSE.") ||
			strings.HasPrefix(upper, "LICENSE-") || upper == "COPYING" ||
			strings.HasPrefix(upper, "COPYING.") || strings.HasPrefix(upper, "COPYING-") ||
			upper == "NOTICE" || strings.HasPrefix(upper, "NOTICE.") ||
			strings.HasPrefix(upper, "NOTICE-") {
			files = append(files, name)
		}
	}
	if len(files) == 0 {
		return nil, errors.New("no root license or notice file found")
	}
	sort.Strings(files)
	return files, nil
}

func render(components []component) ([]byte, error) {
	var output bytes.Buffer
	output.WriteString("OpenJornada Go binary third-party licenses\n")
	output.WriteString("Generated from the packages linked by go list -deps.\n")
	output.WriteString("Do not edit this generated file.\n")

	for _, item := range components {
		output.WriteString("\n================================================================================\n")
		output.WriteString("Component: " + item.name + "\n")
		if item.version != "" {
			output.WriteString("Version: " + item.version + "\n")
		}
		for _, name := range item.files {
			contents, err := os.ReadFile(filepath.Join(item.dir, name))
			if err != nil {
				return nil, fmt.Errorf("read %s %s: %w", item.name, name, err)
			}
			output.WriteString("\n--- " + name + " ---\n\n")
			output.Write(bytes.TrimSpace(contents))
			output.WriteByte('\n')
		}
	}
	return output.Bytes(), nil
}
