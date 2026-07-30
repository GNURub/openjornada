migrate((app) => {
  const organizations = app.findCollectionByNameOrId("organizations")
  const users = app.findCollectionByNameOrId("users")
  const workEvents = app.findCollectionByNameOrId("work_events")

  organizations.fields.add(new BoolField({
    name: "manualTimeApprovalRequired",
  }))
  app.save(organizations)

  const breakTypes = new Collection({
    type: "base",
    name: "break_types",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    createRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && organization = @request.auth.organization",
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
      { name: "name", type: "text", required: true, min: 2, max: 80 },
      { name: "paid", type: "bool" },
      { name: "active", type: "bool" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_break_types_name ON break_types (organization, name)",
      "CREATE INDEX idx_break_types_active ON break_types (organization, active)",
    ],
  })
  app.save(breakTypes)

  const manualRequests = new Collection({
    type: "base",
    name: "manual_time_requests",
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
        cascadeDelete: true,
      },
      {
        name: "employee",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "workDate", type: "date", required: true },
      { name: "timezone", type: "text", required: true, max: 64 },
      { name: "intervals", type: "json", required: true, maxSize: 16384 },
      { name: "reason", type: "text", required: true, min: 8, max: 500 },
      {
        name: "status",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["pending", "approved", "rejected", "cancelled"],
      },
      { name: "approvalRequired", type: "bool" },
      {
        name: "resolvedBy",
        type: "relation",
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "resolvedAt", type: "date" },
      { name: "resolutionNote", type: "text", max: 500 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_manual_time_requests_org_status ON manual_time_requests (organization, status, created)",
      "CREATE INDEX idx_manual_time_requests_employee_date ON manual_time_requests (employee, workDate)",
    ],
  })
  app.save(manualRequests)

  workEvents.fields.getByName("source").values = [
    "desktop",
    "mobile",
    "tablet",
    "admin",
    "manual",
  ]
  workEvents.fields.add(new RelationField({
    name: "manualRequest",
    maxSelect: 1,
    collectionId: manualRequests.id,
    cascadeDelete: false,
  }))
  workEvents.fields.add(new RelationField({
    name: "breakType",
    maxSelect: 1,
    collectionId: breakTypes.id,
    cascadeDelete: false,
  }))
  workEvents.fields.add(new BoolField({ name: "breakPaid" }))
  workEvents.indexes.push(
    "CREATE INDEX idx_work_events_manual_request ON work_events (manualRequest)",
  )
  app.save(workEvents)

  const organizationRecords = app.findRecordsByFilter(
    "organizations",
    "id != ''",
    "id",
    10000,
    0,
  )
  for (const organization of organizationRecords) {
    const breakType = new Record(breakTypes)
    breakType.set("organization", organization.id)
    breakType.set("name", "Comida")
    breakType.set("paid", false)
    breakType.set("active", true)
    app.save(breakType)
  }
}, (app) => {
  const workEvents = app.findCollectionByNameOrId("work_events")
  const manualEvents = app.findRecordsByFilter(
    "work_events",
    "source = 'manual'",
    "created",
    10000,
    0,
  )
  for (const event of manualEvents) {
    event.set("source", "admin")
    event.set("manualRequest", "")
    event.set("breakType", "")
    event.set("breakPaid", false)
    app.save(event)
  }

  workEvents.indexes = workEvents.indexes.filter(
    (index) => !index.includes("idx_work_events_manual_request"),
  )
  workEvents.fields.removeByName("manualRequest")
  workEvents.fields.removeByName("breakType")
  workEvents.fields.removeByName("breakPaid")
  workEvents.fields.getByName("source").values = [
    "desktop",
    "mobile",
    "tablet",
    "admin",
  ]
  app.save(workEvents)

  app.delete(app.findCollectionByNameOrId("manual_time_requests"))
  app.delete(app.findCollectionByNameOrId("break_types"))

  const organizations = app.findCollectionByNameOrId("organizations")
  organizations.fields.removeByName("manualTimeApprovalRequired")
  app.save(organizations)
})
