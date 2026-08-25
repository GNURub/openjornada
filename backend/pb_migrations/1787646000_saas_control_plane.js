migrate(
  (app) => {
    const organizations = app.findCollectionByNameOrId("organizations");
    const users = app.findCollectionByNameOrId("users");

    organizations.fields.add(
      new SelectField({
        name: "accessStatus",
        maxSelect: 1,
        values: ["trialing", "active", "grace", "read_only", "suspended"],
      }),
    );
    app.save(organizations);

    const operators = new Collection({
      type: "auth",
      name: "platform_operators",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      authRule: "active = true",
      manageRule: null,
      fields: [
        {
          name: "name",
          type: "text",
          required: true,
          max: 160,
          presentable: true,
        },
        {
          name: "role",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["admin", "support"],
        },
        { name: "active", type: "bool" },
      ],
      passwordAuth: { enabled: true, identityFields: ["email"] },
      otp: { enabled: true, duration: 600 },
      mfa: { enabled: true, duration: 300, rule: "" },
      authToken: { duration: 28800 },
      indexes: [
        "CREATE INDEX idx_platform_operators_role ON platform_operators (role, active)",
      ],
    });
    app.save(operators);

    const invitations = app.findCollectionByNameOrId("user_invitations");
    invitations.fields.getByName("invitedBy").required = false;
    invitations.fields.add(
      new RelationField({
        name: "platformOperator",
        maxSelect: 1,
        collectionId: operators.id,
        cascadeDelete: false,
      }),
    );
    app.save(invitations);

    const plans = new Collection({
      type: "base",
      name: "saas_plans",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "code", type: "text", required: true, max: 40 },
        { name: "name", type: "text", required: true, max: 120 },
        {
          name: "billingModel",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["fixed", "tiered"],
        },
        { name: "stripePriceId", type: "text", max: 120, hidden: true },
        { name: "headcountLimit", type: "number", min: 0, max: 100000 },
        { name: "active", type: "bool" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_saas_plans_code ON saas_plans (code)",
        "CREATE UNIQUE INDEX idx_saas_plans_stripe_price ON saas_plans (stripePriceId) WHERE stripePriceId != ''",
      ],
    });
    app.save(plans);

    const subscriptions = new Collection({
      type: "base",
      name: "organization_subscriptions",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        {
          name: "organization",
          type: "relation",
          required: true,
          maxSelect: 1,
          collectionId: organizations.id,
          cascadeDelete: false,
        },
        {
          name: "plan",
          type: "relation",
          maxSelect: 1,
          collectionId: plans.id,
          cascadeDelete: false,
        },
        {
          name: "billingStatus",
          type: "select",
          required: true,
          maxSelect: 1,
          values: [
            "manual_active",
            "trialing",
            "active",
            "past_due",
            "canceled",
          ],
        },
        {
          name: "declaredHeadcount",
          type: "number",
          required: true,
          min: 1,
          max: 100000,
        },
        { name: "stripeCustomerId", type: "text", max: 120, hidden: true },
        { name: "stripeSubscriptionId", type: "text", max: 120, hidden: true },
        { name: "trialEndsAt", type: "date" },
        { name: "graceEndsAt", type: "date" },
        { name: "readOnlyUntil", type: "date" },
        { name: "currentPeriodEnd", type: "date" },
        { name: "lastStripeEventAt", type: "date" },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_organization_subscriptions_org ON organization_subscriptions (organization)",
        "CREATE UNIQUE INDEX idx_organization_subscriptions_customer ON organization_subscriptions (stripeCustomerId) WHERE stripeCustomerId != ''",
        "CREATE UNIQUE INDEX idx_organization_subscriptions_stripe ON organization_subscriptions (stripeSubscriptionId) WHERE stripeSubscriptionId != ''",
      ],
    });
    app.save(subscriptions);

    const auditLogs = new Collection({
      type: "base",
      name: "platform_audit_logs",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        {
          name: "operator",
          type: "relation",
          maxSelect: 1,
          collectionId: operators.id,
          cascadeDelete: false,
        },
        {
          name: "organization",
          type: "relation",
          maxSelect: 1,
          collectionId: organizations.id,
          cascadeDelete: false,
        },
        { name: "action", type: "text", required: true, max: 120 },
        { name: "entityType", type: "text", required: true, max: 80 },
        { name: "entityId", type: "text", max: 64 },
        { name: "reason", type: "text", max: 500 },
        { name: "requestId", type: "text", max: 80 },
        { name: "metadata", type: "json", maxSize: 8192 },
        { name: "occurredAt", type: "date", required: true },
      ],
      indexes: [
        "CREATE INDEX idx_platform_audit_time ON platform_audit_logs (occurredAt)",
        "CREATE INDEX idx_platform_audit_org ON platform_audit_logs (organization, occurredAt)",
      ],
    });
    app.save(auditLogs);

    const idempotency = new Collection({
      type: "base",
      name: "platform_idempotency",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        {
          name: "operator",
          type: "relation",
          maxSelect: 1,
          collectionId: operators.id,
          cascadeDelete: false,
        },
        { name: "scope", type: "text", required: true, max: 80 },
        { name: "key", type: "text", required: true, max: 80 },
        { name: "result", type: "json", maxSize: 8192 },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
        { name: "expiresAt", type: "date", required: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_platform_idempotency_scope_key ON platform_idempotency (scope, key)",
        "CREATE INDEX idx_platform_idempotency_expiry ON platform_idempotency (expiresAt)",
      ],
    });
    app.save(idempotency);

    const manualPlan = new Record(plans);
    manualPlan.set("code", "managed-manual");
    manualPlan.set("name", "Gestionado manual");
    manualPlan.set("billingModel", "fixed");
    manualPlan.set("headcountLimit", 0);
    manualPlan.set("active", true);
    app.save(manualPlan);

    const organizationRecords = app.findRecordsByFilter(
      "organizations",
      "id != ''",
      "id",
      10000,
      0,
    );
    for (const organization of organizationRecords) {
      organization.set("accessStatus", "active");
      app.save(organization);
      const activeUsers = app.findRecordsByFilter(
        "users",
        "organization = {:organization} && active = true",
        "id",
        10000,
        0,
        { organization: organization.id },
      );
      const subscription = new Record(subscriptions);
      subscription.set("organization", organization.id);
      subscription.set("plan", manualPlan.id);
      subscription.set("billingStatus", "manual_active");
      subscription.set("declaredHeadcount", Math.max(1, activeUsers.length));
      app.save(subscription);
    }
  },
  (app) => {
    const invitations = app.findCollectionByNameOrId("user_invitations");
    invitations.fields.removeByName("platformOperator");
    invitations.fields.getByName("invitedBy").required = true;
    app.save(invitations);

    for (const name of [
      "platform_idempotency",
      "platform_audit_logs",
      "organization_subscriptions",
      "saas_plans",
      "platform_operators",
    ]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (_) {}
    }
    const organizations = app.findCollectionByNameOrId("organizations");
    organizations.fields.removeByName("accessStatus");
    app.save(organizations);
  },
);
