package update

import (
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
)

const validCustomMetadata = `OJFW_META_V1:{"board":"m5stack-basic-core-v27","protocolVersion":1,"firmwareVersion":"2.3.4"}`

func writeCustomImage(t *testing.T, contents []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "custom.bin")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestInspectCustomScansPrefixAndHashesCompleteFile(t *testing.T) {
	contents := make([]byte, metadataScanBytes+4096)
	copy(contents[73:], validCustomMetadata)
	for index := metadataScanBytes; index < len(contents); index++ {
		contents[index] = byte(index)
	}
	path := writeCustomImage(t, contents)

	firmware, err := InspectCustom(path)
	if err != nil {
		t.Fatalf("InspectCustom() error = %v", err)
	}
	if firmware.Path != path || firmware.Size != uint32(len(contents)) || firmware.Version != "2.3.4" || firmware.Official {
		t.Fatalf("firmware = %+v", firmware)
	}
	if want := sha256.Sum256(contents); firmware.SHA256 != want {
		t.Fatal("SHA256 did not cover the complete file")
	}
	if err := firmware.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("custom source ownership was taken: %v", err)
	}
}

func TestInspectCustomRequiresExactlyOneCanonicalCompatibleMarkerInPrefix(t *testing.T) {
	tests := map[string][]byte{
		"missing":          []byte("firmware"),
		"duplicate":        []byte(validCustomMetadata + validCustomMetadata),
		"outside-prefix":   append(make([]byte, metadataScanBytes), []byte(validCustomMetadata)...),
		"non-canonical":    []byte(`OJFW_META_V1:{"protocolVersion":1,"board":"m5stack-basic-core-v27","firmwareVersion":"2.3.4"}`),
		"wrong-board":      []byte(`OJFW_META_V1:{"board":"other-board","protocolVersion":1,"firmwareVersion":"2.3.4"}`),
		"wrong-protocol":   []byte(`OJFW_META_V1:{"board":"m5stack-basic-core-v27","protocolVersion":2,"firmwareVersion":"2.3.4"}`),
		"invalid-version":  []byte(`OJFW_META_V1:{"board":"m5stack-basic-core-v27","protocolVersion":1,"firmwareVersion":"02.3.4"}`),
		"version-overflow": []byte(`OJFW_META_V1:{"board":"m5stack-basic-core-v27","protocolVersion":1,"firmwareVersion":"4294967296.3.4"}`),
		"oversized-json":   append([]byte(metadataMarker), append([]byte(`{"board":"m5stack-basic-core-v27","protocolVersion":1,"firmwareVersion":"`), append(make([]byte, metadataJSONMaxBytes), []byte(`"}`)...)...)...),
	}
	for name, contents := range tests {
		t.Run(name, func(t *testing.T) {
			path := writeCustomImage(t, contents)
			if _, err := InspectCustom(path); err == nil {
				t.Fatal("InspectCustom() accepted invalid image")
			}
		})
	}
}

func TestInspectCustomErrorDoesNotExposeFilename(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret-firmware-name.bin")
	_, err := InspectCustom(path)
	if err == nil || err.Error() == path {
		t.Fatalf("error = %v", err)
	}
}
