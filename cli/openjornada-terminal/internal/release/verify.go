// Package release discovers and verifies official OpenJornada firmware releases.
package release

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	productionBoard   = "m5stack-basic-core-v27"
	productionKeyID   = "production-2026-09"
	firmwareAssetName = "openjornada-m5stack.bin"
	manifestMaxBytes  = 2048
	signatureMaxBytes = 256
	otaSlotBytes      = 0x1f0000
)

var (
	ErrManifest      = errors.New("release: invalid manifest")
	ErrVersion       = errors.New("release: invalid semantic version")
	ErrCompatibility = errors.New("release: incompatible firmware")
	ErrSignature     = errors.New("release: invalid signature")
	ErrHash          = errors.New("release: firmware hash mismatch")
	ErrSize          = errors.New("release: firmware size mismatch")
	ErrOwnership     = errors.New("release: firmware ownership unavailable")
)

//go:embed production-ed25519-public.pem
var productionPublicKeyPEM []byte

var semanticVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type DeviceInfo struct {
	Board           string
	ProtocolVersion int
	FirmwareVersion string
}

// Bundle owns its temporary firmware file until verification succeeds. Call
// Close on every failure path. Successful verification transfers ownership to
// the returned VerifiedFirmware, and Bundle.Close becomes a no-op.
type Bundle struct {
	ReleaseTag string
	Manifest   []byte
	Signature  []byte
	Path       string
	Size       int64
	SHA256     [32]byte
	owner      *temporaryOwner
}

func (bundle *Bundle) Close() error {
	if bundle == nil || bundle.owner == nil {
		return nil
	}
	return bundle.owner.close(ownerBundle)
}

type VerifiedFirmware struct {
	Path      string
	Size      uint32
	SHA256    [32]byte
	Version   string
	Manifest  []byte
	Signature []byte
	Official  bool
	owner     *temporaryOwner
}

// Close removes the verified temporary firmware. It is idempotent.
func (firmware *VerifiedFirmware) Close() error {
	if firmware == nil || firmware.owner == nil {
		return nil
	}
	return firmware.owner.close(ownerVerified)
}

type manifest struct {
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

func VerifyBundle(bundle Bundle, current DeviceInfo) (VerifiedFirmware, error) {
	publicKey, err := parseEd25519PublicKey(productionPublicKeyPEM)
	if err != nil {
		return VerifiedFirmware{}, ErrSignature
	}
	return verifyBundle(bundle, current, publicKey)
}

func verifyBundle(bundle Bundle, current DeviceInfo, publicKey ed25519.PublicKey) (VerifiedFirmware, error) {
	signature, encodedSignature, err := decodeSignature(bundle.Signature)
	if err != nil || len(publicKey) != ed25519.PublicKeySize || !ed25519.Verify(publicKey, bundle.Manifest, signature) {
		return VerifiedFirmware{}, ErrSignature
	}

	parsed, err := decodeManifest(bundle.Manifest)
	if err != nil {
		return VerifiedFirmware{}, err
	}
	if parsed.SchemaVersion != 1 || parsed.Channel != "stable" || parsed.AssetName != firmwareAssetName || parsed.ReleaseTag != bundle.ReleaseTag {
		return VerifiedFirmware{}, ErrManifest
	}
	if !validReleaseTag(bundle.ReleaseTag) || !validSemanticVersion(parsed.FirmwareVersion) || !validSemanticVersion(current.FirmwareVersion) {
		return VerifiedFirmware{}, ErrVersion
	}
	if parsed.Board != productionBoard || parsed.Board != current.Board || parsed.ProtocolVersion != 1 || parsed.ProtocolVersion != current.ProtocolVersion {
		return VerifiedFirmware{}, ErrCompatibility
	}
	if parsed.KeyID != productionKeyID {
		return VerifiedFirmware{}, ErrSignature
	}
	if parsed.Size == 0 || parsed.Size > otaSlotBytes || int64(parsed.Size) != bundle.Size {
		return VerifiedFirmware{}, ErrSize
	}
	wantHash, err := decodeHash(parsed.SHA256)
	if err != nil {
		return VerifiedFirmware{}, ErrManifest
	}
	if wantHash != bundle.SHA256 {
		return VerifiedFirmware{}, ErrHash
	}
	if err := verifyFile(bundle.Path, bundle.Size, bundle.SHA256); err != nil {
		return VerifiedFirmware{}, err
	}
	if bundle.owner == nil || !bundle.owner.transfer() {
		return VerifiedFirmware{}, ErrOwnership
	}
	return VerifiedFirmware{
		Path: bundle.Path, Size: parsed.Size, SHA256: bundle.SHA256,
		Version: parsed.FirmwareVersion, Manifest: bytes.Clone(bundle.Manifest),
		Signature: encodedSignature, Official: true, owner: bundle.owner,
	}, nil
}

func decodeManifest(input []byte) (manifest, error) {
	if len(input) == 0 || len(input) > manifestMaxBytes || input[len(input)-1] != '\n' {
		return manifest{}, ErrManifest
	}
	var parsed manifest
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&parsed); err != nil {
		return manifest{}, ErrManifest
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return manifest{}, ErrManifest
	}
	canonical, err := json.Marshal(parsed)
	if err != nil || !bytes.Equal(input, append(canonical, '\n')) {
		return manifest{}, ErrManifest
	}
	parsedTime, err := time.Parse(time.RFC3339, parsed.PublishedAt)
	if err != nil || parsedTime.Location() != time.UTC || parsedTime.Format(time.RFC3339) != parsed.PublishedAt {
		return manifest{}, ErrManifest
	}
	return parsed, nil
}

func decodeSignature(input []byte) ([]byte, []byte, error) {
	if len(input) == 0 || len(input) > signatureMaxBytes || input[len(input)-1] != '\n' || bytes.Contains(input[:len(input)-1], []byte{'\n'}) || bytes.Contains(input, []byte{'\r'}) {
		return nil, nil, ErrSignature
	}
	encoded := input[:len(input)-1]
	raw, err := base64.StdEncoding.Strict().DecodeString(string(encoded))
	if err != nil || len(raw) != ed25519.SignatureSize || base64.StdEncoding.EncodeToString(raw) != string(encoded) {
		return nil, nil, ErrSignature
	}
	return raw, bytes.Clone(encoded), nil
}

func parseEd25519PublicKey(input []byte) (ed25519.PublicKey, error) {
	block, rest := pem.Decode(input)
	if block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(rest)) != 0 {
		return nil, ErrSignature
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, ErrSignature
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return nil, ErrSignature
	}
	return publicKey, nil
}

func verifyFile(path string, expectedSize int64, expectedHash [32]byte) error {
	file, err := os.Open(path)
	if err != nil {
		return ErrSize
	}
	defer file.Close()
	hasher := sha256.New()
	read, err := io.Copy(hasher, file)
	if err != nil || read != expectedSize {
		return ErrSize
	}
	var actual [32]byte
	copy(actual[:], hasher.Sum(nil))
	if actual != expectedHash {
		return ErrHash
	}
	return nil
}

func validSemanticVersion(value string) bool { return semanticVersionPattern.MatchString(value) }
func validReleaseTag(value string) bool {
	return strings.HasPrefix(value, "v") && validSemanticVersion(strings.TrimPrefix(value, "v"))
}

func decodeHash(value string) ([32]byte, error) {
	var output [32]byte
	if len(value) != hex.EncodedLen(len(output)) || strings.ToLower(value) != value {
		return output, ErrManifest
	}
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return output, ErrManifest
	}
	copy(output[:], decoded)
	return output, nil
}

func encodeHex(value [32]byte) string { return hex.EncodeToString(value[:]) }

type ownershipState uint8

const (
	ownerBundle ownershipState = iota + 1
	ownerVerified
	ownerClosed
)

type temporaryOwner struct {
	mu    sync.Mutex
	path  string
	state ownershipState
}

func newTemporaryOwner(path string) *temporaryOwner {
	return &temporaryOwner{path: path, state: ownerBundle}
}

func (owner *temporaryOwner) transfer() bool {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.state != ownerBundle {
		return false
	}
	owner.state = ownerVerified
	return true
}

func (owner *temporaryOwner) close(expected ownershipState) error {
	owner.mu.Lock()
	defer owner.mu.Unlock()
	if owner.state == ownerClosed || owner.state != expected {
		return nil
	}
	if err := os.Remove(owner.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return ErrTemporary
	}
	owner.state = ownerClosed
	return nil
}
