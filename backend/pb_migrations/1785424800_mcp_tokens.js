migrate((app) => {
  const organizations = app.findCollectionByNameOrId("organizations")
  const users = app.findCollectionByNameOrId("users")

  const tokens = new Collection({
    type: "base",
    name: "mcp_tokens",
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
        name: "createdBy",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: true,
      },
      { name: "name", type: "text", required: true, min: 3, max: 80 },
      {
        name: "prefix",
        type: "text",
        required: true,
        min: 12,
        max: 12,
      },
      {
        name: "tokenHash",
        type: "text",
        required: true,
        min: 64,
        max: 64,
        hidden: true,
      },
      { name: "expiresAt", type: "date", required: true },
      { name: "lastUsedAt", type: "date" },
      { name: "revokedAt", type: "date" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_mcp_tokens_prefix ON mcp_tokens (prefix)",
      "CREATE INDEX idx_mcp_tokens_owner ON mcp_tokens (organization, createdBy, expiresAt)",
    ],
  })

  app.save(tokens)
}, (app) => {
  app.delete(app.findCollectionByNameOrId("mcp_tokens"))
})
