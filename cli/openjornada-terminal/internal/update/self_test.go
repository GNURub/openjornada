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
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSelfUpdateVerifiesChecksumAndReplacesExpectedBinary(t *testing.T) {
	archive := tarArchive(t, map[string]tarFixture{
		"openjornada-terminal": {body: []byte("new executable")},
		"LICENSE":              {body: []byte("project license")},
		"NOTICE":               {body: []byte("project notice")},
		"THIRD_PARTY_NOTICES":  {body: []byte("dependency licenses")},
	})
	digest := sha256.Sum256(archive)
	archiveName := "openjornada-terminal_linux_amd64.tar.gz"
	assets := map[string]string{archiveName: "archive-url", checksumsAssetName: "checksums-url"}
	var replacedPath string
	var replacedBinary []byte
	got, err := SelfUpdate(context.Background(), SelfUpdateDependencies{
		GOOS: "linux", GOARCH: "amd64",
		ExecutablePath:    func() (string, error) { return "/opt/bin/openjornada-terminal", nil },
		ResolveExecutable: func(path string) (string, error) { return path, nil },
		LatestAssets: func(_ context.Context, names []string) (string, map[string]string, error) {
			if strings.Join(names, ",") != archiveName+","+checksumsAssetName {
				t.Fatalf("asset names = %v", names)
			}
			return "v1.2.3", assets, nil
		},
		DownloadAsset: func(_ context.Context, source string, maximum int64) ([]byte, error) {
			switch source {
			case "archive-url":
				if maximum != maxSelfArchiveBytes {
					t.Fatalf("archive maximum = %d", maximum)
				}
				return archive, nil
			case "checksums-url":
				if maximum != maxChecksumsBytes {
					t.Fatalf("checksums maximum = %d", maximum)
				}
				return []byte(hex.EncodeToString(digest[:]) + "  " + archiveName + "\n"), nil
			default:
				t.Fatalf("unexpected source %q", source)
				return nil, nil
			}
		},
		Replace: func(path string, binary []byte) error {
			replacedPath = path
			replacedBinary = bytes.Clone(binary)
			return nil
		},
	})
	if err != nil {
		t.Fatalf("SelfUpdate() error = %v", err)
	}
	if got != "v1.2.3" {
		t.Fatalf("release = %q", got)
	}
	if replacedPath != "/opt/bin/openjornada-terminal" || string(replacedBinary) != "new executable" {
		t.Fatalf("replacement = (%q, %q)", replacedPath, replacedBinary)
	}
}

func TestSelfUpdateResolvesEverySupportedArchive(t *testing.T) {
	tests := []struct{ goos, goarch, want string }{
		{"linux", "amd64", "openjornada-terminal_linux_amd64.tar.gz"},
		{"linux", "arm64", "openjornada-terminal_linux_arm64.tar.gz"},
		{"darwin", "amd64", "openjornada-terminal_darwin_amd64.tar.gz"},
		{"darwin", "arm64", "openjornada-terminal_darwin_arm64.tar.gz"},
		{"windows", "amd64", "openjornada-terminal_windows_amd64.zip"},
		{"windows", "arm64", "openjornada-terminal_windows_arm64.zip"},
	}
	for _, test := range tests {
		t.Run(test.goos+"_"+test.goarch, func(t *testing.T) {
			got, err := selfArchiveName(test.goos, test.goarch)
			if err != nil || got != test.want {
				t.Fatalf("selfArchiveName() = (%q, %v)", got, err)
			}
		})
	}
	if _, err := selfArchiveName("freebsd", "amd64"); !errors.Is(err, ErrSelfPlatform) {
		t.Fatalf("unsupported platform error = %v", err)
	}
}

func TestSelfUpdateRejectsChecksumMismatchAndDuplicateMatch(t *testing.T) {
	archive := []byte("archive")
	name := "openjornada-terminal_linux_amd64.tar.gz"
	tests := []struct {
		name, checksums string
		want            error
	}{
		{"mismatch", strings.Repeat("0", 64) + "  " + name + "\n", ErrSelfChecksum},
		{"duplicate", strings.Repeat("0", 64) + "  " + name + "\n" + strings.Repeat("0", 64) + " *" + name + "\n", ErrSelfChecksumContract},
		{"missing", strings.Repeat("0", 64) + "  another.tar.gz\n", ErrSelfChecksumContract},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			replaced := false
			_, err := SelfUpdate(context.Background(), SelfUpdateDependencies{
				GOOS: "linux", GOARCH: "amd64", ExecutablePath: func() (string, error) { return "/bin/tool", nil },
				LatestAssets: func(context.Context, []string) (string, map[string]string, error) {
					return "v1.2.3", map[string]string{name: "archive", checksumsAssetName: "checksums"}, nil
				},
				DownloadAsset: func(_ context.Context, source string, _ int64) ([]byte, error) {
					if source == "archive" {
						return archive, nil
					}
					return []byte(test.checksums), nil
				},
				Replace: func(string, []byte) error { replaced = true; return nil },
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("SelfUpdate() error = %v, want %v", err, test.want)
			}
			if replaced {
				t.Fatal("replacement ran before checksum validation")
			}
		})
	}
}

func TestExtractSelfArchiveRejectsUnsafeOrUnexpectedEntries(t *testing.T) {
	valid := map[string]tarFixture{
		"openjornada-terminal": {body: []byte("binary")}, "LICENSE": {body: []byte("license")},
		"NOTICE": {body: []byte("notice")}, "THIRD_PARTY_NOTICES": {body: []byte("third party")},
	}
	tests := []struct {
		name    string
		entries map[string]tarFixture
	}{
		{"path traversal", mergeTar(valid, map[string]tarFixture{"../escape": {body: []byte("x")}})},
		{"symlink", mergeTar(valid, map[string]tarFixture{"extra": {typeflag: tar.TypeSymlink, linkname: "openjornada-terminal"}})},
		{"unexpected", mergeTar(valid, map[string]tarFixture{"extra": {body: []byte("x")}})},
		{"missing notice", withoutTar(valid, "NOTICE")},
		{"directory prefix", map[string]tarFixture{
			"bundle/openjornada-terminal": {body: []byte("binary")}, "bundle/LICENSE": {body: []byte("license")},
			"bundle/NOTICE": {body: []byte("notice")}, "bundle/THIRD_PARTY_NOTICES": {body: []byte("third party")},
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := extractSelfArchive(tarArchive(t, test.entries), "linux")
			if !errors.Is(err, ErrSelfArchive) {
				t.Fatalf("extractSelfArchive() error = %v", err)
			}
		})
	}
}

func TestExtractSelfArchiveRejectsTarDuplicate(t *testing.T) {
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	tw := tar.NewWriter(gz)
	for _, name := range []string{"openjornada-terminal", "openjornada-terminal", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES"} {
		body := []byte(name)
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := extractSelfArchive(compressed.Bytes(), "linux"); !errors.Is(err, ErrSelfArchive) {
		t.Fatalf("duplicate error = %v", err)
	}
}

func TestExtractSelfArchiveValidatesWindowsZipMatrix(t *testing.T) {
	valid := []namedZipFixture{
		{name: "openjornada-terminal.exe", zipFixture: zipFixture{body: []byte("binary")}},
		{name: "LICENSE", zipFixture: zipFixture{body: []byte("license")}},
		{name: "NOTICE", zipFixture: zipFixture{body: []byte("notice")}},
		{name: "THIRD_PARTY_NOTICES", zipFixture: zipFixture{body: []byte("third party")}},
	}
	binary, err := extractSelfArchive(zipArchiveEntries(t, valid), "windows")
	if err != nil || string(binary) != "binary" {
		t.Fatalf("extractSelfArchive() = (%q, %v)", binary, err)
	}
	tests := []struct {
		name    string
		entries []namedZipFixture
	}{
		{"traversal", appendZip(valid, namedZipFixture{name: "../escape", zipFixture: zipFixture{body: []byte("x")}})},
		{"symlink", appendZip(valid, namedZipFixture{name: "extra", zipFixture: zipFixture{body: []byte("target"), mode: os.ModeSymlink | 0o777}})},
		{"duplicate", appendZip(valid, namedZipFixture{name: "LICENSE", zipFixture: zipFixture{body: []byte("second")}})},
		{"unexpected", appendZip(valid, namedZipFixture{name: "extra", zipFixture: zipFixture{body: []byte("x")}})},
		{"missing", append([]namedZipFixture(nil), valid[:len(valid)-1]...)},
		{"empty", replaceZip(valid, "NOTICE", zipFixture{})},
		{"oversized", replaceZip(valid, "NOTICE", zipFixture{body: bytes.Repeat([]byte{'x'}, maxLegalFileBytes+1)})},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := extractSelfArchive(zipArchiveEntries(t, test.entries), "windows"); !errors.Is(err, ErrSelfArchive) {
				t.Fatalf("extractSelfArchive() error = %v", err)
			}
		})
	}
}

func TestSelfUpdateResolvesExecutableSymlinkBeforeReplacement(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "versions", "openjornada-terminal")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "openjornada-terminal")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	archive := tarArchive(t, map[string]tarFixture{
		"openjornada-terminal": {body: []byte("new")}, "LICENSE": {body: []byte("license")},
		"NOTICE": {body: []byte("notice")}, "THIRD_PARTY_NOTICES": {body: []byte("third party")},
	})
	digest := sha256.Sum256(archive)
	name := "openjornada-terminal_linux_amd64.tar.gz"
	var replaced string
	_, err := SelfUpdate(context.Background(), SelfUpdateDependencies{
		GOOS: "linux", GOARCH: "amd64", ExecutablePath: func() (string, error) { return link, nil },
		LatestAssets: func(context.Context, []string) (string, map[string]string, error) {
			return "v1.0.0", map[string]string{name: "archive", checksumsAssetName: "checksums"}, nil
		},
		DownloadAsset: func(_ context.Context, source string, _ int64) ([]byte, error) {
			if source == "archive" {
				return archive, nil
			}
			return []byte(hex.EncodeToString(digest[:]) + "  " + name + "\n"), nil
		},
		Replace: func(path string, _ []byte) error { replaced = path; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if replaced != target {
		t.Fatalf("replacement path = %q, want %q", replaced, target)
	}
}

func TestReplaceUnixWritesSameDirectoryModeSyncsAndRenames(t *testing.T) {
	fs := newFakeReplacementFS()
	if err := replaceUnix("/usr/local/bin/openjornada-terminal", []byte("new"), fs); err != nil {
		t.Fatal(err)
	}
	if fs.tempDir != "/usr/local/bin" {
		t.Fatalf("temp dir = %q", fs.tempDir)
	}
	if fs.temp.mode != 0o755 || string(fs.temp.contents) != "new" || !fs.temp.synced || !fs.temp.closed {
		t.Fatalf("temporary file = %+v", fs.temp)
	}
	if fs.renamedFrom != fs.temp.name || fs.renamedTo != "/usr/local/bin/openjornada-terminal" {
		t.Fatalf("rename = %q -> %q", fs.renamedFrom, fs.renamedTo)
	}
	if fs.directory == nil || !fs.directory.synced || !fs.directory.closed {
		t.Fatal("parent directory was not fsynced")
	}
}

func TestReplaceUnixReportsInstalledButNotDurableAfterDirectorySyncFailure(t *testing.T) {
	fs := newFakeReplacementFS()
	fs.directorySyncErr = errors.New("sync failed")
	err := replaceUnix("/usr/local/bin/openjornada-terminal", []byte("new"), fs)
	if !errors.Is(err, ErrSelfReplacedNotSynced) {
		t.Fatalf("replaceUnix() error = %v", err)
	}
	if fs.renamedTo == "" {
		t.Fatal("replacement did not occur before durability error")
	}
}

func TestReplaceWindowsWritesNewAndLaunchesBoundedPowerShellScript(t *testing.T) {
	fs := newFakeReplacementFS()
	launcher := &fakeLauncher{}
	target := `C:\Program Files\OpenJornada\openjornada-terminal.exe`
	if err := replaceWindows(target, []byte("new"), 4242, fs, launcher); err != nil {
		t.Fatal(err)
	}
	newFile := fs.files[target+".new"]
	if newFile == nil || string(newFile.contents) != "new" || !newFile.synced || !newFile.closed {
		t.Fatal(".new file was not durably written")
	}
	script := string(fs.temp.contents)
	for _, want := range []string{"Wait-Process -Id 4242", "Move-Item -LiteralPath '" + target + ".new' -Destination '" + target + "' -Force", "Remove-Item -LiteralPath $PSCommandPath"} {
		if !strings.Contains(script, want) {
			t.Fatalf("script lacks %q:\n%s", want, script)
		}
	}
	if strings.Contains(script, "Remove-Item -Recurse") || strings.Contains(script, "*.new") {
		t.Fatalf("script has broad target:\n%s", script)
	}
	if launcher.name != "powershell.exe" || !containsArg(launcher.args, fs.temp.name) {
		t.Fatalf("launcher = %q %v", launcher.name, launcher.args)
	}
}

type tarFixture struct {
	body     []byte
	typeflag byte
	linkname string
}

func tarArchive(t *testing.T, entries map[string]tarFixture) []byte {
	t.Helper()
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	tw := tar.NewWriter(gz)
	for name, entry := range entries {
		typeflag := entry.typeflag
		if typeflag == 0 {
			typeflag = tar.TypeReg
		}
		header := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(entry.body)), Typeflag: typeflag, Linkname: entry.linkname}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if len(entry.body) > 0 {
			if _, err := tw.Write(entry.body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return compressed.Bytes()
}

type zipFixture struct {
	body []byte
	mode os.FileMode
}

type namedZipFixture struct {
	name string
	zipFixture
}

func zipArchive(t *testing.T, entries map[string]zipFixture) []byte {
	t.Helper()
	var contents bytes.Buffer
	zw := zip.NewWriter(&contents)
	for name, entry := range entries {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		if entry.mode != 0 {
			header.SetMode(entry.mode)
		} else {
			header.SetMode(0o644)
		}
		writer, err := zw.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(entry.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return contents.Bytes()
}

func zipArchiveEntries(t *testing.T, entries []namedZipFixture) []byte {
	t.Helper()
	var contents bytes.Buffer
	zw := zip.NewWriter(&contents)
	for _, named := range entries {
		header := &zip.FileHeader{Name: named.name, Method: zip.Deflate}
		if named.mode != 0 {
			header.SetMode(named.mode)
		} else {
			header.SetMode(0o644)
		}
		writer, err := zw.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(named.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return contents.Bytes()
}

func appendZip(entries []namedZipFixture, entry namedZipFixture) []namedZipFixture {
	result := append([]namedZipFixture(nil), entries...)
	return append(result, entry)
}

func replaceZip(entries []namedZipFixture, name string, replacement zipFixture) []namedZipFixture {
	result := append([]namedZipFixture(nil), entries...)
	for index := range result {
		if result[index].name == name {
			result[index].zipFixture = replacement
		}
	}
	return result
}

func mergeTar(left, right map[string]tarFixture) map[string]tarFixture {
	result := map[string]tarFixture{}
	for name, value := range left {
		result[name] = value
	}
	for name, value := range right {
		result[name] = value
	}
	return result
}

func withoutTar(input map[string]tarFixture, excluded string) map[string]tarFixture {
	result := map[string]tarFixture{}
	for name, value := range input {
		if name != excluded {
			result[name] = value
		}
	}
	return result
}

type fakeSyncFile struct {
	name           string
	contents       []byte
	mode           os.FileMode
	synced, closed bool
	syncErr        error
}

func (file *fakeSyncFile) Write(value []byte) (int, error) {
	file.contents = append(file.contents, value...)
	return len(value), nil
}
func (file *fakeSyncFile) Chmod(mode os.FileMode) error { file.mode = mode; return nil }
func (file *fakeSyncFile) Sync() error                  { file.synced = true; return file.syncErr }
func (file *fakeSyncFile) Close() error                 { file.closed = true; return nil }
func (file *fakeSyncFile) Name() string                 { return file.name }

type fakeReplacementFS struct {
	tempDir, renamedFrom, renamedTo string
	temp, directory                 *fakeSyncFile
	files                           map[string]*fakeSyncFile
	directorySyncErr                error
}

func newFakeReplacementFS() *fakeReplacementFS {
	return &fakeReplacementFS{files: map[string]*fakeSyncFile{}}
}
func (fs *fakeReplacementFS) CreateTemp(dir, _ string) (syncFile, error) {
	fs.tempDir = dir
	fs.temp = &fakeSyncFile{name: filepath.Join(dir, "update-temp")}
	return fs.temp, nil
}
func (fs *fakeReplacementFS) OpenFile(name string, _ int, _ os.FileMode) (syncFile, error) {
	file := &fakeSyncFile{name: name}
	fs.files[name] = file
	return file, nil
}
func (fs *fakeReplacementFS) Open(name string) (syncFile, error) {
	fs.directory = &fakeSyncFile{name: name, syncErr: fs.directorySyncErr}
	return fs.directory, nil
}
func (fs *fakeReplacementFS) Rename(oldPath, newPath string) error {
	fs.renamedFrom, fs.renamedTo = oldPath, newPath
	return nil
}
func (fs *fakeReplacementFS) Remove(string) error { return nil }

type fakeLauncher struct {
	name string
	args []string
}

func (launcher *fakeLauncher) Start(name string, args ...string) error {
	launcher.name, launcher.args = name, append([]string(nil), args...)
	return nil
}

func containsArg(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

var _ io.Writer = (*fakeSyncFile)(nil)
