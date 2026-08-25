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

	"github.com/pocketbase/pocketbase/core"
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

func TestManualAccessOverrideSurvivesActiveBillingStatus(t *testing.T) {
	t.Parallel()
	organizations := core.NewBaseCollection("organizations")
	organizations.Fields.Add(
		&core.SelectField{Name: "accessStatus", Values: []string{"active", "suspended"}, MaxSelect: 1},
		&core.SelectField{Name: "accessOverride", Values: []string{"active", "suspended"}, MaxSelect: 1},
	)
	subscriptions := core.NewBaseCollection("organization_subscriptions")
	subscriptions.Fields.Add(
		&core.SelectField{Name: "billingStatus", Values: []string{"active", "past_due"}, MaxSelect: 1},
		&core.DateField{Name: "graceEndsAt"},
		&core.DateField{Name: "readOnlyUntil"},
	)
	organization := core.NewRecord(organizations)
	organization.Set("accessStatus", "suspended")
	organization.Set("accessOverride", "suspended")
	subscription := core.NewRecord(subscriptions)

	applySubscriptionStatus(subscription, organization, "active", time.Now())

	if got := organization.GetString("accessStatus"); got != "suspended" {
		t.Fatalf("accessStatus = %q, want suspended", got)
	}
	if got := subscription.GetString("billingStatus"); got != "active" {
		t.Fatalf("billingStatus = %q, want active", got)
	}
}

func TestInvoiceSnapshotDoesNotReactivateSubscription(t *testing.T) {
	t.Parallel()
	organizations := core.NewBaseCollection("organizations")
	organizations.Fields.Add(&core.SelectField{Name: "accessStatus", Values: []string{"active", "grace"}, MaxSelect: 1})
	subscriptions := core.NewBaseCollection("organization_subscriptions")
	subscriptions.Fields.Add(
		&core.SelectField{Name: "billingStatus", Values: []string{"active", "past_due"}, MaxSelect: 1},
		&core.DateField{Name: "lastStripeEventAt"},
	)
	organization := core.NewRecord(organizations)
	organization.Set("accessStatus", "grace")
	subscription := core.NewRecord(subscriptions)
	subscription.Set("billingStatus", "past_due")

	outcome := applyStripeObject(subscription, organization, "invoice.paid", stripeObject{}, time.Now())

	if outcome != "ignored" || subscription.GetString("billingStatus") != "past_due" || organization.GetString("accessStatus") != "grace" {
		t.Fatalf("invoice snapshot changed lifecycle: outcome=%q billing=%q access=%q", outcome, subscription.GetString("billingStatus"), organization.GetString("accessStatus"))
	}
}

func TestCheckoutRequiresCompleteBillingConfiguration(t *testing.T) {
	t.Parallel()
	service := &Service{enabled: true, secretKey: "sk_test", publicURL: "https://example.com"}
	if service.checkoutConfigured() {
		t.Fatal("checkout configured without webhook secret")
	}
	service.webhookSecret = "whsec_test"
	if !service.checkoutConfigured() {
		t.Fatal("complete billing configuration was rejected")
	}
	service.enabled = false
	if service.checkoutConfigured() {
		t.Fatal("checkout configured while billing flag is disabled")
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

func TestQuantityIdempotencyKeyChangesWithRevision(t *testing.T) {
	t.Parallel()
	firstFive := quantityIdempotencyKey("sub_record", 1)
	six := quantityIdempotencyKey("sub_record", 2)
	secondFive := quantityIdempotencyKey("sub_record", 3)
	if firstFive == six || firstFive == secondFive || six == secondFive {
		t.Fatalf("quantity keys must be unique per revision: %q, %q, %q", firstFive, six, secondFive)
	}
}
