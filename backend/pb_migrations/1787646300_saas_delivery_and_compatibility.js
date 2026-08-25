migrate(
  (app) => {
    const idempotency = app.findCollectionByNameOrId("platform_idempotency");
    idempotency.fields.add(
      new SelectField({
        name: "deliveryStatus",
        maxSelect: 1,
        values: ["pending", "sending", "sent"],
      }),
    );
    idempotency.fields.add(new DateField({ name: "deliveryClaimedAt" }));
    idempotency.fields.add(
      new TextField({
        name: "deliveryTokenCiphertext",
        max: 2048,
        hidden: true,
      }),
    );
    idempotency.indexes.push(
      "CREATE INDEX idx_platform_idempotency_delivery ON platform_idempotency (scope, deliveryStatus, expiresAt)",
    );
    app.save(idempotency);

    const subscriptions = app.findCollectionByNameOrId(
      "organization_subscriptions",
    );
    subscriptions.fields.add(
      new NumberField({
        name: "stripeQuantityRevision",
        min: 0,
        max: 1000000000,
        hidden: true,
      }),
    );
    subscriptions.fields.add(
      new NumberField({
        name: "stripeQuantityPending",
        min: 0,
        max: 100000,
        hidden: true,
      }),
    );
    app.save(subscriptions);

    const legacyTrials = app.findRecordsByFilter(
      "organization_subscriptions",
      "billingStatus = 'trialing' && trialEndsAt = ''",
      "id",
      10000,
      0,
    );
    for (const subscription of legacyTrials) {
      const owners = app.findRecordsByFilter(
        "users",
        "organization = {:organization} && role = 'admin' && invitationStatus = ''",
        "id",
        100,
        0,
        { organization: subscription.getString("organization") },
      );
      for (const owner of owners) {
        owner.set("invitationStatus", "pending");
        app.save(owner);
      }
    }

    const users = app.findCollectionByNameOrId("users");
    users.authRule = "active = true && invitationStatus != 'pending'";
    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.authRule =
      "active = true && verified = true && invitationStatus != 'pending'";
    app.save(users);

    const subscriptions = app.findCollectionByNameOrId(
      "organization_subscriptions",
    );
    subscriptions.fields.removeByName("stripeQuantityPending");
    subscriptions.fields.removeByName("stripeQuantityRevision");
    app.save(subscriptions);

    const idempotency = app.findCollectionByNameOrId("platform_idempotency");
    idempotency.fields.removeByName("deliveryTokenCiphertext");
    idempotency.fields.removeByName("deliveryClaimedAt");
    idempotency.fields.removeByName("deliveryStatus");
    idempotency.indexes = idempotency.indexes.filter(
      (index) => !index.includes("idx_platform_idempotency_delivery"),
    );
    app.save(idempotency);
  },
);
