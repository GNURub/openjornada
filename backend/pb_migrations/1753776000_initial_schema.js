migrate((app) => {
  const organizations = new Collection({
    type: "base",
    name: "organizations",
    listRule: "@request.auth.id != '' && id = @request.auth.organization",
    viewRule: "@request.auth.id != '' && id = @request.auth.organization",
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "name", type: "text", required: true, max: 160 },
      { name: "taxId", type: "text", max: 24 },
      { name: "timezone", type: "text", required: true, max: 64 },
      { name: "retentionYears", type: "number", required: true, min: 4, max: 10 },
      { name: "privacyContact", type: "email" },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_organizations_tax_id ON organizations (taxId) WHERE taxId != ''",
    ],
  })
  app.save(organizations)

  const users = app.findCollectionByNameOrId("users")
  users.authRule = "active = true"
  users.listRule =
    "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative' || id = @request.auth.id)"
  users.viewRule =
    "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative' || id = @request.auth.id)"
  users.createRule =
    "@request.auth.id != '' && (@request.auth.role = 'admin' || @request.auth.role = 'manager') && @request.body.organization = @request.auth.organization"
  users.updateRule =
    "@request.auth.id != '' && organization = @request.auth.organization && (id = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')"
  users.deleteRule = null
  users.manageRule =
    "@request.auth.id != '' && organization = @request.auth.organization && @request.auth.role = 'admin'"
  users.passwordAuth.enabled = true
  users.passwordAuth.identityFields = ["email"]
  users.mfa.enabled = false
  users.mfa.duration = 1800
  users.mfa.rule = ""
  users.verificationTemplate.subject = "Verifica tu acceso a {APP_NAME}"
  users.verificationTemplate.body =
    '<p>Hola,</p><p>Tu empresa ha creado un acceso a {APP_NAME}.</p><p><a class="btn" href="{APP_URL}/verificar/{TOKEN}" target="_blank" rel="noopener">Verificar correo</a></p><p>Si no esperabas este mensaje, puedes ignorarlo.</p>'
  users.resetPasswordTemplate.subject = "Restablece tu contraseña de {APP_NAME}"
  users.resetPasswordTemplate.body =
    '<p>Hola,</p><p>Hemos recibido una solicitud para restablecer tu contraseña.</p><p><a class="btn" href="{APP_URL}/restablecer/{TOKEN}" target="_blank" rel="noopener">Crear nueva contraseña</a></p><p>Si no has sido tú, ignora este mensaje.</p>'

  const nameField = users.fields.getByName("name")
  nameField.required = true
  nameField.max = 160
  nameField.presentable = true
  users.fields.add(new RelationField({
    name: "organization",
    required: true,
    maxSelect: 1,
    collectionId: organizations.id,
    cascadeDelete: false,
  }))
  users.fields.add(new SelectField({
    name: "role",
    required: true,
    maxSelect: 1,
    values: ["admin", "manager", "employee", "representative"],
  }))
  users.fields.add(new BoolField({ name: "active" }))
  users.fields.add(new TextField({ name: "employeeCode", max: 40 }))
  users.fields.add(new NumberField({ name: "weeklyHours", min: 0, max: 80 }))
  users.fields.add(new TextField({ name: "jobTitle", max: 120 }))
  users.fields.add(new DateField({ name: "privacyNoticeAcceptedAt" }))
  users.indexes.push(
    "CREATE UNIQUE INDEX idx_users_employee_code ON users (organization, employeeCode) WHERE employeeCode != ''",
    "CREATE INDEX idx_users_organization_role ON users (organization, role)",
  )
  app.save(users)

  const workEvents = new Collection({
    id: "workevents00001",
    type: "base",
    name: "work_events",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    createRule: "@request.auth.id != ''",
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        name: "employee",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      {
        name: "organization",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: organizations.id,
        cascadeDelete: false,
      },
      {
        name: "kind",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["clock_in", "break_start", "break_end", "clock_out", "correction"],
      },
      { name: "occurredAt", type: "date", required: true },
      { name: "timezone", type: "text", required: true, max: 64 },
      {
        name: "source",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["desktop", "mobile", "tablet", "admin"],
      },
      { name: "note", type: "text", max: 500 },
      {
        name: "createdBy",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "previousHash", type: "text", max: 64 },
      { name: "integrityHash", type: "text", required: true, max: 64 },
      { name: "clientRequestId", type: "text", required: true, max: 64 },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_work_events_request ON work_events (clientRequestId)",
      "CREATE INDEX idx_work_events_employee_time ON work_events (employee, occurredAt)",
      "CREATE INDEX idx_work_events_org_time ON work_events (organization, occurredAt)",
    ],
  })
  app.save(workEvents)
  workEvents.fields.add(new RelationField({
    name: "corrects",
    maxSelect: 1,
    collectionId: workEvents.id,
    cascadeDelete: false,
  }))
  app.save(workEvents)

  const auditLogs = new Collection({
    type: "base",
    name: "audit_logs",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'representative')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'representative')",
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
        name: "actor",
        type: "relation",
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "action", type: "text", required: true, max: 120 },
      { name: "entityType", type: "text", required: true, max: 80 },
      { name: "entityId", type: "text", required: true, max: 64 },
      { name: "metadata", type: "json", maxSize: 8192 },
      { name: "occurredAt", type: "date", required: true },
    ],
    indexes: [
      "CREATE INDEX idx_audit_logs_org_time ON audit_logs (organization, occurredAt)",
    ],
  })
  app.save(auditLogs)
}, (app) => {
  for (const name of ["audit_logs", "work_events", "organizations"]) {
    try {
      app.delete(app.findCollectionByNameOrId(name))
    } catch (_) {
      // Supports partial rollback during local development.
    }
  }
})
