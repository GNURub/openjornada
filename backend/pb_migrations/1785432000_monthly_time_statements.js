migrate((app) => {
  const organizations = app.findCollectionByNameOrId("organizations")
  const users = app.findCollectionByNameOrId("users")

  const statements = new Collection({
    type: "base",
    name: "monthly_time_statements",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
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
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "period", type: "text", required: true, min: 7, max: 7 },
      { name: "version", type: "number", required: true, min: 1 },
      {
        name: "employmentType",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["full_time", "part_time"],
      },
      { name: "contractedMinutes", type: "number", min: 0 },
      { name: "ordinaryMinutes", type: "number", min: 0 },
      { name: "complementaryMinutes", type: "number", min: 0 },
      { name: "overtimeMinutes", type: "number", min: 0 },
      { name: "totalMinutes", type: "number", min: 0 },
      {
        name: "dailyRecords",
        type: "json",
        required: true,
        maxSize: 524288,
      },
      {
        name: "generatedBy",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "generatedAt", type: "date", required: true },
      { name: "deliveredAt", type: "date", required: true },
      { name: "previousHash", type: "text", max: 64 },
      { name: "integrityHash", type: "text", required: true, max: 64 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_monthly_statement_version ON monthly_time_statements (employee, period, version)",
      "CREATE INDEX idx_monthly_statement_org_period ON monthly_time_statements (organization, period)",
    ],
  })
  app.save(statements)
  statements.fields.add(new RelationField({
    name: "previousStatement",
    maxSelect: 1,
    collectionId: statements.id,
    cascadeDelete: false,
  }))
  app.save(statements)

  const acknowledgements = new Collection({
    type: "base",
    name: "monthly_statement_acknowledgements",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (user = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (user = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
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
        name: "statement",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: statements.id,
        cascadeDelete: false,
      },
      {
        name: "user",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "acknowledgedAt", type: "date", required: true },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_monthly_statement_ack ON monthly_statement_acknowledgements (statement, user)",
      "CREATE INDEX idx_monthly_statement_ack_org ON monthly_statement_acknowledgements (organization, acknowledgedAt)",
    ],
  })
  app.save(acknowledgements)
}, (app) => {
  app.delete(app.findCollectionByNameOrId("monthly_statement_acknowledgements"))
  app.delete(app.findCollectionByNameOrId("monthly_time_statements"))
})
