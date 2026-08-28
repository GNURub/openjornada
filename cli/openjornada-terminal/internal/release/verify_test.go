package release

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestEmbeddedProductionKeyMatchesFirmwareRepository(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller() failed")
	}
	want, err := os.ReadFile(filepath.Join(filepath.Dir(filename), "..", "..", "..", "..", "firmware", "terminal", "keys", "production-ed25519-public.pem"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if !bytes.Equal(productionPublicKeyPEM, want) {
		t.Fatal("embedded production public key differs from firmware key")
	}
}

func TestVerifyBundleAcceptsExactOfficialContractAndTransfersCleanup(t *testing.T) {
	bundle, current, publicKey := signedTestBundle(t, nil)
	path := bundle.Path

	verified, err := verifyBundle(bundle, current, publicKey)
	if err != nil {
		t.Fatalf("verifyBundle() error = %v", err)
	}
	if !verified.Official || verified.Path != path || verified.Version != "1.2.3" || verified.Size != uint32(len("official firmware")) {
		t.Fatalf("verified = %+v", verified)
	}
	if len(verified.Signature) != 88 || !bytes.Equal(verified.Manifest, bundle.Manifest) {
		t.Fatal("verified evidence differs from bundle")
	}
	if err := bundle.Close(); err != nil {
		t.Fatalf("Bundle.Close() after transfer error = %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("bundle closed transferred file: %v", err)
	}
	if err := verified.Close(); err != nil {
		t.Fatalf("VerifiedFirmware.Close() error = %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary firmware still exists: %v", err)
	}
}

func TestVerifyBundleRejectsEveryGateWithoutLeakingEvidence(t *testing.T) {
	tests := []struct {
		name string
		edit func(*testManifest, *Bundle)
		want error
	}{
		{name: "schema", edit: func(m *testManifest, _ *Bundle) { m.SchemaVersion = 2 }, want: ErrManifest},
		{name: "channel", edit: func(m *testManifest, _ *Bundle) { m.Channel = "beta" }, want: ErrManifest},
		{name: "semver", edit: func(m *testManifest, _ *Bundle) { m.FirmwareVersion = "01.2.3" }, want: ErrVersion},
		{name: "board", edit: func(m *testManifest, _ *Bundle) { m.Board = "other-board" }, want: ErrCompatibility},
		{name: "protocol", edit: func(m *testManifest, _ *Bundle) { m.ProtocolVersion = 2 }, want: ErrCompatibility},
		{name: "key id", edit: func(m *testManifest, _ *Bundle) { m.KeyID = "unknown" }, want: ErrSignature},
		{name: "asset", edit: func(m *testManifest, _ *Bundle) { m.AssetName = "other.bin" }, want: ErrManifest},
		{name: "size", edit: func(m *testManifest, _ *Bundle) { m.Size++ }, want: ErrSize},
		{name: "hash", edit: func(m *testManifest, _ *Bundle) { m.SHA256 = string(bytes.Repeat([]byte{'0'}, 64)) }, want: ErrHash},
		{name: "release tag", edit: func(m *testManifest, _ *Bundle) { m.ReleaseTag = "v9.9.9" }, want: ErrManifest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bundle, current, publicKey := signedTestBundle(t, test.edit)
			defer bundle.Close()
			_, err := verifyBundle(bundle, current, publicKey)
			if !errors.Is(err, test.want) {
				t.Fatalf("verifyBundle() error = %v, want %v", err, test.want)
			}
			for _, evidence := range []string{string(bundle.Manifest), string(bundle.Signature), bundle.Path, base64.StdEncoding.EncodeToString(bundle.SHA256[:])} {
				if evidence != "" && bytes.Contains([]byte(err.Error()), []byte(evidence)) {
					t.Fatal("error leaked rejected evidence")
				}
			}
		})
	}
}

func TestVerifyBundleRejectsInvalidSignatureAndNonCanonicalManifest(t *testing.T) {
	bundle, current, publicKey := signedTestBundle(t, nil)
	bundle.Signature[0] ^= 1
	if _, err := verifyBundle(bundle, current, publicKey); !errors.Is(err, ErrSignature) {
		t.Fatalf("invalid signature error = %v", err)
	}
	if err := bundle.Close(); err != nil {
		t.Fatal(err)
	}

	bundle, current, publicKey = signedTestBundle(t, nil)
	defer bundle.Close()
	bundle.Manifest = append([]byte(" "), bundle.Manifest...)
	_, testPrivateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKey = testPrivateKey.Public().(ed25519.PublicKey)
	bundle.Signature = encodedSignature(testPrivateKey, bundle.Manifest)
	if _, err := verifyBundle(bundle, current, publicKey); !errors.Is(err, ErrManifest) {
		t.Fatalf("non-canonical manifest error = %v", err)
	}
}

func TestVerifyBundleRejectsBundleWithoutCleanupOwnership(t *testing.T) {
	bundle, current, publicKey := signedTestBundle(t, nil)
	owner := bundle.owner
	bundle.owner = nil
	defer owner.close(ownerBundle)

	if _, err := verifyBundle(bundle, current, publicKey); !errors.Is(err, ErrOwnership) {
		t.Fatalf("verifyBundle() ownership error = %v", err)
	}
}

type testManifest struct {
	SchemaVersion   int    `json:"schemaVersion"`
	Channel         string `json:"channel"`
	Board           string `json:"board"`
	FirmwareVersion string `json:"firmwareVersion"`
	ReleaseTag      string `json:"releaseTag"`
	ProtocolVersion int    `json:"protocolVersion"`
	AssetName       string `json:"assetName"`
	Size            uint32 `json:"size"`
	SHA256          string `json:"sha256"`
	KeyID           string `json:"keyId"`
	PublishedAt     string `json:"publishedAt"`
}

func signedTestBundle(t *testing.T, edit func(*testManifest, *Bundle)) (Bundle, DeviceInfo, ed25519.PublicKey) {
	t.Helper()
	contents := []byte("official firmware")
	path := filepath.Join(t.TempDir(), "firmware.bin")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(contents)
	bundle := Bundle{ReleaseTag: "v1.2.3", Path: path, Size: int64(len(contents)), SHA256: digest, owner: newTemporaryOwner(path)}
	manifest := testManifest{1, "stable", productionBoard, "1.2.3", bundle.ReleaseTag, 1, firmwareAssetName, uint32(len(contents)), encodeHex(digest), productionKeyID, time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC).Format(time.RFC3339)}
	if edit != nil {
		edit(&manifest, &bundle)
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	bundle.Manifest = append(encoded, '\n')
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	bundle.Signature = encodedSignature(privateKey, bundle.Manifest)
	return bundle, DeviceInfo{Board: productionBoard, ProtocolVersion: 1, FirmwareVersion: "1.0.0"}, publicKey
}

func encodedSignature(privateKey ed25519.PrivateKey, manifest []byte) []byte {
	return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifest)) + "\n")
}
