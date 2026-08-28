package ojp

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

const canonicalVector = `{"v":1,"s":"Red Demo","p":"clave segura","u":"http://192.168.1.20:8090","t":"ojterm_demo_1234567890"}`

var encoded = base64.RawURLEncoding.EncodeToString([]byte(canonicalVector))

func TestParseAcceptsSupportedForms(t *testing.T) {
	forms := []string{
		"http://192.168.4.1/#ojp=" + encoded,
		"#ojp=" + encoded,
		"ojp=" + encoded,
		encoded,
	}

	for _, value := range forms {
		got, err := Parse([]byte(value))
		if err != nil {
			t.Fatalf("Parse() error = %v", err)
		}
		if got.Version != 1 || got.SSID != "Red Demo" || got.WiFiPassword != "clave segura" ||
			got.BaseURL != "http://192.168.1.20:8090" || got.TerminalToken != "ojterm_demo_1234567890" {
			t.Fatalf("Parse() = %#v", got)
		}
		if string(got.Encoded) != encoded {
			t.Fatalf("Encoded = %q", got.Encoded)
		}
	}
}

func TestParseRejectsNonCanonicalContracts(t *testing.T) {
	tests := []struct {
		name string
		json string
	}{
		{"duplicate", `{"v":1,"s":"Red","s":"Otra","p":"","u":"https://example.com","t":"ojterm_test"}`},
		{"unknown", `{"v":1,"s":"Red","p":"","u":"https://example.com","t":"ojterm_test","x":1}`},
		{"reordered", `{"s":"Red","v":1,"p":"","u":"https://example.com","t":"ojterm_test"}`},
		{"whitespace", `{"v":1, "s":"Red","p":"","u":"https://example.com","t":"ojterm_test"}`},
		{"escaped canonical character", `{"v":1,"s":"Red\u0020Demo","p":"","u":"https://example.com","t":"ojterm_test"}`},
		{"wrong version", `{"v":2,"s":"Red","p":"","u":"https://example.com","t":"ojterm_test"}`},
		{"wrong type", `{"v":1,"s":7,"p":"","u":"https://example.com","t":"ojterm_test"}`},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse(encodedJSON(test.json))
			if !errors.Is(err, ErrContract) {
				t.Fatalf("Parse() error = %v, want ErrContract", err)
			}
		})
	}
}

func TestParseRejectsInvalidEncodingAndUTF8(t *testing.T) {
	tests := []struct {
		name  string
		input []byte
		want  error
	}{
		{"padding", []byte(encoded + "="), ErrEncoding},
		{"non-zero trailing bits", []byte("AB"), ErrEncoding},
		{"line break", []byte(encoded[:4] + "\n" + encoded[4:]), ErrEncoding},
		{"invalid UTF-8", []byte(base64.RawURLEncoding.EncodeToString([]byte{0xff})), ErrUTF8},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse(test.input)
			if !errors.Is(err, test.want) {
				t.Fatalf("Parse() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestParseEnforcesByteLimits(t *testing.T) {
	validMaxURL := "https://example.com/" + strings.Repeat("x", 235)
	tests := []struct {
		name string
		json string
	}{
		{"empty SSID", canonical("", "", "https://example.com", "ojterm_x")},
		{"SSID 33 bytes", canonical(strings.Repeat("s", 33), "", "https://example.com", "ojterm_x")},
		{"password 64 bytes", canonical("s", strings.Repeat("p", 64), "https://example.com", "ojterm_x")},
		{"URL 256 bytes", canonical("s", "", validMaxURL+"x", "ojterm_x")},
		{"token 97 bytes", canonical("s", "", "https://example.com", "ojterm_"+strings.Repeat("t", 90))},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse(encodedJSON(test.json))
			if !errors.Is(err, ErrConfig) {
				t.Fatalf("Parse() error = %v, want ErrConfig", err)
			}
		})
	}

	valid := []string{
		canonical(strings.Repeat("s", 32), "", "https://example.com", "ojterm_x"),
		canonical("s", strings.Repeat("p", 63), "https://example.com", "ojterm_x"),
		canonical("s", "", validMaxURL, "ojterm_x"),
		canonical("s", "", "https://example.com", "ojterm_"+strings.Repeat("t", 89)),
		canonical(strings.Repeat("ñ", 16), "", "https://example.com", "ojterm_x"),
	}
	for _, json := range valid {
		if _, err := Parse(encodedJSON(json)); err != nil {
			t.Fatalf("Parse() boundary error = %v", err)
		}
	}
}

func TestParseRejectsUnsafeConfiguration(t *testing.T) {
	tests := []string{
		canonical("Red\nDemo", "", "https://example.com", "ojterm_x"),
		canonical("Red", "clave\x00secreta", "https://example.com", "ojterm_x"),
		canonical("Red", "", "ftp://example.com", "ojterm_x"),
		canonical("Red", "", "https://user:pass@example.com", "ojterm_x"),
		canonical("Red", "", "https://example.com?x=1", "ojterm_x"),
		canonical("Red", "", "https://example.com/a/../b", "ojterm_x"),
		canonical("Red", "", "https://localhost", "ojterm_x"),
		canonical("Red", "", "https://example.com", "bad_token"),
		canonical("Red", "", "https://example.com", "ojterm_ñ"),
	}

	for _, json := range tests {
		if _, err := Parse(encodedJSON(json)); !errors.Is(err, ErrConfig) {
			t.Fatalf("Parse(%q) error = %v, want ErrConfig", json, err)
		}
	}
}

func TestParseEnforcesBuildIndependentHTTPPolicy(t *testing.T) {
	allowed := []string{
		"http://10.0.0.1",
		"http://172.16.0.1:8090",
		"http://172.31.255.254/api",
		"http://192.168.1.20:8090",
		"https://example.com",
		"https://8.8.8.8",
	}
	for _, baseURL := range allowed {
		if _, err := Parse(encodedJSON(canonical("Red", "", baseURL, "ojterm_x"))); err != nil {
			t.Fatalf("Parse(%q) error = %v", baseURL, err)
		}
	}

	rejected := []string{
		"http://example.com",
		"http://8.8.8.8",
		"http://169.254.1.1",
		"http://172.15.255.255",
		"http://172.32.0.1",
	}
	for _, baseURL := range rejected {
		if _, err := Parse(encodedJSON(canonical("Red", "", baseURL, "ojterm_x"))); !errors.Is(err, ErrConfig) {
			t.Fatalf("Parse(%q) error = %v, want ErrConfig", baseURL, err)
		}
	}
}

func TestParseEnforcesWholeInputLimit(t *testing.T) {
	_, err := Parse([]byte(strings.Repeat("a", 601)))
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Parse() error = %v, want ErrTooLarge", err)
	}

	input := []byte(strings.Repeat("a", 600))
	_, err = Parse(input)
	if errors.Is(err, ErrTooLarge) {
		t.Fatal("600-byte input reported as too large")
	}
}

func TestParseNeverReflectsSecretOnFailure(t *testing.T) {
	const secretMarker = "VERY_SECRET_VALUE"
	_, err := Parse([]byte("ojp=" + secretMarker))
	if err == nil {
		t.Fatal("Parse() error = nil")
	}
	if strings.Contains(err.Error(), secretMarker) {
		t.Fatal("secret reflected")
	}
}

func encodedJSON(value string) []byte {
	return []byte(base64.RawURLEncoding.EncodeToString([]byte(value)))
}

func canonical(ssid, password, baseURL, token string) string {
	// Test values do not contain JSON metacharacters except controls, which the
	// standard encoder used by production must escape canonically.
	value := struct {
		Version  int    `json:"v"`
		SSID     string `json:"s"`
		Password string `json:"p"`
		BaseURL  string `json:"u"`
		Token    string `json:"t"`
	}{1, ssid, password, baseURL, token}
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}
