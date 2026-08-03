onBootstrap((e) => {
  e.next();

  const appName = $os.getenv("PB_APP_NAME") || "OpenJornada";
  const appURL = $os.getenv("PB_PUBLIC_URL") || "http://127.0.0.1:8090";
  const settings = e.app.settings();
  settings.meta.appName = appName;
  settings.meta.appURL = appURL;
  settings.meta.senderName = $os.getenv("PB_MAIL_SENDER_NAME") || appName;
  settings.meta.senderAddress =
    $os.getenv("PB_MAIL_SENDER_ADDRESS") || "no-reply@example.invalid";
  settings.logs.maxDays = 90;
  settings.logs.logAuthId = true;
  settings.logs.logIP = false;
  settings.rateLimits.enabled = true;

  const smtpHost = $os.getenv("PB_SMTP_HOST");
  if (smtpHost) {
    settings.smtp.enabled = true;
    settings.smtp.host = smtpHost;
    settings.smtp.port = Number($os.getenv("PB_SMTP_PORT") || "587");
    settings.smtp.username = $os.getenv("PB_SMTP_USERNAME");
    settings.smtp.password = $os.getenv("PB_SMTP_PASSWORD");
    settings.smtp.tls = ($os.getenv("PB_SMTP_TLS") || "false") === "true";
  }
  e.app.save(settings);

  const bootstrapEmail = $os.getenv("PB_BOOTSTRAP_ADMIN_EMAIL");
  const bootstrapPassword = $os.getenv("PB_BOOTSTRAP_ADMIN_PASSWORD");
  if (!bootstrapEmail || !bootstrapPassword) {
    return;
  }

  try {
    e.app.findCollectionByNameOrId("organizations");
  } catch (_) {
    // During the very first `migrate up` bootstrap runs before app migrations.
    return;
  }

  let bootstrapAdmin = null;
  try {
    bootstrapAdmin = e.app.findAuthRecordByEmail("users", bootstrapEmail);
  } catch (_) {}

  let organization = null;
  if (bootstrapAdmin) {
    try {
      organization = e.app.findRecordById(
        "organizations",
        bootstrapAdmin.getString("organization"),
      );
    } catch (_) {}
  }
  if (!organization) {
    try {
      organization = e.app.findFirstRecordByData(
        "organizations",
        "taxId",
        $os.getenv("PB_ORGANIZATION_TAX_ID") || "BOOTSTRAP",
      );
    } catch (_) {}
  }
  if (!organization) {
    const collection = e.app.findCollectionByNameOrId("organizations");
    organization = new Record(collection);
    organization.set(
      "name",
      $os.getenv("PB_ORGANIZATION_NAME") || "Mi empresa de estética",
    );
    organization.set(
      "taxId",
      $os.getenv("PB_ORGANIZATION_TAX_ID") || "BOOTSTRAP",
    );
    organization.set("timezone", $os.getenv("PB_TIMEZONE") || "Europe/Madrid");
    organization.set("retentionYears", 4);
    organization.set("privacyContact", bootstrapEmail);
    organization.set("privacyNoticeVersion", "2026-07-30");
    organization.set("brandPrimaryColor", "#ef4d32");
    organization.set("brandSecondaryColor", "#1c1917");
    organization.set(
      "pwaName",
      $os.getenv("PB_ORGANIZATION_NAME") || "OpenJornada",
    );
    organization.set(
      "pwaShortName",
      ($os.getenv("PB_ORGANIZATION_NAME") || "OpenJornada").slice(0, 20),
    );
    organization.set("manualTimeApprovalRequired", false);
    organization.set("timeCorrectionApprovalRequired", true);
    e.app.save(organization);
  }

  let breakTypesCollection = null;
  try {
    breakTypesCollection = e.app.findCollectionByNameOrId("break_types");
  } catch (_) {
    // An existing installation reaches this bootstrap before the new
    // migration has created the collection.
  }
  if (breakTypesCollection) {
    try {
      e.app.findFirstRecordByFilter(
        "break_types",
        "organization = {:organization} && name = 'Comida'",
        { organization: organization.id },
      );
    } catch (_) {
      const breakType = new Record(breakTypesCollection);
      breakType.set("organization", organization.id);
      breakType.set("name", "Comida");
      breakType.set("paid", false);
      breakType.set("active", true);
      e.app.save(breakType);
    }
  }

  if (!bootstrapAdmin) {
    const collection = e.app.findCollectionByNameOrId("users");
    const admin = new Record(collection);
    admin.set("email", bootstrapEmail);
    admin.set("password", bootstrapPassword);
    admin.set("passwordConfirm", bootstrapPassword);
    admin.set("verified", true);
    admin.set(
      "name",
      $os.getenv("PB_BOOTSTRAP_ADMIN_NAME") || "Administración",
    );
    admin.set("organization", organization.id);
    admin.set("role", "admin");
    admin.set("active", true);
    admin.set("employeeCode", "ADMIN");
    admin.set("weeklyHours", 40);
    admin.set("employmentType", "full_time");
    admin.set("contractedWeeklyMinutes", 2400);
    admin.set("complementaryHoursAgreement", false);
    admin.set("scheduleMode", "scheduled");
    admin.set("flexibleWeekdays", [1, 2, 3, 4, 5]);
    admin.set("privacyNoticeAcknowledgedVersion", "");
    admin.set("privacyNoticeAcknowledgedAt", "");
    e.app.save(admin);
  }

  if (($os.getenv("PB_DEMO_ENABLED") || "false") === "true") {
    const demoEmail = $os.getenv("PB_DEMO_EMAIL") || "empleada@example.com";
    try {
      e.app.findAuthRecordByEmail("users", demoEmail);
    } catch (_) {
      const collection = e.app.findCollectionByNameOrId("users");
      const employee = new Record(collection);
      const demoPassword = $os.getenv("PB_DEMO_PASSWORD") || "DemoPassword123!";
      employee.set("email", demoEmail);
      employee.set("password", demoPassword);
      employee.set("passwordConfirm", demoPassword);
      employee.set("verified", true);
      employee.set("name", "Marina Estética");
      employee.set("organization", organization.id);
      employee.set("role", "employee");
      employee.set("active", true);
      employee.set("employeeCode", "EST-001");
      employee.set("weeklyHours", 40);
      employee.set("jobTitle", "Esteticista");
      employee.set("employmentType", "full_time");
      employee.set("contractedWeeklyMinutes", 2400);
      employee.set("complementaryHoursAgreement", false);
      employee.set("scheduleMode", "scheduled");
      employee.set("flexibleWeekdays", [1, 2, 3, 4, 5]);
      employee.set("privacyNoticeAcknowledgedVersion", "");
      employee.set("privacyNoticeAcknowledgedAt", "");
      e.app.save(employee);
    }
  }

  try {
    require(`${__hooks}/hr_suite_helpers.js`).seedOrganization(
      e.app,
      organization,
    );
  } catch (_) {
    // A partial installation may not have the HR collections yet.
  }
});

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) {
    return e.next();
  }
  if (!e.auth) {
    throw new UnauthorizedError("Debes iniciar sesión para fichar.");
  }

  const actorRole = e.auth.getString("role");
  const requestedKind = e.record.getString("kind");
  const isCorrection = requestedKind === "correction";
  const canCorrect = actorRole === "admin" || actorRole === "manager";

  if (isCorrection && !canCorrect) {
    throw new ForbiddenError("No tienes permisos para corregir fichajes.");
  }

  const employeeId = isCorrection ? e.record.getString("employee") : e.auth.id;
  if (!employeeId) {
    throw new BadRequestError("El fichaje debe identificar a una persona.");
  }

  if (isCorrection) {
    const employee = e.app.findRecordById("users", employeeId);
    if (
      employee.getString("organization") !== e.auth.getString("organization")
    ) {
      throw new ForbiddenError("La persona no pertenece a tu empresa.");
    }
    if (!e.record.getString("corrects") || !e.record.getString("note")) {
      throw new BadRequestError(
        "Una corrección debe indicar el fichaje afectado y su motivo.",
      );
    }
    if (!e.record.getString("correctedKind")) {
      throw new BadRequestError(
        "Una corrección debe indicar el tipo de evento correcto.",
      );
    }
    const correctedEvent = e.app.findRecordById(
      "work_events",
      e.record.getString("corrects"),
    );
    if (
      correctedEvent.getString("organization") !==
        e.auth.getString("organization") ||
      correctedEvent.getString("employee") !== employeeId
    ) {
      throw new ForbiddenError(
        "El fichaje corregido no pertenece a la persona y empresa indicadas.",
      );
    }
  }

  const serverNow = new Date();
  const recordedAt = serverNow.toISOString();
  const requestedAdjustmentReason = e.record
    .getString("adjustmentReason")
    .trim();
  e.record.set("employee", employeeId);
  e.record.set("organization", e.auth.getString("organization"));
  e.record.set("createdBy", e.auth.id);
  e.record.set("timezone", $os.getenv("PB_TIMEZONE") || "Europe/Madrid");
  e.record.set("recordedAt", recordedAt);
  e.record.set("adjustmentSeconds", 0);
  e.record.set("adjustmentReason", "");
  e.record.set("integrityVersion", "v2");

  let latestByTime = [];
  try {
    latestByTime = e.app.findRecordsByFilter(
      "work_events",
      "employee = {:employee} && kind != 'correction'",
      "-occurredAt",
      1,
      0,
      { employee: employeeId },
    );
  } catch (_) {
    latestByTime = [];
  }

  if (!isCorrection) {
    const previousKind = latestByTime.length
      ? latestByTime[0].getString("kind")
      : "";
    const allowed = {
      "": ["clock_in"],
      clock_out: ["clock_in"],
      clock_in: ["break_start", "clock_out"],
      break_start: ["break_end"],
      break_end: ["break_start", "clock_out"],
    };
    if (
      !allowed[previousKind] ||
      allowed[previousKind].indexOf(requestedKind) < 0
    ) {
      throw new BadRequestError("La secuencia del fichaje no es válida.");
    }
  }

  let occurredAt = isCorrection
    ? e.record.getString("occurredAt")
    : serverNow.toISOString();
  const canReviewEnd =
    !isCorrection &&
    (requestedKind === "clock_out" || requestedKind === "break_end");
  if (canReviewEnd) {
    let reviewedEnd = new Date(e.record.getString("occurredAt"));
    if (isNaN(reviewedEnd.getTime())) {
      throw new BadRequestError("La hora final revisada no es válida.");
    }
    if (reviewedEnd.getTime() > serverNow.getTime()) {
      throw new BadRequestError("La hora final no puede estar en el futuro.");
    }
    if (latestByTime.length) {
      const latestAt = new Date(
        latestByTime[0].getString("occurredAt"),
      );
      if (reviewedEnd.getTime() < latestAt.getTime()) {
        if (latestAt.getTime() - reviewedEnd.getTime() < 1_000) {
          reviewedEnd = latestAt;
        } else {
          throw new BadRequestError(
            "La hora final no puede ser anterior al último fichaje.",
          );
        }
      }
    }
    occurredAt = reviewedEnd.toISOString();
    const adjustmentSeconds = Math.floor(
      (serverNow.getTime() - reviewedEnd.getTime()) / 1000,
    );
    const adjustmentReason = requestedAdjustmentReason;
    if (adjustmentSeconds >= 60 && adjustmentReason.length < 8) {
      throw new BadRequestError(
        "Explica brevemente por qué ajustas la hora final (mínimo 8 caracteres).",
      );
    }
    e.record.set("adjustmentSeconds", Math.max(0, adjustmentSeconds));
    e.record.set(
      "adjustmentReason",
      adjustmentSeconds >= 60 ? adjustmentReason : "",
    );
    if (adjustmentSeconds >= 60) {
      e.record.set("note", adjustmentReason);
    }
  }
  e.record.set("occurredAt", occurredAt);

  let previousHash = "";
  try {
    previousHash = require(`${__hooks}/timesheet_helpers.js`).integrityTipHash(
      e.app,
      employeeId,
    );
  } catch (_) {
    previousHash = latestByTime.length
      ? latestByTime[0].getString("integrityHash")
      : "";
  }
  const requestId = e.record.getString("clientRequestId");
  if (!requestId) {
    throw new BadRequestError("Falta el identificador único del dispositivo.");
  }
  e.record.set("previousHash", previousHash);
  e.record.set(
    "integrityHash",
    $security.sha256(
      [
        "v2",
        employeeId,
        e.auth.getString("organization"),
        requestedKind,
        e.record.getString("correctedKind"),
        e.record.getString("corrects"),
        new Date(e.record.getString("occurredAt")).toISOString(),
        new Date(recordedAt).toISOString(),
        e.record.getFloat("adjustmentSeconds"),
        e.record.getString("adjustmentReason"),
        requestId,
        previousHash,
      ].join("|"),
    ),
  );
  e.next();
}, "work_events");

onRecordAfterCreateSuccess((e) => {
  const audits = e.app.findCollectionByNameOrId("audit_logs");
  const audit = new Record(audits);
  audit.set("organization", e.record.getString("organization"));
  audit.set("actor", e.record.getString("createdBy"));
  audit.set("action", "work_event.created");
  audit.set("entityType", "work_event");
  audit.set("entityId", e.record.id);
  audit.set("metadata", {
    kind: e.record.getString("kind"),
    employee: e.record.getString("employee"),
    integrityHash: e.record.getString("integrityHash"),
    occurredAt: e.record.getString("occurredAt"),
    recordedAt: e.record.getString("recordedAt"),
    adjustmentSeconds: e.record.getFloat("adjustmentSeconds"),
    adjustmentReason: e.record.getString("adjustmentReason"),
    integrityVersion: e.record.getString("integrityVersion"),
  });
  audit.set("occurredAt", new Date().toISOString());
  e.app.save(audit);
  e.next();
}, "work_events");

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) {
    return e.next();
  }
  if (!e.auth) {
    throw new UnauthorizedError("Debes iniciar sesión.");
  }
  const actorRole = e.auth.getString("role");
  if (actorRole !== "admin" && actorRole !== "manager") {
    throw new ForbiddenError("No tienes permisos para crear personas.");
  }
  let role = e.record.getString("role") || "employee";
  if (actorRole === "manager" && role !== "employee") {
    role = "employee";
  }
  e.record.set("organization", e.auth.getString("organization"));
  e.record.set("role", role);
  e.record.set("active", true);
  e.record.set("verified", false);
  e.record.set("invitationStatus", "");
  e.record.set("invitationSentAt", "");
  e.record.set("invitationExpiresAt", "");
  e.record.set("invitationAcceptedAt", "");
  e.record.set("privacyNoticeAcknowledgedVersion", "");
  e.record.set("privacyNoticeAcknowledgedAt", "");
  const employmentType = e.record.getString("employmentType") || "unknown";
  e.record.set(
    "employmentType",
    employmentType === "full_time" || employmentType === "part_time"
      ? employmentType
      : "unknown",
  );
  if (!e.record.getFloat("contractedWeeklyMinutes")) {
    e.record.set(
      "contractedWeeklyMinutes",
      Math.max(0, Math.round(e.record.getFloat("weeklyHours") * 60)),
    );
  }
  e.record.set(
    "weeklyHours",
    Math.max(0, e.record.getFloat("contractedWeeklyMinutes") / 60),
  );
  const scheduleMode = e.record.getString("scheduleMode");
  e.record.set(
    "scheduleMode",
    scheduleMode === "weekly_flexible" ? "weekly_flexible" : "scheduled",
  );
  let flexibleWeekdays = e.record.get("flexibleWeekdays");
  try {
    if (typeof flexibleWeekdays === "string") {
      flexibleWeekdays = JSON.parse(flexibleWeekdays || "[]");
    }
  } catch (_) {
    flexibleWeekdays = [];
  }
  const selectedWeekdays = {};
  for (const value of Array.from(flexibleWeekdays || [])) {
    const weekday = Number(value);
    if (Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) {
      selectedWeekdays[weekday] = true;
    }
  }
  const normalizedWeekdays = [1, 2, 3, 4, 5, 6, 0].filter(
    (weekday) => selectedWeekdays[weekday],
  );
  e.record.set(
    "flexibleWeekdays",
    normalizedWeekdays.length ? normalizedWeekdays : [1, 2, 3, 4, 5],
  );
  e.next();
}, "users");

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) {
    return e.next();
  }
  if (!e.auth) {
    throw new UnauthorizedError("Debes iniciar sesión.");
  }

  const original = e.record.original();
  const actorRole = e.auth.getString("role");
  const originalRole = original.getString("role");
  const sameUser = e.auth.id === e.record.id;

  e.record.set("organization", original.getString("organization"));
  e.record.set("invitationStatus", original.getString("invitationStatus"));
  e.record.set("invitationSentAt", original.getString("invitationSentAt"));
  e.record.set(
    "invitationExpiresAt",
    original.getString("invitationExpiresAt"),
  );
  e.record.set(
    "invitationAcceptedAt",
    original.getString("invitationAcceptedAt"),
  );
  e.record.set(
    "privacyNoticeAcknowledgedVersion",
    original.getString("privacyNoticeAcknowledgedVersion"),
  );
  e.record.set(
    "privacyNoticeAcknowledgedAt",
    original.getString("privacyNoticeAcknowledgedAt"),
  );

  if (sameUser) {
    e.record.set("role", originalRole);
    e.record.set("active", original.getBool("active"));
    e.record.set("employeeCode", original.getString("employeeCode"));
    e.record.set("weeklyHours", original.getFloat("weeklyHours"));
    e.record.set("employmentType", original.getString("employmentType"));
    e.record.set(
      "contractedWeeklyMinutes",
      original.getFloat("contractedWeeklyMinutes"),
    );
    e.record.set(
      "complementaryHoursAgreement",
      original.getBool("complementaryHoursAgreement"),
    );
    e.record.set("scheduleMode", original.getString("scheduleMode"));
    e.record.set("flexibleWeekdays", original.get("flexibleWeekdays"));
    return e.next();
  }

  if (actorRole === "manager") {
    if (originalRole !== "employee") {
      throw new ForbiddenError(
        "Una persona responsable solo puede gestionar empleadas.",
      );
    }
    e.record.set("role", "employee");
  } else if (actorRole !== "admin") {
    throw new ForbiddenError("No tienes permisos para modificar esta persona.");
  }

  e.record.set(
    "scheduleMode",
    e.record.getString("scheduleMode") === "weekly_flexible"
      ? "weekly_flexible"
      : "scheduled",
  );
  let flexibleWeekdays = e.record.get("flexibleWeekdays");
  try {
    if (typeof flexibleWeekdays === "string") {
      flexibleWeekdays = JSON.parse(flexibleWeekdays || "[]");
    }
  } catch (_) {
    flexibleWeekdays = [];
  }
  const selectedWeekdays = {};
  for (const value of Array.from(flexibleWeekdays || [])) {
    const weekday = Number(value);
    if (Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) {
      selectedWeekdays[weekday] = true;
    }
  }
  const normalizedWeekdays = [1, 2, 3, 4, 5, 6, 0].filter(
    (weekday) => selectedWeekdays[weekday],
  );
  e.record.set(
    "flexibleWeekdays",
    normalizedWeekdays.length ? normalizedWeekdays : [1, 2, 3, 4, 5],
  );
  e.record.set(
    "weeklyHours",
    Math.max(0, e.record.getFloat("contractedWeeklyMinutes") / 60),
  );

  e.next();
}, "users");
