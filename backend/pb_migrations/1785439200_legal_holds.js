migrate((app) => {
  const organizations = app.findCollectionByNameOrId("organizations")
  const users = app.findCollectionByNameOrId("users")
  const legalHolds = new Collection({
    type: "base",
    name: "legal_holds",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && @request.auth.role = 'admin'",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && @request.auth.role = 'admin'",
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
        name: "employee",
        type: "relation",
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "reason", type: "text", required: true, min: 8, max: 500 },
      { name: "fromDate", type: "date" },
      { name: "toDate", type: "date" },
      { name: "active", type: "bool" },
      {
        name: "createdBy",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      {
        name: "releasedBy",
        type: "relation",
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "releasedAt", type: "date" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_legal_holds_org_active ON legal_holds (organization, active)",
      "CREATE INDEX idx_legal_holds_employee ON legal_holds (employee, active)",
    ],
  })
  app.save(legalHolds)
}, (app) => {
  app.delete(app.findCollectionByNameOrId("legal_holds"))
})
