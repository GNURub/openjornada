migrate(
  (app) => {
    const organizations = app.findCollectionByNameOrId("organizations");
    const users = app.findCollectionByNameOrId("users");

    users.fields.add(
      new SelectField({
        name: "invitationStatus",
        maxSelect: 1,
        values: ["pending", "accepted"],
      }),
    );
    users.fields.add(new DateField({ name: "invitationSentAt" }));
    users.fields.add(new DateField({ name: "invitationExpiresAt" }));
    users.fields.add(new DateField({ name: "invitationAcceptedAt" }));
    users.indexes.push(
      "CREATE INDEX idx_users_invitation_status ON users (organization, invitationStatus)",
    );
    app.save(users);

    const invitations = new Collection({
      type: "base",
      name: "user_invitations",
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
          cascadeDelete: true,
        },
        {
          name: "user",
          type: "relation",
          required: true,
          maxSelect: 1,
          collectionId: users.id,
          cascadeDelete: true,
        },
        { name: "email", type: "email", required: true },
        { name: "tokenHash", type: "text", required: true, max: 64 },
        {
          name: "status",
          type: "select",
          required: true,
          maxSelect: 1,
          values: ["pending", "accepted", "revoked"],
        },
        { name: "sentAt", type: "date", required: true },
        { name: "expiresAt", type: "date", required: true },
        { name: "acceptedAt", type: "date" },
        {
          name: "invitedBy",
          type: "relation",
          required: true,
          maxSelect: 1,
          collectionId: users.id,
          cascadeDelete: false,
        },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_user_invitations_token_hash ON user_invitations (tokenHash)",
        "CREATE INDEX idx_user_invitations_user_status ON user_invitations (user, status, expiresAt)",
      ],
    });
    app.save(invitations);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("user_invitations"));
    } catch (_) {
      // Allows rolling back a partially applied local migration.
    }

    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("invitationStatus");
    users.fields.removeByName("invitationSentAt");
    users.fields.removeByName("invitationExpiresAt");
    users.fields.removeByName("invitationAcceptedAt");
    users.indexes = users.indexes.filter(
      (index) => !index.includes("idx_users_invitation_status"),
    );
    app.save(users);
  },
);
