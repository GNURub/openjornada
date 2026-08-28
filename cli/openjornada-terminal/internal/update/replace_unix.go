//go:build !windows

package update

func platformReplace(executablePath string, binary []byte) error {
	return replaceUnix(executablePath, binary, osReplacementFS{})
}
