package mcpserver

import (
	"encoding/hex"
	"strings"
	"testing"
)

func TestTokenFormatAndHash(t *testing.T) {
	prefix, err := randomURLString(9)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := randomURLString(32)
	if err != nil {
		t.Fatal(err)
	}
	raw := "ojmcp_" + prefix + "_" + secret
	if len(prefix) != 12 {
		t.Fatalf("prefix length = %d, want 12", len(prefix))
	}
	if !strings.HasPrefix(raw, "ojmcp_") || len(secret) < 40 {
		t.Fatalf("unexpected token format: %q", raw)
	}
	hash := hashToken(raw)
	if len(hash) != 64 {
		t.Fatalf("hash length = %d, want 64", len(hash))
	}
	if _, err := hex.DecodeString(hash); err != nil {
		t.Fatalf("hash is not hexadecimal: %v", err)
	}
	if strings.Contains(hash, raw) {
		t.Fatal("hash contains the plaintext token")
	}
}

func TestParseTokenPrefixAllowsBase64URLUnderscores(t *testing.T) {
	raw := "ojmcp_abc_defghijk_secret_with_underscores_and_at_least_forty_characters"
	prefix, err := parseTokenPrefix(raw)
	if err != nil {
		t.Fatal(err)
	}
	if prefix != "abc_defghijk" {
		t.Fatalf("prefix = %q", prefix)
	}
}

func TestSignValueIsBoundToKeyAndPayload(t *testing.T) {
	first := signValue("key-a", "payload-a")
	if first != signValue("key-a", "payload-a") {
		t.Fatal("signature is not deterministic")
	}
	if first == signValue("key-b", "payload-a") {
		t.Fatal("signature is not bound to the key")
	}
	if first == signValue("key-a", "payload-b") {
		t.Fatal("signature is not bound to the payload")
	}
}

func TestToolCatalogNamesAreUniqueAndExplicit(t *testing.T) {
	seen := map[string]bool{}
	for _, tool := range toolCatalog() {
		if tool.name == "" || tool.description == "" {
			t.Fatalf("incomplete tool: %#v", tool)
		}
		if seen[tool.name] {
			t.Fatalf("duplicate tool name %q", tool.name)
		}
		if strings.Contains(tool.name, "crud") || strings.Contains(tool.name, "ejecutar") {
			t.Fatalf("generic tool name %q", tool.name)
		}
		seen[tool.name] = true
	}
	if len(seen) < 30 {
		t.Fatalf("catalog contains %d tools, want at least 30", len(seen))
	}
}

func TestPocketBaseErrorDoesNotExposeResponseBody(t *testing.T) {
	err := pocketBaseError(500, []byte(`{"message":"","data":{"token":"secret"}}`))
	if strings.Contains(err.Error(), "secret") {
		t.Fatal("PocketBase error exposed response data")
	}
}
