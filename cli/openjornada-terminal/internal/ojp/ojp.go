// Package ojp parses the bounded provisioning payload shared by the web UI,
// terminal firmware and USB CLI.
package ojp

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

const (
	maxInputBytes        = 600
	maxSSIDBytes         = 32
	maxWiFiPasswordBytes = 63
	maxBaseURLBytes      = 255
	maxTerminalToken     = 96

	fullURLPrefix  = "http://192.168.4.1/#ojp="
	fragmentPrefix = "#ojp="
	valuePrefix    = "ojp="
	tokenPrefix    = "ojterm_"
)

// Sentinel errors deliberately contain no rejected input.
var (
	ErrMissing  = errors.New("ojp: missing payload")
	ErrTooLarge = errors.New("ojp: input too large")
	ErrEncoding = errors.New("ojp: invalid encoding")
	ErrUTF8     = errors.New("ojp: invalid UTF-8")
	ErrContract = errors.New("ojp: invalid contract")
	ErrConfig   = errors.New("ojp: invalid configuration")
)

// Payload is a validated OJP v1 payload. Encoded contains only the normalized
// unpadded Base64URL value, with any supported wrapper removed.
type Payload struct {
	Version       int
	SSID          string
	WiFiPassword  string
	BaseURL       string
	TerminalToken string
	Encoded       []byte
}

type wirePayload struct {
	Version       int    `json:"v"`
	SSID          string `json:"s"`
	WiFiPassword  string `json:"p"`
	BaseURL       string `json:"u"`
	TerminalToken string `json:"t"`
}

// Parse accepts the four OJP forms documented by OpenJornada and returns a
// normalized payload. It never includes input bytes in returned errors.
func Parse(input []byte) (Payload, error) {
	if len(input) == 0 {
		return Payload{}, ErrMissing
	}
	if len(input) > maxInputBytes {
		return Payload{}, ErrTooLarge
	}

	encoded := unwrap(input)
	if len(encoded) == 0 {
		return Payload{}, ErrMissing
	}

	decoded := make([]byte, base64.RawURLEncoding.DecodedLen(len(encoded)))
	n, err := base64.RawURLEncoding.Strict().Decode(decoded, encoded)
	if err != nil {
		return Payload{}, ErrEncoding
	}
	decoded = decoded[:n]
	if !bytes.Equal([]byte(base64.RawURLEncoding.EncodeToString(decoded)), encoded) {
		return Payload{}, ErrEncoding
	}
	if !utf8.Valid(decoded) {
		return Payload{}, ErrUTF8
	}

	var wire wirePayload
	if err := json.Unmarshal(decoded, &wire); err != nil {
		return Payload{}, ErrContract
	}
	if wire.Version != 1 || !bytes.Equal(decoded, canonicalJSON(wire)) {
		return Payload{}, ErrContract
	}
	if !validConfiguration(wire) {
		return Payload{}, ErrConfig
	}

	return Payload{
		Version:       wire.Version,
		SSID:          wire.SSID,
		WiFiPassword:  wire.WiFiPassword,
		BaseURL:       wire.BaseURL,
		TerminalToken: wire.TerminalToken,
		Encoded:       bytes.Clone(encoded),
	}, nil
}

func unwrap(input []byte) []byte {
	for _, prefix := range []string{fullURLPrefix, fragmentPrefix, valuePrefix} {
		if bytes.HasPrefix(input, []byte(prefix)) {
			return input[len(prefix):]
		}
	}
	return input
}

func canonicalJSON(value wirePayload) []byte {
	output := make([]byte, 0, 32+len(value.SSID)+len(value.WiFiPassword)+len(value.BaseURL)+len(value.TerminalToken))
	output = append(output, `{"v":1,"s":`...)
	output = appendJSONString(output, value.SSID)
	output = append(output, `,"p":`...)
	output = appendJSONString(output, value.WiFiPassword)
	output = append(output, `,"u":`...)
	output = appendJSONString(output, value.BaseURL)
	output = append(output, `,"t":`...)
	output = appendJSONString(output, value.TerminalToken)
	return append(output, '}')
}

func appendJSONString(output []byte, value string) []byte {
	const hex = "0123456789abcdef"
	output = append(output, '"')
	for index := 0; index < len(value); index++ {
		character := value[index]
		switch character {
		case '"', '\\':
			output = append(output, '\\', character)
		case '\b':
			output = append(output, `\b`...)
		case '\f':
			output = append(output, `\f`...)
		case '\n':
			output = append(output, `\n`...)
		case '\r':
			output = append(output, `\r`...)
		case '\t':
			output = append(output, `\t`...)
		default:
			if character < 0x20 {
				output = append(output, '\\', 'u', '0', '0', hex[character>>4], hex[character&0x0f])
			} else {
				output = append(output, character)
			}
		}
	}
	return append(output, '"')
}

func validConfiguration(value wirePayload) bool {
	if len(value.SSID) == 0 || len(value.SSID) > maxSSIDBytes ||
		len(value.WiFiPassword) > maxWiFiPasswordBytes ||
		len(value.BaseURL) == 0 || len(value.BaseURL) > maxBaseURLBytes ||
		len(value.TerminalToken) <= len(tokenPrefix) || len(value.TerminalToken) > maxTerminalToken {
		return false
	}
	if forbiddenText(value.SSID) || forbiddenText(value.WiFiPassword) || forbiddenText(value.TerminalToken) {
		return false
	}
	if !strings.HasPrefix(value.TerminalToken, tokenPrefix) || !visibleASCII(value.TerminalToken) {
		return false
	}
	return validBaseURL(value.BaseURL)
}

func forbiddenText(value string) bool {
	return strings.ContainsAny(value, "\x00\r\n")
}

func visibleASCII(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] <= 0x20 || value[index] >= 0x7f {
			return false
		}
	}
	return true
}

// validBaseURL mirrors the firmware's build-independent syntax rules. Whether
// a syntactically valid HTTP endpoint is permitted for a particular build is
// intentionally left to the firmware, which knows its own build profile.
func validBaseURL(value string) bool {
	if !visibleASCII(value) || strings.ContainsAny(value, "\\?#") {
		return false
	}

	authorityStart := 0
	secure := false
	switch {
	case strings.HasPrefix(value, "https://"):
		authorityStart = len("https://")
		secure = true
	case strings.HasPrefix(value, "http://"):
		authorityStart = len("http://")
	default:
		return false
	}

	remainder := value[authorityStart:]
	pathOffset := strings.IndexByte(remainder, '/')
	authority := remainder
	path := ""
	if pathOffset >= 0 {
		authority = remainder[:pathOffset]
		path = remainder[pathOffset:]
	}
	if authority == "" || strings.Contains(authority, "@") || strings.HasPrefix(authority, "[") {
		return false
	}

	host := authority
	if colon := strings.IndexByte(authority, ':'); colon >= 0 {
		if strings.Contains(authority[colon+1:], ":") {
			return false
		}
		host = authority[:colon]
		if !validPort(authority[colon+1:]) {
			return false
		}
	}
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return false
	}

	octets, ipv4 := parseIPv4(host)
	if ipv4 {
		if octets[0] == 0 || octets[0] == 127 {
			return false
		}
	} else if numericLikeHost(host) || !validDNSName(host) {
		return false
	}
	if !secure && (!ipv4 || !privateIPv4(octets)) {
		return false
	}

	return validPath(path)
}

func privateIPv4(address [4]byte) bool {
	return address[0] == 10 ||
		(address[0] == 172 && address[1] >= 16 && address[1] <= 31) ||
		(address[0] == 192 && address[1] == 168)
}

func validPort(value string) bool {
	if len(value) == 0 || len(value) > 5 {
		return false
	}
	port := 0
	for index := 0; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
		port = port*10 + int(value[index]-'0')
	}
	return port >= 1 && port <= 65535
}

func parseIPv4(host string) ([4]byte, bool) {
	var result [4]byte
	parts := strings.Split(host, ".")
	if len(parts) != len(result) {
		return result, false
	}
	for index, part := range parts {
		if len(part) == 0 || len(part) > 3 || (len(part) > 1 && part[0] == '0') {
			return result, false
		}
		value := 0
		for character := 0; character < len(part); character++ {
			if part[character] < '0' || part[character] > '9' {
				return result, false
			}
			value = value*10 + int(part[character]-'0')
			if value > 255 {
				return result, false
			}
		}
		result[index] = byte(value)
	}
	return result, true
}

func numericLikeHost(host string) bool {
	if host == "" {
		return false
	}
	for index := 0; index < len(host); index++ {
		if (host[index] < '0' || host[index] > '9') && host[index] != '.' {
			return false
		}
	}
	return true
}

func validDNSName(host string) bool {
	if len(host) == 0 || len(host) > 253 || host[len(host)-1] == '.' {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for index := 0; index < len(label); index++ {
			character := label[index]
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return false
			}
		}
	}
	return true
}

func validPath(path string) bool {
	if path == "" {
		return true
	}
	if path[0] != '/' {
		return false
	}
	for _, segment := range strings.Split(path[1:], "/") {
		decodedDots := 0
		onlyDots := true
		for index := 0; index < len(segment); index++ {
			decoded := segment[index]
			if decoded == '%' {
				if index+2 >= len(segment) {
					return false
				}
				high, highOK := hexValue(segment[index+1])
				low, lowOK := hexValue(segment[index+2])
				if !highOK || !lowOK {
					return false
				}
				decoded = high<<4 | low
				index += 2
				if decoded == '%' || decoded == '/' || decoded == '\\' || decoded <= 0x20 || decoded == 0x7f {
					return false
				}
			}
			if decoded != '.' {
				onlyDots = false
			} else if decodedDots < 2 {
				decodedDots++
			} else {
				onlyDots = false
			}
		}
		if onlyDots && (decodedDots == 1 || decodedDots == 2) {
			return false
		}
	}
	return true
}

func hexValue(value byte) (byte, bool) {
	switch {
	case value >= '0' && value <= '9':
		return value - '0', true
	case value >= 'a' && value <= 'f':
		return value - 'a' + 10, true
	case value >= 'A' && value <= 'F':
		return value - 'A' + 10, true
	default:
		return 0, false
	}
}
