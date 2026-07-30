onBootstrap((e) => {
  e.next()

  const appName = $os.getenv("PB_APP_NAME") || "Aura Jornada"
  const appURL = $os.getenv("PB_PUBLIC_URL") || "http://127.0.0.1:8090"
  const settings = e.app.settings()
  settings.meta.appName = appName
  settings.meta.appURL = appURL
  settings.meta.senderName = $os.getenv("PB_MAIL_SENDER_NAME") || appName
  settings.meta.senderAddress =
    $os.getenv("PB_MAIL_SENDER_ADDRESS") || "no-reply@example.invalid"
  settings.logs.maxDays = 90
  settings.logs.logAuthId = true
  settings.logs.logIP = false
  settings.rateLimits.enabled = true

  const smtpHost = $os.getenv("PB_SMTP_HOST")
  if (smtpHost) {
    settings.smtp.enabled = true
    settings.smtp.host = smtpHost
    settings.smtp.port = Number($os.getenv("PB_SMTP_PORT") || "587")
    settings.smtp.username = $os.getenv("PB_SMTP_USERNAME")
    settings.smtp.password = $os.getenv("PB_SMTP_PASSWORD")
    settings.smtp.tls = ($os.getenv("PB_SMTP_TLS") || "false") === "true"
  }
  e.app.save(settings)

  const bootstrapEmail = $os.getenv("PB_BOOTSTRAP_ADMIN_EMAIL")
  const bootstrapPassword = $os.getenv("PB_BOOTSTRAP_ADMIN_PASSWORD")
  if (!bootstrapEmail || !bootstrapPassword) {
    return
  }

  try {
    e.app.findCollectionByNameOrId("organizations")
  } catch (_) {
    // During the very first `migrate up` bootstrap runs before app migrations.
    return
  }

  let organization
  try {
    organization = e.app.findFirstRecordByData(
      "organizations",
      "taxId",
      $os.getenv("PB_ORGANIZATION_TAX_ID") || "BOOTSTRAP",
    )
  } catch (_) {
    const collection = e.app.findCollectionByNameOrId("organizations")
    organization = new Record(collection)
    organization.set(
      "name",
      $os.getenv("PB_ORGANIZATION_NAME") || "Mi empresa de estética",
    )
    organization.set(
      "taxId",
      $os.getenv("PB_ORGANIZATION_TAX_ID") || "BOOTSTRAP",
    )
    organization.set("timezone", $os.getenv("PB_TIMEZONE") || "Europe/Madrid")
    organization.set("retentionYears", 4)
    organization.set("privacyContact", bootstrapEmail)
    e.app.save(organization)
  }

  try {
    e.app.findAuthRecordByEmail("users", bootstrapEmail)
  } catch (_) {
    const collection = e.app.findCollectionByNameOrId("users")
    const admin = new Record(collection)
    admin.set("email", bootstrapEmail)
    admin.set("password", bootstrapPassword)
    admin.set("passwordConfirm", bootstrapPassword)
    admin.set("verified", true)
    admin.set("name", $os.getenv("PB_BOOTSTRAP_ADMIN_NAME") || "Administración")
    admin.set("organization", organization.id)
    admin.set("role", "admin")
    admin.set("active", true)
    admin.set("employeeCode", "ADMIN")
    admin.set("weeklyHours", 40)
    admin.set("privacyNoticeAcceptedAt", new Date().toISOString())
    e.app.save(admin)
  }

  if (($os.getenv("PB_DEMO_ENABLED") || "false") === "true") {
    const demoEmail = $os.getenv("PB_DEMO_EMAIL") || "empleada@example.com"
    try {
      e.app.findAuthRecordByEmail("users", demoEmail)
    } catch (_) {
      const collection = e.app.findCollectionByNameOrId("users")
      const employee = new Record(collection)
      const demoPassword = $os.getenv("PB_DEMO_PASSWORD") || "DemoPassword123!"
      employee.set("email", demoEmail)
      employee.set("password", demoPassword)
      employee.set("passwordConfirm", demoPassword)
      employee.set("verified", true)
      employee.set("name", "Marina Estética")
      employee.set("organization", organization.id)
      employee.set("role", "employee")
      employee.set("active", true)
      employee.set("employeeCode", "EST-001")
      employee.set("weeklyHours", 40)
      employee.set("jobTitle", "Esteticista")
      employee.set("privacyNoticeAcceptedAt", new Date().toISOString())
      e.app.save(employee)
    }
  }
})

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) {
    return e.next()
  }
  if (!e.auth) {
    throw new UnauthorizedError("Debes iniciar sesión para fichar.")
  }

  const actorRole = e.auth.getString("role")
  const requestedKind = e.record.getString("kind")
  const isCorrection = requestedKind === "correction"
  const canCorrect = actorRole === "admin" || actorRole === "manager"

  if (isCorrection && !canCorrect) {
    throw new ForbiddenError("No tienes permisos para corregir fichajes.")
  }

  const employeeId = isCorrection
    ? e.record.getString("employee")
    : e.auth.id
  if (!employeeId) {
    throw new BadRequestError("El fichaje debe identificar a una persona.")
  }

  if (isCorrection) {
    const employee = e.app.findRecordById("users", employeeId)
    if (employee.getString("organization") !== e.auth.getString("organization")) {
      throw new ForbiddenError("La persona no pertenece a tu empresa.")
    }
    if (!e.record.getString("corrects") || !e.record.getString("note")) {
      throw new BadRequestError(
        "Una corrección debe indicar el fichaje afectado y su motivo.",
      )
    }
    if (!e.record.getString("correctedKind")) {
      throw new BadRequestError(
        "Una corrección debe indicar el tipo de evento correcto.",
      )
    }
    const correctedEvent = e.app.findRecordById(
      "work_events",
      e.record.getString("corrects"),
    )
    if (
      correctedEvent.getString("organization") !==
        e.auth.getString("organization") ||
      correctedEvent.getString("employee") !== employeeId
    ) {
      throw new ForbiddenError(
        "El fichaje corregido no pertenece a la persona y empresa indicadas.",
      )
    }
  }

  const now = new Date().toISOString()
  e.record.set("employee", employeeId)
  e.record.set("organization", e.auth.getString("organization"))
  e.record.set("createdBy", e.auth.id)
  e.record.set("occurredAt", isCorrection ? e.record.get("occurredAt") : now)
  e.record.set("timezone", $os.getenv("PB_TIMEZONE") || "Europe/Madrid")

  let latest = []
  try {
    latest = e.app.findRecordsByFilter(
      "work_events",
      "employee = {:employee} && kind != 'correction'",
      "-occurredAt",
      1,
      0,
      { employee: employeeId },
    )
  } catch (_) {
    latest = []
  }

  if (!isCorrection) {
    const previousKind = latest.length ? latest[0].getString("kind") : ""
    const allowed = {
      "": ["clock_in"],
      clock_out: ["clock_in"],
      clock_in: ["break_start", "clock_out"],
      break_start: ["break_end"],
      break_end: ["break_start", "clock_out"],
    }
    if (!allowed[previousKind] || allowed[previousKind].indexOf(requestedKind) < 0) {
      throw new BadRequestError("La secuencia del fichaje no es válida.")
    }
  }

  const previousHash = latest.length
    ? latest[0].getString("integrityHash")
    : ""
  const requestId = e.record.getString("clientRequestId")
  if (!requestId) {
    throw new BadRequestError("Falta el identificador único del dispositivo.")
  }
  e.record.set("previousHash", previousHash)
  e.record.set(
    "integrityHash",
    $security.sha256(
      [
        employeeId,
        e.auth.getString("organization"),
        requestedKind,
        e.record.getString("correctedKind"),
        e.record.getString("corrects"),
        e.record.getString("occurredAt"),
        requestId,
        previousHash,
      ].join("|"),
    ),
  )
  e.next()
}, "work_events")

onRecordAfterCreateSuccess((e) => {
  const audits = e.app.findCollectionByNameOrId("audit_logs")
  const audit = new Record(audits)
  audit.set("organization", e.record.getString("organization"))
  audit.set("actor", e.record.getString("createdBy"))
  audit.set("action", "work_event.created")
  audit.set("entityType", "work_event")
  audit.set("entityId", e.record.id)
  audit.set("metadata", {
    kind: e.record.getString("kind"),
    employee: e.record.getString("employee"),
    integrityHash: e.record.getString("integrityHash"),
  })
  audit.set("occurredAt", new Date().toISOString())
  e.app.save(audit)
  e.next()
}, "work_events")

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) {
    return e.next()
  }
  if (!e.auth) {
    throw new UnauthorizedError("Debes iniciar sesión.")
  }
  const actorRole = e.auth.getString("role")
  if (actorRole !== "admin" && actorRole !== "manager") {
    throw new ForbiddenError("No tienes permisos para crear personas.")
  }
  let role = e.record.getString("role") || "employee"
  if (actorRole === "manager" && role !== "employee") {
    role = "employee"
  }
  e.record.set("organization", e.auth.getString("organization"))
  e.record.set("role", role)
  e.record.set("active", true)
  e.record.set("verified", false)
  e.next()
}, "users")

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) {
    return e.next()
  }
  if (!e.auth) {
    throw new UnauthorizedError("Debes iniciar sesión.")
  }

  const original = e.record.original()
  const actorRole = e.auth.getString("role")
  const originalRole = original.getString("role")
  const sameUser = e.auth.id === e.record.id

  e.record.set("organization", original.getString("organization"))

  if (sameUser) {
    e.record.set("role", originalRole)
    e.record.set("active", original.getBool("active"))
    e.record.set("employeeCode", original.getString("employeeCode"))
    e.record.set("weeklyHours", original.getFloat("weeklyHours"))
    return e.next()
  }

  if (actorRole === "manager") {
    if (originalRole !== "employee") {
      throw new ForbiddenError("Una persona responsable solo puede gestionar empleadas.")
    }
    e.record.set("role", "employee")
  } else if (actorRole !== "admin") {
    throw new ForbiddenError("No tienes permisos para modificar esta persona.")
  }

  e.next()
}, "users")
