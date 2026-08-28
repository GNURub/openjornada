//go:build windows

package update

import "os"

func platformReplace(executablePath string, binary []byte) error {
	return replaceWindows(executablePath, binary, os.Getpid(), osReplacementFS{}, execProcessLauncher{})
}
