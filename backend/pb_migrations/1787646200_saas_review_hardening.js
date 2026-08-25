migrate(
  (app) => {
    const organizations = app.findCollectionByNameOrId("organizations");
    organizations.fields.add(
      new SelectField({
        name: "accessOverride",
        maxSelect: 1,
        values: ["trialing", "active", "grace", "read_only", "suspended"],
      }),
    );
    app.save(organizations);

    const users = app.findCollectionByNameOrId("users");
    users.authRule =
      "active = true && verified = true && invitationStatus != 'pending'";
    app.save(users);

    const subscriptions = app.findCollectionByNameOrId(
      "organization_subscriptions",
    );
    subscriptions.fields.add(
      new TextField({
        name: "stripeSubscriptionItemId",
        max: 120,
        hidden: true,
      }),
    );
    subscriptions.fields.add(
      new NumberField({
        name: "stripeQuantitySynced",
        min: 0,
        max: 100000,
        hidden: true,
      }),
    );
    app.save(subscriptions);

    app
      .db()
      .newQuery(
        `CREATE TRIGGER openjornada_users_plan_capacity_insert
         BEFORE INSERT ON users
         WHEN NEW.active = 1
          AND COALESCE((
            SELECT p.headcountLimit
            FROM organization_subscriptions s
            JOIN saas_plans p ON p.id = s.plan
            WHERE s.organization = NEW.organization
          ), 0) > 0
          AND (SELECT COUNT(*) FROM users u WHERE u.organization = NEW.organization AND u.active = 1) >= (
            SELECT p.headcountLimit
            FROM organization_subscriptions s
            JOIN saas_plans p ON p.id = s.plan
            WHERE s.organization = NEW.organization
          )
         BEGIN
           SELECT RAISE(ABORT, 'plan headcount limit reached');
         END`,
      )
      .execute();
    app
      .db()
      .newQuery(
        `CREATE TRIGGER openjornada_users_plan_capacity_update
         BEFORE UPDATE OF active, organization ON users
         WHEN NEW.active = 1 AND (OLD.active = 0 OR OLD.organization != NEW.organization)
          AND COALESCE((
            SELECT p.headcountLimit
            FROM organization_subscriptions s
            JOIN saas_plans p ON p.id = s.plan
            WHERE s.organization = NEW.organization
          ), 0) > 0
          AND (SELECT COUNT(*) FROM users u WHERE u.organization = NEW.organization AND u.active = 1 AND u.id != NEW.id) >= (
            SELECT p.headcountLimit
            FROM organization_subscriptions s
            JOIN saas_plans p ON p.id = s.plan
            WHERE s.organization = NEW.organization
          )
         BEGIN
           SELECT RAISE(ABORT, 'plan headcount limit reached');
         END`,
      )
      .execute();
  },
  (app) => {
    app
      .db()
      .newQuery("DROP TRIGGER IF EXISTS openjornada_users_plan_capacity_update")
      .execute();
    app
      .db()
      .newQuery("DROP TRIGGER IF EXISTS openjornada_users_plan_capacity_insert")
      .execute();

    const subscriptions = app.findCollectionByNameOrId(
      "organization_subscriptions",
    );
    subscriptions.fields.removeByName("stripeQuantitySynced");
    subscriptions.fields.removeByName("stripeSubscriptionItemId");
    app.save(subscriptions);

    const users = app.findCollectionByNameOrId("users");
    users.authRule = "active = true";
    app.save(users);

    const organizations = app.findCollectionByNameOrId("organizations");
    organizations.fields.removeByName("accessOverride");
    app.save(organizations);
  },
);
