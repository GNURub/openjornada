package terminal

import (
	"os"
	"strings"
	"testing"
)

func TestNormalizeUID(t *testing.T) {
	got, err := normalizeUID("04:a1-b2 c3")
	if err != nil || got != "04A1B2C3" {
		t.Fatalf("normalizeUID = %q, %v", got, err)
	}
	for _, invalid := range []string{"", "123", "NOT-RFID", "0011223344556677889900"} {
		if _, err := normalizeUID(invalid); err == nil {
			t.Fatalf("normalizeUID(%q) accepted invalid UID", invalid)
		}
	}
}

func TestTerminalTokenAndSignature(t *testing.T) {
	t.Setenv("PB_ENCRYPTION_KEY", strings.Repeat("a", 32))
	raw, prefix, encrypted, err := createTerminalToken()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(raw, "ojterm_"+prefix+"_") || len(prefix) != 12 {
		t.Fatalf("unexpected token format %q", raw)
	}
	if parsed, err := parseTerminalPrefix(raw); err != nil || parsed != prefix {
		t.Fatalf("parseTerminalPrefix = %q, %v", parsed, err)
	}
	key, err := terminalSigningKey(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	signature := signPayload(key, "payload")
	if !verifySignature(key, "payload", signature) || verifySignature(key, "other", signature) {
		t.Fatal("signature verification is not bound to payload")
	}
	if secureHashEqual(hashValue(raw), raw+"x") || !secureHashEqual(hashValue(raw), raw) {
		t.Fatal("token hash comparison failed")
	}
}

func TestUIDEncryptionAndFingerprint(t *testing.T) {
	old, had := os.LookupEnv("PB_ENCRYPTION_KEY")
	t.Setenv("PB_ENCRYPTION_KEY", strings.Repeat("b", 32))
	t.Cleanup(func() {
		if had {
			_ = os.Setenv("PB_ENCRYPTION_KEY", old)
		}
	})
	ciphertext, err := encryptValue("04A1B2C3")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(ciphertext, "04A1B2C3") {
		t.Fatal("ciphertext exposes UID")
	}
	plaintext, err := decryptValue(ciphertext)
	if err != nil || plaintext != "04A1B2C3" {
		t.Fatalf("decryptValue = %q, %v", plaintext, err)
	}
	first, _ := uidFingerprint("04A1B2C3")
	second, _ := uidFingerprint("04A1B2C3")
	if first != second || len(first) != 64 {
		t.Fatal("UID fingerprint is not stable")
	}
}
