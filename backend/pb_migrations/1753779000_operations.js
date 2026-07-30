migrate((app) => {
  const organizations = app.findCollectionByNameOrId("organizations")
  const users = app.findCollectionByNameOrId("users")
  const workEvents = app.findCollectionByNameOrId("work_events")

  organizations.updateRule =
    "@request.auth.id != '' && id = @request.auth.organization && @request.auth.role = 'admin'"
  app.save(organizations)

  workEvents.fields.add(new SelectField({
    name: "correctedKind",
    maxSelect: 1,
    values: ["clock_in", "break_start", "break_end", "clock_out"],
  }))
  workEvents.fields.add(new AutodateField({
    name: "created",
    onCreate: true,
    onUpdate: false,
  }))
  workEvents.fields.add(new AutodateField({
    name: "updated",
    onCreate: true,
    onUpdate: true,
  }))
  app.save(workEvents)

  const correctionRequests = new Collection({
    type: "base",
    name: "correction_requests",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    createRule:
      "@request.auth.id != '' && @request.body.employee = @request.auth.id && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager')",
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
      {
        name: "workEvent",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: workEvents.id,
        cascadeDelete: false,
      },
      {
        name: "requestedKind",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["clock_in", "break_start", "break_end", "clock_out"],
      },
      { name: "requestedOccurredAt", type: "date", required: true },
      { name: "reason", type: "text", required: true, min: 8, max: 500 },
      {
        name: "status",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["pending", "approved", "rejected"],
      },
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
      "CREATE INDEX idx_correction_requests_org_status ON correction_requests (organization, status)",
      "CREATE INDEX idx_correction_requests_employee ON correction_requests (employee, created)",
    ],
  })
  app.save(correctionRequests)

  const schedules = new Collection({
    type: "base",
    name: "work_schedules",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    createRule:
      "@request.auth.id != '' && (@request.auth.role = 'admin' || @request.auth.role = 'manager') && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager')",
    deleteRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager')",
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
      { name: "name", type: "text", required: true, max: 120 },
      { name: "validFrom", type: "date", required: true },
      { name: "validUntil", type: "date" },
      { name: "weekdays", type: "json", required: true, maxSize: 1024 },
      { name: "startTime", type: "text", required: true, min: 5, max: 5 },
      { name: "endTime", type: "text", required: true, min: 5, max: 5 },
      { name: "breakMinutes", type: "number", min: 0, max: 240 },
      { name: "active", type: "bool" },
      {
        name: "createdBy",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_work_schedules_employee_validity ON work_schedules (employee, validFrom, validUntil)",
    ],
  })
  app.save(schedules)

  const leaveRequests = new Collection({
    type: "base",
    name: "leave_requests",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    createRule:
      "@request.auth.id != '' && @request.body.employee = @request.auth.id && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager' || employee = @request.auth.id)",
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
      {
        name: "type",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["vacation", "medical", "personal", "other"],
      },
      { name: "startDate", type: "date", required: true },
      { name: "endDate", type: "date", required: true },
      {
        name: "dayPart",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["full", "morning", "afternoon"],
      },
      { name: "reason", type: "text", max: 500 },
      {
        name: "status",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["pending", "approved", "rejected", "cancelled"],
      },
      {
        name: "reviewedBy",
        type: "relation",
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "reviewedAt", type: "date" },
      { name: "response", type: "text", max: 500 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_leave_requests_org_status ON leave_requests (organization, status)",
      "CREATE INDEX idx_leave_requests_employee_dates ON leave_requests (employee, startDate, endDate)",
    ],
  })
  app.save(leaveRequests)

  const notifications = new Collection({
    type: "base",
    name: "notifications",
    listRule:
      "@request.auth.id != '' && recipient = @request.auth.id && organization = @request.auth.organization",
    viewRule:
      "@request.auth.id != '' && recipient = @request.auth.id && organization = @request.auth.organization",
    createRule: null,
    updateRule:
      "@request.auth.id != '' && recipient = @request.auth.id && organization = @request.auth.organization",
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
        name: "recipient",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "title", type: "text", required: true, max: 160 },
      { name: "message", type: "text", required: true, max: 500 },
      {
        name: "kind",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["info", "success", "warning", "request"],
      },
      { name: "link", type: "text", max: 240 },
      { name: "read", type: "bool" },
      {
        name: "createdBy",
        type: "relation",
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_notifications_recipient_read ON notifications (recipient, read, created)",
    ],
  })
  app.save(notifications)

  const announcements = new Collection({
    type: "base",
    name: "announcements",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    createRule:
      "@request.auth.id != '' && (@request.auth.role = 'admin' || @request.auth.role = 'manager') && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager')",
    deleteRule:
      "@request.auth.id != '' && organization = @request.auth.organization && @request.auth.role = 'admin'",
    fields: [
      {
        name: "organization",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: organizations.id,
        cascadeDelete: false,
      },
      { name: "title", type: "text", required: true, max: 160 },
      { name: "body", type: "text", required: true, max: 3000 },
      {
        name: "audience",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["all", "employees", "managers"],
      },
      { name: "sendEmail", type: "bool" },
      {
        name: "createdBy",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "publishedAt", type: "date", required: true },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_announcements_org_published ON announcements (organization, publishedAt)",
    ],
  })
  app.save(announcements)
}, (app) => {
  for (const name of [
    "announcements",
    "notifications",
    "leave_requests",
    "work_schedules",
    "correction_requests",
  ]) {
    try {
      app.delete(app.findCollectionByNameOrId(name))
    } catch (_) {
      // Supports partial rollback during local development.
    }
  }

  try {
    const workEvents = app.findCollectionByNameOrId("work_events")
    workEvents.fields.removeByName("correctedKind")
    app.save(workEvents)
  } catch (_) {
    // Supports partial rollback during local development.
  }
})
