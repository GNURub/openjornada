package terminal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
)

var uidPattern = regexp.MustCompile(`^[0-9A-F]{8,20}$`)

func randomURLString(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func hashValue(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func secureHashEqual(expectedHex, value string) bool {
	expected, err := hex.DecodeString(expectedHex)
	if err != nil {
		return false
	}
	sum := sha256.Sum256([]byte(value))
	return len(expected) == len(sum) && subtle.ConstantTimeCompare(expected, sum[:]) == 1
}

func normalizeUID(value string) (string, error) {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	normalized = strings.NewReplacer(":", "", "-", "", " ", "").Replace(normalized)
	if !uidPattern.MatchString(normalized) || len(normalized)%2 != 0 {
		return "", errors.New("el UID RFID no es válido")
	}
	return normalized, nil
}

func masterKey() ([]byte, error) {
	value := strings.TrimSpace(os.Getenv("PB_ENCRYPTION_KEY"))
	if value == "" {
		return nil, errors.New("falta PB_ENCRYPTION_KEY")
	}
	sum := sha256.Sum256([]byte("openjornada-terminal-v1|" + value))
	return sum[:], nil
}

func encryptValue(value string) (string, error) {
	key, err := masterKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(value), nil)
	return base64.RawURLEncoding.EncodeToString(append(nonce, ciphertext...)), nil
}

func decryptValue(value string) (string, error) {
	key, err := masterKey()
	if err != nil {
		return "", err
	}
	encoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(encoded) < gcm.NonceSize() {
		return "", errors.New("valor cifrado no válido")
	}
	plaintext, err := gcm.Open(nil, encoded[:gcm.NonceSize()], encoded[gcm.NonceSize():], nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func uidFingerprint(uid string) (string, error) {
	key, err := masterKey()
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("uid|" + uid))
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func signingKeyForToken(raw string) []byte {
	sum := sha256.Sum256([]byte("openjornada-terminal-signing-v1|" + raw))
	return sum[:]
}

func signPayload(key []byte, payload string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

func verifySignature(key []byte, payload, signature string) bool {
	expected, err := hex.DecodeString(signPayload(key, payload))
	if err != nil {
		return false
	}
	provided, err := hex.DecodeString(signature)
	return err == nil && len(expected) == len(provided) && subtle.ConstantTimeCompare(expected, provided) == 1
}

func createTerminalToken() (raw, prefix, encryptedSigningMaterial string, err error) {
	prefix, err = randomURLString(9)
	if err != nil {
		return "", "", "", err
	}
	secret, err := randomURLString(32)
	if err != nil {
		return "", "", "", err
	}
	raw = "ojterm_" + prefix + "_" + secret
	encryptedSigningMaterial, err = encryptValue(base64.RawURLEncoding.EncodeToString(signingKeyForToken(raw)))
	return raw, prefix, encryptedSigningMaterial, err
}

func parseTerminalPrefix(raw string) (string, error) {
	const marker = "ojterm_"
	const prefixLength = 12
	if !strings.HasPrefix(raw, marker) || len(raw) < len(marker)+prefixLength+1+40 {
		return "", errors.New("formato de token no válido")
	}
	separator := len(marker) + prefixLength
	if raw[separator] != '_' {
		return "", errors.New("formato de token no válido")
	}
	return raw[len(marker):separator], nil
}

func terminalSigningKey(encrypted string) ([]byte, error) {
	value, err := decryptValue(encrypted)
	if err != nil {
		return nil, err
	}
	key, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(key) != sha256.Size {
		return nil, fmt.Errorf("material de firma no válido")
	}
	return key, nil
}
