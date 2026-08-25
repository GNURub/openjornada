package billing

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestNormalizeStripeObjectSupportsCurrentInvoiceParent(t *testing.T) {
	t.Parallel()
	var object stripeObject
	if err := json.Unmarshal([]byte(`{
      "id":"in_test",
      "customer":"cus_test",
      "parent":{"subscription_details":{"subscription":"sub_test","metadata":{"organizationId":"org_test"}}},
      "items":{"data":[{"current_period_end":1789000000}]}
    }`), &object); err != nil {
		t.Fatal(err)
	}
	normalizeStripeObject(&object)
	if object.Subscription != "sub_test" || object.Metadata["organizationId"] != "org_test" || object.CurrentPeriodEnd != 1789000000 {
		t.Fatalf("normalizeStripeObject() = %#v", object)
	}
}

func TestVerifyWebhookSignature(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 25, 10, 0, 0, 0, time.UTC)
	payload := []byte(`{"id":"evt_test"}`)
	secret := "whsec_test"
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "%d.", now.Unix())
	_, _ = mac.Write(payload)
	header := fmt.Sprintf("t=%d,v1=%s", now.Unix(), hex.EncodeToString(mac.Sum(nil)))
	if err := verifyWebhookSignature(payload, header, secret, now); err != nil {
		t.Fatalf("verifyWebhookSignature() error = %v", err)
	}
	if err := verifyWebhookSignature([]byte(`{"changed":true}`), header, secret, now); err == nil {
		t.Fatal("verifyWebhookSignature() accepted a changed payload")
	}
	if err := verifyWebhookSignature(payload, header, secret, now.Add(6*time.Minute)); err == nil {
		t.Fatal("verifyWebhookSignature() accepted an expired signature")
	}
}

func TestValidIdempotencyKey(t *testing.T) {
	t.Parallel()
	if !validIdempotencyKey("checkout-1234567890") {
		t.Fatal("expected key to be valid")
	}
	for _, value := range []string{"short", "checkout con espacios 123", strings.Repeat("a", 81)} {
		if validIdempotencyKey(value) {
			t.Fatalf("expected %q to be invalid", value)
		}
	}
}
