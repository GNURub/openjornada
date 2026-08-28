// Package update inspects and transfers OpenJornada firmware images.
package update

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/GNURub/openjornada/cli/openjornada-terminal/internal/release"
)

const (
	metadataMarker       = "OJFW_META_V1:"
	metadataScanBytes    = 256 * 1024
	metadataJSONMaxBytes = 192
	customImageMaxBytes  = 0x1f0000
	firmwareBoard        = "m5stack-basic-core-v27"
	firmwareProtocol     = 1
)

var (
	ErrCustomImage    = errors.New("update: invalid custom firmware")
	semanticVersionRE = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
)

type customMetadata struct {
	Board           string `json:"board"`
	ProtocolVersion int    `json:"protocolVersion"`
	FirmwareVersion string `json:"firmwareVersion"`
}

// InspectCustom validates public embedded metadata and streams the complete
// source through SHA-256. It never takes ownership of the operator's file.
func InspectCustom(path string) (release.VerifiedFirmware, error) {
	file, err := os.Open(path)
	if err != nil {
		return release.VerifiedFirmware{}, ErrCustomImage
	}
	defer file.Close()

	before, err := file.Stat()
	if err != nil || !before.Mode().IsRegular() || before.Size() <= 0 || before.Size() > customImageMaxBytes {
		return release.VerifiedFirmware{}, ErrCustomImage
	}
	scanLength := before.Size()
	if scanLength > metadataScanBytes {
		scanLength = metadataScanBytes
	}
	prefix := make([]byte, int(scanLength))
	if _, err := io.ReadFull(file, prefix); err != nil {
		return release.VerifiedFirmware{}, ErrCustomImage
	}
	metadata, err := inspectMetadata(prefix)
	if err != nil {
		return release.VerifiedFirmware{}, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return release.VerifiedFirmware{}, ErrCustomImage
	}
	hasher := sha256.New()
	read, err := io.Copy(hasher, file)
	if err != nil || read != before.Size() {
		return release.VerifiedFirmware{}, ErrCustomImage
	}
	after, err := file.Stat()
	if err != nil || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return release.VerifiedFirmware{}, ErrCustomImage
	}
	var digest [sha256.Size]byte
	copy(digest[:], hasher.Sum(nil))
	return release.VerifiedFirmware{
		Path: path, Size: uint32(before.Size()), SHA256: digest,
		Version: metadata.FirmwareVersion, Official: false,
	}, nil
}

func inspectMetadata(prefix []byte) (customMetadata, error) {
	marker := []byte(metadataMarker)
	if bytes.Count(prefix, marker) != 1 {
		return customMetadata{}, ErrCustomImage
	}
	start := bytes.Index(prefix, marker) + len(marker)
	length := metadataObjectLength(prefix[start:])
	if length == 0 || length > metadataJSONMaxBytes {
		return customMetadata{}, ErrCustomImage
	}
	raw := prefix[start : start+length]
	var metadata customMetadata
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&metadata); err != nil {
		return customMetadata{}, ErrCustomImage
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return customMetadata{}, ErrCustomImage
	}
	canonical, err := json.Marshal(metadata)
	if err != nil || !bytes.Equal(raw, canonical) || metadata.Board != firmwareBoard ||
		metadata.ProtocolVersion != firmwareProtocol || !validSemanticVersion(metadata.FirmwareVersion) {
		return customMetadata{}, ErrCustomImage
	}
	return metadata, nil
}

func validSemanticVersion(value string) bool {
	if len(value) == 0 || len(value) > 32 || !semanticVersionRE.MatchString(value) {
		return false
	}
	for _, component := range strings.Split(value, ".") {
		if _, err := strconv.ParseUint(component, 10, 32); err != nil {
			return false
		}
	}
	return true
}

func metadataObjectLength(input []byte) int {
	limit := len(input)
	if limit > metadataJSONMaxBytes {
		limit = metadataJSONMaxBytes
	}
	inString, escaped := false, false
	for index := 0; index < limit; index++ {
		switch value := input[index]; {
		case inString && escaped:
			escaped = false
		case inString && value == '\\':
			escaped = true
		case value == '"':
			inString = !inString
		case !inString && value == '}':
			return index + 1
		}
	}
	return 0
}
