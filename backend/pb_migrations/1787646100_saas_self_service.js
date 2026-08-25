migrate(
  (app) => {
    const plans = app.findCollectionByNameOrId("saas_plans");

    for (const item of [
      {
        code: "starter-fixed",
        name: "Inicio",
        billingModel: "fixed",
        headcountLimit: 10,
      },
      {
        code: "growth-tiered",
        name: "Crecimiento",
        billingModel: "tiered",
        headcountLimit: 0,
      },
    ]) {
      const plan = new Record(plans);
      plan.set("code", item.code);
      plan.set("name", item.name);
      plan.set("billingModel", item.billingModel);
      plan.set("headcountLimit", item.headcountLimit);
      plan.set("active", true);
      app.save(plan);
    }

    const webhookEvents = new Collection({
      type: "base",
      name: "stripe_webhook_events",
      listRule: null,
      viewRule: null,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { name: "eventId", type: "text", required: true, max: 120 },
        { name: "eventType", type: "text", required: true, max: 120 },
        { name: "payloadHash", type: "text", required: true, max: 64 },
        { name: "eventCreatedAt", type: "date", required: true },
        { name: "processedAt", type: "date", required: true },
        {
          name: "outcome",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["applied", "ignored", "duplicate"],
        },
        { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_stripe_webhook_event ON stripe_webhook_events (eventId)",
        "CREATE INDEX idx_stripe_webhook_time ON stripe_webhook_events (eventCreatedAt)",
      ],
    });
    app.save(webhookEvents);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("stripe_webhook_events"));
    } catch (_) {}
    for (const code of ["starter-fixed", "growth-tiered"]) {
      try {
        app.delete(app.findFirstRecordByData("saas_plans", "code", code));
      } catch (_) {}
    }
  },
);
