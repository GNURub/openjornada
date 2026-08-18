migrate((app) => {
  const organizations = app.findCollectionByNameOrId("organizations")
  const users = app.findCollectionByNameOrId("users")
  const workEvents = app.findCollectionByNameOrId("work_events")

  organizations.fields.add(new TextField({
    name: "terminalAdminPinHash",
    max: 255,
    hidden: true,
  }))
  organizations.fields.add(new NumberField({
    name: "rfidCacheRevision",
    min: 0,
  }))
  app.save(organizations)

  users.fields.add(new TextField({
    name: "rfidUidFingerprint",
    max: 64,
    hidden: true,
  }))
  users.fields.add(new TextField({
    name: "rfidUidCiphertext",
    max: 2048,
    hidden: true,
  }))
  users.indexes.push(
    "CREATE UNIQUE INDEX idx_users_rfid_uid ON users (rfidUidFingerprint) WHERE rfidUidFingerprint != ''",
  )
  app.save(users)

  const terminals = new Collection({
    type: "base",
    name: "attendance_terminals",
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
        cascadeDelete: false,
      },
      { name: "name", type: "text", required: true, min: 3, max: 80 },
      { name: "prefix", type: "text", required: true, min: 12, max: 12 },
      { name: "tokenHash", type: "text", required: true, min: 64, max: 64, hidden: true },
      { name: "signingMaterial", type: "text", required: true, max: 2048, hidden: true },
      { name: "protocolVersion", type: "number", min: 1, max: 1 },
      { name: "clientVersion", type: "text", max: 40 },
      { name: "cacheRevision", type: "number", min: 0 },
      { name: "lastSeenAt", type: "date" },
      { name: "lastPendingCount", type: "number", min: 0, max: 10000 },
      { name: "revokedAt", type: "date" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_attendance_terminals_prefix ON attendance_terminals (prefix)",
      "CREATE INDEX idx_attendance_terminals_org ON attendance_terminals (organization, revokedAt, created)",
    ],
  })
  app.save(terminals)

  const sessions = new Collection({
    type: "base",
    name: "terminal_admin_sessions",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "organization", type: "relation", required: true, maxSelect: 1, collectionId: organizations.id, cascadeDelete: true },
      { name: "terminal", type: "relation", required: true, maxSelect: 1, collectionId: terminals.id, cascadeDelete: true },
      { name: "tokenHash", type: "text", required: true, min: 64, max: 64, hidden: true },
      { name: "lastUsedAt", type: "date", required: true },
      { name: "revokedAt", type: "date" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_terminal_admin_sessions_token ON terminal_admin_sessions (tokenHash)",
      "CREATE INDEX idx_terminal_admin_sessions_terminal ON terminal_admin_sessions (terminal, revokedAt)",
    ],
  })
  app.save(sessions)

  const attempts = new Collection({
    type: "base",
    name: "terminal_pin_attempts",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "organization", type: "relation", required: true, maxSelect: 1, collectionId: organizations.id, cascadeDelete: true },
      { name: "terminal", type: "relation", maxSelect: 1, collectionId: terminals.id, cascadeDelete: true },
      { name: "scope", type: "text", required: true, max: 64 },
      { name: "failures", type: "number", min: 0 },
      { name: "blockedUntil", type: "date" },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_terminal_pin_attempt_scope ON terminal_pin_attempts (organization, scope)",
    ],
  })
  app.save(attempts)

  const incidents = new Collection({
    type: "base",
    name: "terminal_sync_incidents",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "organization", type: "relation", required: true, maxSelect: 1, collectionId: organizations.id, cascadeDelete: true },
      { name: "terminal", type: "relation", required: true, maxSelect: 1, collectionId: terminals.id, cascadeDelete: false },
      { name: "employee", type: "relation", maxSelect: 1, collectionId: users.id, cascadeDelete: false },
      { name: "clientRequestId", type: "text", required: true, max: 128 },
      { name: "command", type: "select", required: true, maxSelect: 1, values: ["clock_in", "break_start", "break_end", "clock_out"] },
      { name: "deviceCapturedAt", type: "date", required: true },
      { name: "appliedAt", type: "date" },
      { name: "evidence", type: "json", maxSize: 8192 },
      { name: "reasonCode", type: "text", required: true, max: 80 },
      { name: "status", type: "select", required: true, maxSelect: 1, values: ["pending", "resolved"] },
      { name: "resolvedBy", type: "relation", maxSelect: 1, collectionId: users.id, cascadeDelete: false },
      { name: "resolvedAt", type: "date" },
      { name: "resolutionNote", type: "text", max: 500 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_terminal_incident_request ON terminal_sync_incidents (terminal, clientRequestId)",
      "CREATE INDEX idx_terminal_incident_org_status ON terminal_sync_incidents (organization, status, created)",
    ],
  })
  app.save(incidents)

  const receipts = new Collection({
    type: "base",
    name: "terminal_action_receipts",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      { name: "organization", type: "relation", required: true, maxSelect: 1, collectionId: organizations.id, cascadeDelete: true },
      { name: "terminal", type: "relation", required: true, maxSelect: 1, collectionId: terminals.id, cascadeDelete: true },
      { name: "clientRequestId", type: "text", required: true, max: 128 },
      { name: "status", type: "select", required: true, maxSelect: 1, values: ["accepted", "incident", "rejected"] },
      { name: "workEvent", type: "relation", maxSelect: 1, collectionId: workEvents.id, cascadeDelete: false },
      { name: "incident", type: "relation", maxSelect: 1, collectionId: incidents.id, cascadeDelete: false },
      { name: "response", type: "json", maxSize: 8192 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_terminal_receipt_request ON terminal_action_receipts (terminal, clientRequestId)",
    ],
  })
  app.save(receipts)

  workEvents.fields.getByName("source").values = [
    "desktop",
    "mobile",
    "tablet",
    "admin",
    "manual",
    "terminal",
  ]
  workEvents.fields.add(new RelationField({ name: "terminal", maxSelect: 1, collectionId: terminals.id, cascadeDelete: false }))
  workEvents.fields.add(new DateField({ name: "deviceCapturedAt" }))
  workEvents.fields.add(new DateField({ name: "clockSyncedAt" }))
  workEvents.fields.add(new NumberField({ name: "deviceSequence", min: 0 }))
  workEvents.fields.add(new BoolField({ name: "queuedOffline" }))
  workEvents.fields.getByName("integrityVersion").values = ["v1", "v2", "v3"]
  workEvents.indexes.push("CREATE INDEX idx_work_events_terminal ON work_events (terminal, deviceCapturedAt)")
  app.save(workEvents)
}, (app) => {
  const workEvents = app.findCollectionByNameOrId("work_events")
  workEvents.indexes = workEvents.indexes.filter((index) => !index.includes("idx_work_events_terminal"))
  for (const field of ["queuedOffline", "deviceSequence", "clockSyncedAt", "deviceCapturedAt", "terminal"]) {
    workEvents.fields.removeByName(field)
  }
  workEvents.fields.getByName("source").values = ["desktop", "mobile", "tablet", "admin", "manual"]
  workEvents.fields.getByName("integrityVersion").values = ["v1", "v2"]
  app.save(workEvents)

  for (const name of [
    "terminal_action_receipts",
    "terminal_sync_incidents",
    "terminal_pin_attempts",
    "terminal_admin_sessions",
    "attendance_terminals",
  ]) {
    app.delete(app.findCollectionByNameOrId(name))
  }

  const users = app.findCollectionByNameOrId("users")
  users.indexes = users.indexes.filter((index) => !index.includes("idx_users_rfid_uid"))
  users.fields.removeByName("rfidUidCiphertext")
  users.fields.removeByName("rfidUidFingerprint")
  app.save(users)

  const organizations = app.findCollectionByNameOrId("organizations")
  organizations.fields.removeByName("rfidCacheRevision")
  organizations.fields.removeByName("terminalAdminPinHash")
  app.save(organizations)
})
