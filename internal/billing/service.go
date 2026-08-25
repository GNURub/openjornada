package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const (
	stripeAPIBase      = "https://api.stripe.com/v1"
	maxWebhookBodySize = 1 << 20
	webhookTolerance   = 5 * time.Minute
)

type Service struct {
	app           core.App
	client        *http.Client
	secretKey     string
	webhookSecret string
	publicURL     string
	apiVersion    string
	priceByPlan   map[string]string
}

type stripeEvent struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Created int64  `json:"created"`
	Data    struct {
		Object json.RawMessage `json:"object"`
	} `json:"data"`
}

type stripeObject struct {
	ID                  string            `json:"id"`
	Customer            expandableID      `json:"customer"`
	Subscription        expandableID      `json:"subscription"`
	Status              string            `json:"status"`
	CurrentPeriodEnd    int64             `json:"current_period_end"`
	TrialEnd            int64             `json:"trial_end"`
	ClientReferenceID   string            `json:"client_reference_id"`
	Metadata            map[string]string `json:"metadata"`
	CustomerEmail       string            `json:"customer_email"`
	SubscriptionDetails json.RawMessage   `json:"subscription_details"`
	Parent              struct {
		SubscriptionDetails *struct {
			Subscription expandableID      `json:"subscription"`
			Metadata     map[string]string `json:"metadata"`
		} `json:"subscription_details"`
	} `json:"parent"`
	Items struct {
		Data []struct {
			CurrentPeriodEnd int64 `json:"current_period_end"`
		} `json:"data"`
	} `json:"items"`
}

type expandableID string

func (id *expandableID) UnmarshalJSON(data []byte) error {
	var value string
	if err := json.Unmarshal(data, &value); err == nil {
		*id = expandableID(value)
		return nil
	}
	var object struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &object); err != nil {
		return err
	}
	*id = expandableID(object.ID)
	return nil
}

type stripeResponse struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

func New(app core.App) *Service {
	return &Service{
		app:           app,
		client:        &http.Client{Timeout: 15 * time.Second},
		secretKey:     strings.TrimSpace(os.Getenv("STRIPE_SECRET_KEY")),
		webhookSecret: strings.TrimSpace(os.Getenv("STRIPE_WEBHOOK_SECRET")),
		publicURL:     strings.TrimRight(strings.TrimSpace(os.Getenv("PB_PUBLIC_URL")), "/"),
		apiVersion:    strings.TrimSpace(os.Getenv("STRIPE_API_VERSION")),
		priceByPlan: map[string]string{
			"starter-fixed": strings.TrimSpace(os.Getenv("STRIPE_PRICE_STARTER_FIXED")),
			"growth-tiered": strings.TrimSpace(os.Getenv("STRIPE_PRICE_GROWTH_TIERED")),
		},
	}
}

func (s *Service) Register(e *core.ServeEvent) {
	e.Router.GET("/api/openjornada/billing/status", s.status).
		Bind(apis.RequireAuth("users"), apis.SkipSuccessActivityLog())
	e.Router.POST("/api/openjornada/billing/checkout", s.checkout).
		Bind(apis.RequireAuth("users"))
	e.Router.POST("/api/openjornada/billing/portal", s.portal).
		Bind(apis.RequireAuth("users"))
	e.Router.POST("/api/openjornada/stripe/webhook", s.webhook).
		Bind(apis.SkipSuccessActivityLog())
}

func (s *Service) status(e *core.RequestEvent) error {
	if err := requireTenantAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	subscription, err := e.App.FindFirstRecordByFilter(
		"organization_subscriptions",
		"organization = {:organization}",
		dbxParams("organization", e.Auth.GetString("organization")),
	)
	if err != nil {
		return e.NotFoundError("No se encontró la suscripción de la empresa.", err)
	}
	plan, _ := e.App.FindRecordById("saas_plans", subscription.GetString("plan"))
	planName := ""
	if plan != nil {
		planName = plan.GetString("name")
	}
	return e.JSON(http.StatusOK, map[string]any{
		"billingStatus":     subscription.GetString("billingStatus"),
		"planName":          planName,
		"declaredHeadcount": subscription.GetInt("declaredHeadcount"),
		"trialEndsAt":       subscription.GetDateTime("trialEndsAt").String(),
		"graceEndsAt":       subscription.GetDateTime("graceEndsAt").String(),
		"readOnlyUntil":     subscription.GetDateTime("readOnlyUntil").String(),
		"currentPeriodEnd":  subscription.GetDateTime("currentPeriodEnd").String(),
		"checkoutAvailable": s.checkoutConfigured(),
		"portalAvailable":   s.checkoutConfigured() && subscription.GetString("stripeCustomerId") != "",
	})
}

func (s *Service) checkout(e *core.RequestEvent) error {
	if err := requireTenantAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	if !s.checkoutConfigured() {
		return e.Error(http.StatusServiceUnavailable, "La facturación no está configurada.", nil)
	}
	organizationID := e.Auth.GetString("organization")
	subscription, err := e.App.FindFirstRecordByFilter(
		"organization_subscriptions",
		"organization = {:organization}",
		dbxParams("organization", organizationID),
	)
	if err != nil {
		return e.NotFoundError("No se encontró la suscripción de la empresa.", err)
	}
	if subscription.GetString("billingStatus") == "active" && subscription.GetString("stripeSubscriptionId") != "" {
		return e.Error(http.StatusConflict, "La empresa ya tiene una suscripción activa; utiliza el portal de facturación.", nil)
	}
	idempotencyKey := strings.TrimSpace(e.Request.Header.Get("Idempotency-Key"))
	if !validIdempotencyKey(idempotencyKey) {
		return e.BadRequestError("Falta una clave de idempotencia válida.", nil)
	}
	plan, err := e.App.FindRecordById("saas_plans", subscription.GetString("plan"))
	if err != nil {
		return e.BadRequestError("El plan configurado ya no está disponible.", err)
	}
	priceID := s.priceByPlan[plan.GetString("code")]
	if priceID == "" {
		priceID = plan.GetString("stripePriceId")
	}
	if priceID == "" {
		return e.Error(http.StatusServiceUnavailable, "El precio de este plan no está configurado.", nil)
	}
	quantity := 1
	if plan.GetString("billingModel") == "tiered" {
		activeUsers, _ := e.App.FindRecordsByFilter(
			"users",
			"organization = {:organization} && active = true",
			"id",
			100000,
			0,
			dbxParams("organization", organizationID),
		)
		quantity = max(1, subscription.GetInt("declaredHeadcount"), len(activeUsers))
	}
	values := url.Values{
		"mode":                     {"subscription"},
		"client_reference_id":      {organizationID},
		"line_items[0][price]":     {priceID},
		"line_items[0][quantity]":  {strconv.Itoa(quantity)},
		"metadata[organizationId]": {organizationID},
		"subscription_data[metadata][organizationId]": {organizationID},
		"success_url": {s.publicURL + "/ajustes?billing=success"},
		"cancel_url":  {s.publicURL + "/ajustes?billing=cancel"},
	}
	if customerID := subscription.GetString("stripeCustomerId"); customerID != "" {
		values.Set("customer", customerID)
	} else {
		values.Set("customer_email", e.Auth.Email())
	}
	var response stripeResponse
	if err := s.postStripe(e.Request.Context(), "/checkout/sessions", values, &response, idempotencyKey); err != nil {
		return e.Error(http.StatusBadGateway, "No se pudo iniciar el pago.", err)
	}
	if response.URL == "" {
		return e.InternalServerError("Stripe no devolvió una URL de pago.", nil)
	}
	return e.JSON(http.StatusOK, map[string]string{"url": response.URL})
}

func (s *Service) portal(e *core.RequestEvent) error {
	if err := requireTenantAdmin(e.Auth); err != nil {
		return e.ForbiddenError(err.Error(), nil)
	}
	if !s.checkoutConfigured() {
		return e.Error(http.StatusServiceUnavailable, "La facturación no está configurada.", nil)
	}
	subscription, err := e.App.FindFirstRecordByFilter(
		"organization_subscriptions",
		"organization = {:organization}",
		dbxParams("organization", e.Auth.GetString("organization")),
	)
	if err != nil || subscription.GetString("stripeCustomerId") == "" {
		return e.BadRequestError("La empresa todavía no tiene un perfil de facturación.", err)
	}
	var response stripeResponse
	if err := s.postStripe(e.Request.Context(), "/billing_portal/sessions", url.Values{
		"customer":   {subscription.GetString("stripeCustomerId")},
		"return_url": {s.publicURL + "/ajustes"},
	}, &response); err != nil {
		return e.Error(http.StatusBadGateway, "No se pudo abrir el portal de facturación.", err)
	}
	return e.JSON(http.StatusOK, map[string]string{"url": response.URL})
}

func (s *Service) webhook(e *core.RequestEvent) error {
	if s.webhookSecret == "" {
		return e.Error(http.StatusServiceUnavailable, "Webhook no configurado.", nil)
	}
	payload, err := io.ReadAll(io.LimitReader(e.Request.Body, maxWebhookBodySize+1))
	if err != nil || len(payload) > maxWebhookBodySize {
		return e.BadRequestError("El webhook no es válido.", err)
	}
	if err := verifyWebhookSignature(payload, e.Request.Header.Get("Stripe-Signature"), s.webhookSecret, time.Now()); err != nil {
		return e.BadRequestError("La firma del webhook no es válida.", err)
	}
	var event stripeEvent
	if err := json.Unmarshal(payload, &event); err != nil || event.ID == "" || event.Created <= 0 {
		return e.BadRequestError("El evento de Stripe no es válido.", err)
	}
	if _, err := e.App.FindFirstRecordByData("stripe_webhook_events", "eventId", event.ID); err == nil {
		return e.JSON(http.StatusOK, map[string]bool{"received": true})
	}
	payloadHash := sha256.Sum256(payload)
	outcome, err := s.applyEvent(e.App, event, hex.EncodeToString(payloadHash[:]))
	if err != nil {
		return e.InternalServerError("No se pudo aplicar el evento de facturación.", err)
	}
	return e.JSON(http.StatusOK, map[string]any{"received": true, "outcome": outcome})
}

func (s *Service) applyEvent(app core.App, event stripeEvent, payloadHash string) (string, error) {
	var object stripeObject
	if err := json.Unmarshal(event.Data.Object, &object); err != nil {
		return "", err
	}
	normalizeStripeObject(&object)
	outcome := "ignored"
	err := app.RunInTransaction(func(tx core.App) error {
		if _, err := tx.FindFirstRecordByData("stripe_webhook_events", "eventId", event.ID); err == nil {
			outcome = "duplicate"
			return nil
		}
		subscription, organization, err := findSubscriptionForEvent(tx, object)
		if err == nil && subscription != nil {
			last := subscription.GetDateTime("lastStripeEventAt").Time()
			eventTime := time.Unix(event.Created, 0).UTC()
			if last.IsZero() || !eventTime.Before(last) {
				outcome = applyStripeObject(subscription, organization, event.Type, object, eventTime)
				if outcome == "applied" {
					if err := tx.Save(subscription); err != nil {
						return err
					}
					if err := tx.Save(organization); err != nil {
						return err
					}
					if err := saveSystemAudit(tx, organization.Id, event.Type, event.ID); err != nil {
						return err
					}
				}
			}
		}
		record := core.NewRecord(mustCollection(tx, "stripe_webhook_events"))
		record.Set("eventId", event.ID)
		record.Set("eventType", event.Type)
		record.Set("payloadHash", payloadHash)
		record.Set("eventCreatedAt", time.Unix(event.Created, 0).UTC().Format(time.RFC3339Nano))
		record.Set("processedAt", time.Now().UTC().Format(time.RFC3339Nano))
		record.Set("outcome", outcome)
		return tx.Save(record)
	})
	return outcome, err
}

func normalizeStripeObject(object *stripeObject) {
	if object.Subscription == "" && object.Parent.SubscriptionDetails != nil {
		object.Subscription = object.Parent.SubscriptionDetails.Subscription
	}
	if len(object.Metadata) == 0 && object.Parent.SubscriptionDetails != nil {
		object.Metadata = object.Parent.SubscriptionDetails.Metadata
	}
	if object.CurrentPeriodEnd == 0 {
		for _, item := range object.Items.Data {
			if item.CurrentPeriodEnd > object.CurrentPeriodEnd {
				object.CurrentPeriodEnd = item.CurrentPeriodEnd
			}
		}
	}
}

func applyStripeObject(subscription, organization *core.Record, eventType string, object stripeObject, eventTime time.Time) string {
	switch eventType {
	case "checkout.session.completed":
		if object.Customer != "" {
			subscription.Set("stripeCustomerId", string(object.Customer))
		}
		if object.Subscription != "" {
			subscription.Set("stripeSubscriptionId", string(object.Subscription))
		}
	case "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted":
		subscription.Set("stripeCustomerId", string(object.Customer))
		subscription.Set("stripeSubscriptionId", object.ID)
		if object.CurrentPeriodEnd > 0 {
			subscription.Set("currentPeriodEnd", time.Unix(object.CurrentPeriodEnd, 0).UTC().Format(time.RFC3339Nano))
		}
		applySubscriptionStatus(subscription, organization, object.Status, eventTime)
	case "invoice.payment_failed":
		applySubscriptionStatus(subscription, organization, "past_due", eventTime)
	case "invoice.paid", "invoice.payment_succeeded":
		applySubscriptionStatus(subscription, organization, "active", eventTime)
	default:
		return "ignored"
	}
	subscription.Set("lastStripeEventAt", eventTime.Format(time.RFC3339Nano))
	return "applied"
}

func applySubscriptionStatus(subscription, organization *core.Record, status string, now time.Time) {
	switch status {
	case "active":
		subscription.Set("billingStatus", "active")
		subscription.Set("graceEndsAt", "")
		subscription.Set("readOnlyUntil", "")
		organization.Set("accessStatus", "active")
	case "trialing":
		subscription.Set("billingStatus", "trialing")
		organization.Set("accessStatus", "trialing")
	case "past_due", "unpaid", "paused", "incomplete":
		subscription.Set("billingStatus", "past_due")
		setGraceDates(subscription, now)
		organization.Set("accessStatus", "grace")
	case "canceled", "incomplete_expired":
		subscription.Set("billingStatus", "canceled")
		setGraceDates(subscription, now)
		organization.Set("accessStatus", "grace")
	}
}

func setGraceDates(subscription *core.Record, now time.Time) {
	if subscription.GetDateTime("graceEndsAt").Time().After(now) {
		return
	}
	subscription.Set("graceEndsAt", now.Add(7*24*time.Hour).Format(time.RFC3339Nano))
	subscription.Set("readOnlyUntil", now.Add(37*24*time.Hour).Format(time.RFC3339Nano))
}

func findSubscriptionForEvent(app core.App, object stripeObject) (*core.Record, *core.Record, error) {
	organizationID := object.ClientReferenceID
	if organizationID == "" && object.Metadata != nil {
		organizationID = object.Metadata["organizationId"]
	}
	filters := []struct {
		field string
		value string
	}{
		{"organization", organizationID},
		{"stripeSubscriptionId", firstNonEmpty(string(object.Subscription), object.ID)},
		{"stripeCustomerId", string(object.Customer)},
	}
	for _, candidate := range filters {
		if candidate.value == "" {
			continue
		}
		record, err := app.FindFirstRecordByData("organization_subscriptions", candidate.field, candidate.value)
		if err != nil {
			continue
		}
		organization, err := app.FindRecordById("organizations", record.GetString("organization"))
		return record, organization, err
	}
	return nil, nil, errors.New("subscription not found")
}

func (s *Service) postStripe(ctx context.Context, path string, values url.Values, destination any, idempotencyKeys ...string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, stripeAPIBase+path, strings.NewReader(values.Encode()))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+s.secretKey)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if len(idempotencyKeys) > 0 && idempotencyKeys[0] != "" {
		request.Header.Set("Idempotency-Key", idempotencyKeys[0])
	}
	if s.apiVersion != "" {
		request.Header.Set("Stripe-Version", s.apiVersion)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, 1<<20)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, limited)
		return fmt.Errorf("stripe returned status %d", response.StatusCode)
	}
	return json.NewDecoder(limited).Decode(destination)
}

func validIdempotencyKey(value string) bool {
	if len(value) < 16 || len(value) > 80 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			strings.ContainsRune("._:-", character) {
			continue
		}
		return false
	}
	return true
}

func (s *Service) checkoutConfigured() bool {
	if s.secretKey == "" || s.publicURL == "" {
		return false
	}
	parsed, err := url.Parse(s.publicURL)
	return err == nil && parsed.Host != "" && (parsed.Scheme == "https" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "localhost")
}

func verifyWebhookSignature(payload []byte, header, secret string, now time.Time) error {
	var timestamp int64
	var signatures []string
	for _, part := range strings.Split(header, ",") {
		key, value, found := strings.Cut(strings.TrimSpace(part), "=")
		if !found {
			continue
		}
		switch key {
		case "t":
			timestamp, _ = strconv.ParseInt(value, 10, 64)
		case "v1":
			signatures = append(signatures, value)
		}
	}
	if timestamp <= 0 || len(signatures) == 0 {
		return errors.New("missing signature components")
	}
	created := time.Unix(timestamp, 0)
	if now.Sub(created) > webhookTolerance || created.Sub(now) > webhookTolerance {
		return errors.New("signature timestamp outside tolerance")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = fmt.Fprintf(mac, "%d.", timestamp)
	_, _ = mac.Write(payload)
	expected := mac.Sum(nil)
	for _, signature := range signatures {
		decoded, err := hex.DecodeString(signature)
		if err == nil && hmac.Equal(decoded, expected) {
			return nil
		}
	}
	return errors.New("signature mismatch")
}

func saveSystemAudit(app core.App, organizationID, eventType, eventID string) error {
	record := core.NewRecord(mustCollection(app, "platform_audit_logs"))
	record.Set("organization", organizationID)
	record.Set("action", "stripe.webhook_applied")
	record.Set("entityType", "stripe_event")
	record.Set("entityId", eventID)
	record.Set("reason", "Actualización firmada recibida desde Stripe.")
	record.Set("metadata", map[string]any{"eventType": eventType})
	record.Set("occurredAt", time.Now().UTC().Format(time.RFC3339Nano))
	return app.Save(record)
}

func requireTenantAdmin(auth *core.Record) error {
	if auth == nil || auth.Collection().Name != "users" || auth.GetString("role") != "admin" {
		return errors.New("sólo la administración de la empresa puede gestionar la facturación")
	}
	return nil
}

func mustCollection(app core.App, name string) *core.Collection {
	collection, err := app.FindCollectionByNameOrId(name)
	if err != nil {
		panic(err)
	}
	return collection
}

func dbxParams(key, value string) map[string]any {
	return map[string]any{key: value}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
