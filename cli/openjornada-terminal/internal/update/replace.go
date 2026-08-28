package update

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func replaceUnix(executablePath string, binary []byte, fs replacementFS) (resultErr error) {
	directory := filepath.Dir(executablePath)
	parent, err := fs.Open(directory)
	if err != nil {
		return err
	}
	parentClosed := false
	defer func() {
		if !parentClosed {
			_ = parent.Close()
		}
	}()
	temporary, err := fs.CreateTemp(directory, ".openjornada-terminal-update-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	renamed := false
	defer func() {
		if !renamed {
			_ = fs.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o755); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(binary); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := fs.Rename(temporaryPath, executablePath); err != nil {
		return err
	}
	renamed = true
	if err := parent.Sync(); err != nil {
		_ = parent.Close()
		parentClosed = true
		return ErrSelfReplacedNotSynced
	}
	if err := parent.Close(); err != nil {
		parentClosed = true
		return ErrSelfReplacedNotSynced
	}
	parentClosed = true
	return nil
}

func replaceWindows(executablePath string, binary []byte, pid int, fs replacementFS, launcher processLauncher) (resultErr error) {
	newPath := executablePath + ".new"
	newFile, err := fs.OpenFile(newPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	newReady := false
	defer func() {
		if !newReady || resultErr != nil {
			_ = fs.Remove(newPath)
		}
	}()
	if _, err := newFile.Write(binary); err != nil {
		_ = newFile.Close()
		return err
	}
	if err := newFile.Sync(); err != nil {
		_ = newFile.Close()
		return err
	}
	if err := newFile.Close(); err != nil {
		return err
	}
	newReady = true

	script, err := fs.CreateTemp(filepath.Dir(executablePath), ".openjornada-terminal-update-*.ps1")
	if err != nil {
		return err
	}
	scriptPath := script.Name()
	launched := false
	defer func() {
		if !launched {
			_ = fs.Remove(scriptPath)
		}
	}()
	contents := windowsReplacementScript(newPath, executablePath, pid)
	if _, err := script.Write([]byte(contents)); err != nil {
		_ = script.Close()
		return err
	}
	if err := script.Sync(); err != nil {
		_ = script.Close()
		return err
	}
	if err := script.Close(); err != nil {
		return err
	}
	if err := launcher.Start("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath); err != nil {
		return err
	}
	launched = true
	return nil
}

func windowsReplacementScript(newPath, executablePath string, pid int) string {
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	return fmt.Sprintf("$ErrorActionPreference = 'Stop'\r\ntry {\r\n  Wait-Process -Id %d -ErrorAction SilentlyContinue\r\n  Move-Item -LiteralPath %s -Destination %s -Force\r\n} finally {\r\n  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue\r\n}\r\n", pid, quote(newPath), quote(executablePath))
}
