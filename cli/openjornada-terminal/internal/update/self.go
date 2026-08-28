package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/release"
)

const (
	checksumsAssetName  = "checksums.txt"
	maxChecksumsBytes   = 1024 * 1024
	maxSelfArchiveBytes = 64 * 1024 * 1024
	maxSelfBinaryBytes  = 64 * 1024 * 1024
	maxLegalFileBytes   = 4 * 1024 * 1024
)

var (
	ErrSelfUpdate            = errors.New("update: self-update failed")
	ErrSelfPlatform          = errors.New("update: unsupported self-update platform")
	ErrSelfChecksum          = errors.New("update: self-update checksum mismatch")
	ErrSelfChecksumContract  = errors.New("update: invalid checksums contract")
	ErrSelfArchive           = errors.New("update: invalid self-update archive")
	ErrSelfReplacedNotSynced = errors.New("update: executable replaced but directory sync failed")
)

// SelfUpdateDependencies isolates platform, network and process replacement so
// the complete update policy can be tested without touching GitHub or the
// running executable.
type SelfUpdateDependencies struct {
	GOOS              string
	GOARCH            string
	ExecutablePath    func() (string, error)
	ResolveExecutable func(string) (string, error)
	LatestAssets      func(context.Context, []string) (string, map[string]string, error)
	DownloadAsset     func(context.Context, string, int64) ([]byte, error)
	Replace           func(string, []byte) error
}

// UpdateSelf updates the current executable using production dependencies.
func UpdateSelf(ctx context.Context) (string, error) {
	return SelfUpdate(ctx, SelfUpdateDependencies{})
}

// SelfUpdate downloads, authenticates and installs the release archive for the
// selected Go target. No archive entry is used before the archive checksum is
// validated.
func SelfUpdate(ctx context.Context, dependencies SelfUpdateDependencies) (string, error) {
	if ctx == nil {
		return "", ErrSelfUpdate
	}
	goos := dependencies.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	goarch := dependencies.GOARCH
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	archiveName, err := selfArchiveName(goos, goarch)
	if err != nil {
		return "", err
	}
	latestAssets := dependencies.LatestAssets
	if latestAssets == nil {
		latestAssets = release.LatestStableAssets
	}
	downloadAsset := dependencies.DownloadAsset
	if downloadAsset == nil {
		downloadAsset = release.DownloadAsset
	}
	executablePath := dependencies.ExecutablePath
	if executablePath == nil {
		executablePath = os.Executable
	}
	resolveExecutable := dependencies.ResolveExecutable
	if resolveExecutable == nil {
		resolveExecutable = filepath.EvalSymlinks
	}
	replace := dependencies.Replace
	if replace == nil {
		replace = platformReplace
	}

	tag, assets, err := latestAssets(ctx, []string{archiveName, checksumsAssetName})
	if err != nil {
		return "", ErrSelfUpdate
	}
	archiveURL, archiveOK := assets[archiveName]
	checksumsURL, checksumsOK := assets[checksumsAssetName]
	if !archiveOK || !checksumsOK || archiveURL == "" || checksumsURL == "" || len(assets) != 2 {
		return "", ErrSelfUpdate
	}
	archive, err := downloadAsset(ctx, archiveURL, maxSelfArchiveBytes)
	if err != nil {
		return "", ErrSelfUpdate
	}
	checksums, err := downloadAsset(ctx, checksumsURL, maxChecksumsBytes)
	if err != nil {
		return "", ErrSelfUpdate
	}
	expected, err := matchingChecksum(checksums, archiveName)
	if err != nil {
		return "", err
	}
	actual := sha256.Sum256(archive)
	if !bytes.Equal(actual[:], expected[:]) {
		return "", ErrSelfChecksum
	}
	binary, err := extractSelfArchive(archive, goos)
	if err != nil {
		return "", err
	}
	path, err := executablePath()
	if err != nil || path == "" || !filepath.IsAbs(path) {
		return "", ErrSelfUpdate
	}
	path, err = resolveExecutable(path)
	if err != nil || path == "" || !filepath.IsAbs(path) {
		return "", ErrSelfUpdate
	}
	if err := replace(path, binary); err != nil {
		if errors.Is(err, ErrSelfReplacedNotSynced) {
			return "", ErrSelfReplacedNotSynced
		}
		return "", ErrSelfUpdate
	}
	return tag, nil
}

func selfArchiveName(goos, goarch string) (string, error) {
	if goarch != "amd64" && goarch != "arm64" {
		return "", ErrSelfPlatform
	}
	extension := ".tar.gz"
	switch goos {
	case "linux", "darwin":
	case "windows":
		extension = ".zip"
	default:
		return "", ErrSelfPlatform
	}
	return fmt.Sprintf("openjornada-terminal_%s_%s%s", goos, goarch, extension), nil
}

func matchingChecksum(contents []byte, archiveName string) ([sha256.Size]byte, error) {
	var digest [sha256.Size]byte
	matches := 0
	var decoded []byte
	for _, line := range strings.Split(string(contents), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		name := strings.TrimPrefix(fields[1], "*")
		if name != archiveName {
			continue
		}
		matches++
		value, err := hex.DecodeString(fields[0])
		if err != nil || len(value) != sha256.Size {
			return digest, ErrSelfChecksumContract
		}
		decoded = value
	}
	if matches != 1 {
		return digest, ErrSelfChecksumContract
	}
	copy(digest[:], decoded)
	return digest, nil
}

func extractSelfArchive(contents []byte, goos string) ([]byte, error) {
	binaryName := "openjornada-terminal"
	if goos == "windows" {
		binaryName += ".exe"
	}
	expected := map[string]int64{
		binaryName:            maxSelfBinaryBytes,
		"LICENSE":             maxLegalFileBytes,
		"NOTICE":              maxLegalFileBytes,
		"THIRD_PARTY_NOTICES": maxLegalFileBytes,
	}
	var files map[string][]byte
	var err error
	if goos == "windows" {
		files, err = extractZip(contents, expected)
	} else {
		files, err = extractTarGzip(contents, expected)
	}
	if err != nil || len(files) != len(expected) {
		return nil, ErrSelfArchive
	}
	for name := range expected {
		if len(files[name]) == 0 {
			return nil, ErrSelfArchive
		}
	}
	return files[binaryName], nil
}

func extractTarGzip(contents []byte, expected map[string]int64) (map[string][]byte, error) {
	compressed, err := gzip.NewReader(bytes.NewReader(contents))
	if err != nil {
		return nil, ErrSelfArchive
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	files := make(map[string][]byte, len(expected))
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil || header == nil || header.Typeflag != tar.TypeReg {
			return nil, ErrSelfArchive
		}
		maximum, ok := expected[header.Name]
		if !ok || header.Name != filepath.ToSlash(filepath.Clean(header.Name)) || header.Size < 0 || header.Size > maximum {
			return nil, ErrSelfArchive
		}
		if _, duplicate := files[header.Name]; duplicate {
			return nil, ErrSelfArchive
		}
		value, err := readBounded(reader, maximum)
		if err != nil || int64(len(value)) != header.Size {
			return nil, ErrSelfArchive
		}
		files[header.Name] = value
	}
	return files, nil
}

func extractZip(contents []byte, expected map[string]int64) (map[string][]byte, error) {
	reader, err := zip.NewReader(bytes.NewReader(contents), int64(len(contents)))
	if err != nil {
		return nil, ErrSelfArchive
	}
	files := make(map[string][]byte, len(expected))
	for _, entry := range reader.File {
		maximum, ok := expected[entry.Name]
		mode := entry.Mode()
		if !ok || entry.Name != filepath.ToSlash(filepath.Clean(entry.Name)) || !mode.IsRegular() || mode&os.ModeSymlink != 0 || int64(entry.UncompressedSize64) > maximum {
			return nil, ErrSelfArchive
		}
		if _, duplicate := files[entry.Name]; duplicate {
			return nil, ErrSelfArchive
		}
		opened, err := entry.Open()
		if err != nil {
			return nil, ErrSelfArchive
		}
		value, readErr := readBounded(opened, maximum)
		closeErr := opened.Close()
		if readErr != nil || closeErr != nil || uint64(len(value)) != entry.UncompressedSize64 {
			return nil, ErrSelfArchive
		}
		files[entry.Name] = value
	}
	return files, nil
}

func readBounded(reader io.Reader, maximum int64) ([]byte, error) {
	value, err := io.ReadAll(io.LimitReader(reader, maximum+1))
	if err != nil || int64(len(value)) > maximum {
		return nil, ErrSelfArchive
	}
	return value, nil
}

type syncFile interface {
	io.Writer
	Chmod(os.FileMode) error
	Sync() error
	Close() error
	Name() string
}

type replacementFS interface {
	CreateTemp(string, string) (syncFile, error)
	OpenFile(string, int, os.FileMode) (syncFile, error)
	Open(string) (syncFile, error)
	Rename(string, string) error
	Remove(string) error
}

type osReplacementFS struct{}

func (osReplacementFS) CreateTemp(dir, pattern string) (syncFile, error) {
	return os.CreateTemp(dir, pattern)
}
func (osReplacementFS) OpenFile(name string, flag int, mode os.FileMode) (syncFile, error) {
	return os.OpenFile(name, flag, mode)
}
func (osReplacementFS) Open(name string) (syncFile, error)   { return os.Open(name) }
func (osReplacementFS) Rename(oldPath, newPath string) error { return os.Rename(oldPath, newPath) }
func (osReplacementFS) Remove(name string) error             { return os.Remove(name) }

type processLauncher interface{ Start(string, ...string) error }

type execProcessLauncher struct{}

func (execProcessLauncher) Start(name string, arguments ...string) error {
	command := exec.Command(name, arguments...)
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
