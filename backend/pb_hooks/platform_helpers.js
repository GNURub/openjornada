const ACCESS_STATUSES = [
  "trialing",
  "active",
  "grace",
  "read_only",
  "suspended",
];

function cleanText(value, max) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function requireOperator(operator, write) {
  if (!operator || operator.collection().name !== "platform_operators") {
    throw new UnauthorizedError(
      "Debes iniciar sesión en el área de proveedor.",
    );
  }
  if (!operator.getBool("active")) {
    throw new ForbiddenError("Este acceso de proveedor está desactivado.");
  }
  const role = operator.getString("role");
  if (role !== "admin" && role !== "support") {
    throw new ForbiddenError("El rol de proveedor no es válido.");
  }
  if (write && role !== "admin") {
    throw new ForbiddenError("El rol de soporte sólo dispone de lectura.");
  }
  return operator;
}

function audit(
  app,
  operator,
  action,
  entityType,
  entityId,
  organization,
  reason,
  requestId,
  metadata,
) {
  const record = new Record(
    app.findCollectionByNameOrId("platform_audit_logs"),
  );
  record.set("operator", operator ? operator.id : "");
  record.set("organization", organization || "");
  record.set("action", action);
  record.set("entityType", entityType);
  record.set("entityId", entityId || "");
  record.set("reason", cleanText(reason, 500));
  record.set("requestId", cleanText(requestId, 80));
  record.set("metadata", metadata || {});
  record.set("occurredAt", new Date().toISOString());
  app.save(record);
}

function findSubscription(app, organizationId) {
  try {
    return app.findFirstRecordByFilter(
      "organization_subscriptions",
      "organization = {:organization}",
      { organization: organizationId },
    );
  } catch (_) {
    return null;
  }
}

function countRecords(app, collection, filter, params) {
  return app.findRecordsByFilter(
    collection,
    filter || "id != ''",
    "id",
    10000,
    0,
    params || {},
  ).length;
}

function organizationView(app, organization) {
  const subscription = findSubscription(app, organization.id);
  let planCode = "";
  let planName = "";
  if (subscription && subscription.getString("plan")) {
    try {
      const plan = app.findRecordById(
        "saas_plans",
        subscription.getString("plan"),
      );
      planCode = plan.getString("code");
      planName = plan.getString("name");
    } catch (_) {}
  }
  return {
    id: organization.id,
    name: organization.getString("name"),
    taxId: organization.getString("taxId"),
    timezone: organization.getString("timezone"),
    accessStatus: organization.getString("accessStatus") || "active",
    accessOverride: organization.getString("accessOverride"),
    billingStatus: subscription ? subscription.getString("billingStatus") : "",
    planCode,
    planName,
    declaredHeadcount: subscription
      ? subscription.getFloat("declaredHeadcount")
      : 0,
    activeUsers: countRecords(
      app,
      "users",
      "organization = {:organization} && active = true",
      { organization: organization.id },
    ),
    totalUsers: countRecords(app, "users", "organization = {:organization}", {
      organization: organization.id,
    }),
    created: organization.getString("created"),
    trialEndsAt: subscription ? subscription.getString("trialEndsAt") : "",
    graceEndsAt: subscription ? subscription.getString("graceEndsAt") : "",
    readOnlyUntil: subscription ? subscription.getString("readOnlyUntil") : "",
  };
}

function summary(app, operator) {
  requireOperator(operator, false);
  const organizations = app.findRecordsByFilter(
    "organizations",
    "id != ''",
    "id",
    1000,
    0,
  );
  const byStatus = {};
  for (const status of ACCESS_STATUSES) byStatus[status] = 0;
  let activeUsers = 0;
  for (const organization of organizations) {
    const status = organization.getString("accessStatus") || "active";
    byStatus[status] = (byStatus[status] || 0) + 1;
    activeUsers += countRecords(
      app,
      "users",
      "organization = {:organization} && active = true",
      { organization: organization.id },
    );
  }
  return { organizations: organizations.length, activeUsers, byStatus };
}

function listOrganizations(app, operator, query) {
  requireOperator(operator, false);
  const search = cleanText(query && query.search, 120);
  const status = cleanText(query && query.status, 20);
  const params = {};
  const clauses = ["id != ''"];
  if (search) {
    clauses.push("(name ~ {:search} || taxId ~ {:search})");
    params.search = search;
  }
  if (status) {
    if (ACCESS_STATUSES.indexOf(status) === -1) {
      throw new BadRequestError("El estado de acceso no es válido.");
    }
    clauses.push("accessStatus = {:status}");
    params.status = status;
  }
  return app
    .findRecordsByFilter(
      "organizations",
      clauses.join(" && "),
      "name",
      1000,
      0,
      params,
    )
    .map((organization) => organizationView(app, organization));
}

function readIdempotencyKey(event, body) {
  let value = "";
  try {
    value = event.request.header.get("Idempotency-Key");
  } catch (_) {}
  if (!value) value = body.idempotencyKey;
  const key = cleanText(value, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,79}$/.test(key)) {
    throw new BadRequestError(
      "Idempotency-Key debe tener entre 16 y 80 caracteres seguros.",
    );
  }
  return key;
}

function validateProvisionBody(body) {
  const input = {
    name: cleanText(body.name, 160),
    taxId: cleanText(body.taxId, 24).toUpperCase(),
    timezone: cleanText(body.timezone, 64) || "Europe/Madrid",
    privacyContact: cleanText(
      body.privacyContact || body.ownerEmail,
      254,
    ).toLowerCase(),
    ownerName: cleanText(body.ownerName, 160),
    ownerEmail: cleanText(body.ownerEmail, 254).toLowerCase(),
    declaredHeadcount: Math.round(Number(body.declaredHeadcount || 1)),
    planCode: cleanText(body.planCode, 40) || "managed-manual",
  };
  if (
    !input.name ||
    !input.taxId ||
    !input.ownerName ||
    !/^\S+@\S+\.\S+$/.test(input.ownerEmail)
  ) {
    throw new BadRequestError(
      "Nombre, NIF/CIF, responsable y correo son obligatorios.",
    );
  }
  if (!/^\S+@\S+\.\S+$/.test(input.privacyContact)) {
    throw new BadRequestError("El contacto de privacidad no es válido.");
  }
  if (
    !/^[A-Za-z_]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(
      input.timezone,
    )
  ) {
    throw new BadRequestError(
      "La zona horaria debe ser un identificador IANA válido.",
    );
  }
  if (input.declaredHeadcount < 1 || input.declaredHeadcount > 100000) {
    throw new BadRequestError(
      "La plantilla declarada debe estar entre 1 y 100000.",
    );
  }
  return input;
}

function existingIdempotency(app, scope, key) {
  try {
    const record = app.findFirstRecordByFilter(
      "platform_idempotency",
      "scope = {:scope} && key = {:key}",
      { scope, key },
    );
    if (new Date(record.getString("expiresAt")).getTime() > Date.now()) {
      const value = record.get("result");
      if (typeof value === "string") return JSON.parse(value || "{}");
      if (
        Array.isArray(value) &&
        value.every((item) => typeof item === "number")
      ) {
        return JSON.parse(String.fromCharCode.apply(null, value));
      }
      return JSON.parse(JSON.stringify(value || {}));
    }
    app.delete(record);
  } catch (_) {}
  return null;
}

function createOrganization(app, operator, event, body) {
  requireOperator(operator, true);
  const input = validateProvisionBody(body);
  const key = readIdempotencyKey(event, body);
  const scope = "organization.create:" + operator.id;
  const replay = existingIdempotency(app, scope, key);
  if (replay) return { replay: true, result: replay };

  let existingOrganization = null;
  try {
    existingOrganization = app.findFirstRecordByData(
      "organizations",
      "taxId",
      input.taxId,
    );
  } catch (_) {}
  if (existingOrganization) {
    const replayAfterRace = existingIdempotency(app, scope, key);
    if (replayAfterRace) return { replay: true, result: replayAfterRace };
    throw new BadRequestError("Ya existe una empresa con ese NIF/CIF.");
  }
  let existingOwner = null;
  try {
    existingOwner = app.findAuthRecordByEmail("users", input.ownerEmail);
  } catch (_) {}
  if (existingOwner) {
    const replayAfterRace = existingIdempotency(app, scope, key);
    if (replayAfterRace) return { replay: true, result: replayAfterRace };
    throw new BadRequestError(
      "Ese correo ya pertenece a una cuenta existente.",
    );
  }

  let result = null;
  try {
    app.runInTransaction((txApp) => {
      const plan = txApp.findFirstRecordByData(
        "saas_plans",
        "code",
        input.planCode,
      );
      if (!plan.getBool("active")) {
        throw new BadRequestError("El plan seleccionado no está disponible.");
      }

      const organization = new Record(
        txApp.findCollectionByNameOrId("organizations"),
      );
      organization.set("name", input.name);
      organization.set("taxId", input.taxId);
      organization.set("timezone", input.timezone);
      organization.set("retentionYears", 4);
      organization.set("privacyContact", input.privacyContact);
      organization.set("privacyNoticeVersion", "2026-07-30");
      organization.set("brandPrimaryColor", "#ef4d32");
      organization.set("brandSecondaryColor", "#1c1917");
      organization.set("pwaName", input.name);
      organization.set("pwaShortName", input.name.slice(0, 20));
      organization.set("manualTimeApprovalRequired", false);
      organization.set("timeCorrectionApprovalRequired", true);
      organization.set("accessStatus", "active");
      txApp.save(organization);

      const owner = new Record(txApp.findCollectionByNameOrId("users"));
      const temporaryPassword = $security.randomString(48);
      owner.set("email", input.ownerEmail);
      owner.set("password", temporaryPassword);
      owner.set("passwordConfirm", temporaryPassword);
      owner.set("verified", false);
      owner.set("name", input.ownerName);
      owner.set("organization", organization.id);
      owner.set("role", "admin");
      owner.set("active", true);
      owner.set("employeeCode", "ADMIN");
      owner.set("weeklyHours", 40);
      owner.set("employmentType", "full_time");
      owner.set("contractedWeeklyMinutes", 2400);
      owner.set("complementaryHoursAgreement", false);
      owner.set("scheduleMode", "scheduled");
      owner.set("flexibleWeekdays", [1, 2, 3, 4, 5]);
      owner.set("invitationStatus", "pending");
      owner.set("privacyNoticeAcknowledgedVersion", "");
      owner.set("privacyNoticeAcknowledgedAt", "");
      txApp.save(owner);

      const subscription = new Record(
        txApp.findCollectionByNameOrId("organization_subscriptions"),
      );
      subscription.set("organization", organization.id);
      subscription.set("plan", plan.id);
      subscription.set("billingStatus", "manual_active");
      subscription.set("declaredHeadcount", input.declaredHeadcount);
      txApp.save(subscription);

      result = {
        organizationId: organization.id,
        ownerId: owner.id,
        name: input.name,
        accessStatus: "active",
        billingStatus: "manual_active",
        invitationSent: false,
      };

      const idempotency = new Record(
        txApp.findCollectionByNameOrId("platform_idempotency"),
      );
      idempotency.set("operator", operator.id);
      idempotency.set("scope", scope);
      idempotency.set("key", key);
      idempotency.set("result", result);
      idempotency.set(
        "expiresAt",
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      );
      txApp.save(idempotency);

      audit(
        txApp,
        operator,
        "organization.provisioned",
        "organization",
        organization.id,
        organization.id,
        "Alta gestionada desde el área de proveedor.",
        key,
        {
          planCode: input.planCode,
          declaredHeadcount: input.declaredHeadcount,
        },
      );
    });
  } catch (error) {
    const replayAfterRace = existingIdempotency(app, scope, key);
    if (replayAfterRace) return { replay: true, result: replayAfterRace };
    throw error;
  }

  return { replay: false, result };
}

function updateIdempotencyResult(app, operator, key, result) {
  try {
    const record = app.findFirstRecordByFilter(
      "platform_idempotency",
      "scope = {:scope} && key = {:key}",
      { scope: "organization.create:" + operator.id, key },
    );
    record.set("result", result);
    app.save(record);
  } catch (_) {}
}

function updateAccess(app, operator, organizationId, body) {
  requireOperator(operator, true);
  const status = cleanText(body.accessStatus, 20);
  const reason = cleanText(body.reason, 500);
  const automatic = status === "automatic";
  if (!automatic && ACCESS_STATUSES.indexOf(status) === -1) {
    throw new BadRequestError("El estado de acceso no es válido.");
  }
  if (reason.length < 10) {
    throw new BadRequestError("Indica un motivo de al menos 10 caracteres.");
  }
  const organization = app.findRecordById("organizations", organizationId);
  const previous = organization.getString("accessStatus") || "active";
  const previousOverride = organization.getString("accessOverride");
  if (
    (automatic && !previousOverride) ||
    (!automatic && previous === status && previousOverride === status)
  )
    return organizationView(app, organization);
  app.runInTransaction((txApp) => {
    const current = txApp.findRecordById("organizations", organizationId);
    if (!automatic) current.set("accessStatus", status);
    current.set("accessOverride", automatic ? "" : status);
    txApp.save(current);
    audit(
      txApp,
      operator,
      "organization.access_changed",
      "organization",
      organizationId,
      organizationId,
      reason,
      "",
      {
        previous,
        current: automatic ? previous : status,
        previousOverride,
        accessMode: automatic ? "automatic" : "manual",
      },
    );
  });
  if (automatic) reconcileLifecycle(app);
  return organizationView(
    app,
    app.findRecordById("organizations", organizationId),
  );
}

function listAudit(app, operator, query) {
  requireOperator(operator, false);
  const organization = cleanText(query && query.organization, 32);
  const params = {};
  let filter = "id != ''";
  if (organization) {
    filter = "organization = {:organization}";
    params.organization = organization;
  }
  return app
    .findRecordsByFilter(
      "platform_audit_logs",
      filter,
      "-occurredAt",
      200,
      0,
      params,
    )
    .map((record) => ({
      id: record.id,
      operator: record.getString("operator"),
      organization: record.getString("organization"),
      action: record.getString("action"),
      entityType: record.getString("entityType"),
      entityId: record.getString("entityId"),
      reason: record.getString("reason"),
      requestId: record.getString("requestId"),
      metadata: record.get("metadata"),
      occurredAt: record.getString("occurredAt"),
    }));
}

function reconcileLifecycle(app) {
  const subscriptions = app.findRecordsByFilter(
    "organization_subscriptions",
    "billingStatus != 'manual_active'",
    "id",
    1000,
    0,
  );
  const now = Date.now();
  for (const subscription of subscriptions) {
    const organizationId = subscription.getString("organization");
    let organization;
    try {
      organization = app.findRecordById("organizations", organizationId);
    } catch (_) {
      continue;
    }
    if (organization.getString("accessOverride")) continue;
    let next = organization.getString("accessStatus") || "trialing";
    const trial = new Date(subscription.getString("trialEndsAt")).getTime();
    const grace = new Date(subscription.getString("graceEndsAt")).getTime();
    const readOnly = new Date(
      subscription.getString("readOnlyUntil"),
    ).getTime();
    if (subscription.getString("billingStatus") === "active") next = "active";
    else if (Number.isFinite(readOnly) && now > readOnly) next = "suspended";
    else if (Number.isFinite(grace) && now > grace) next = "read_only";
    else if (Number.isFinite(trial) && now > trial) next = "grace";
    else if (subscription.getString("billingStatus") === "trialing")
      next = "trialing";
    if (next !== organization.getString("accessStatus")) {
      const previous = organization.getString("accessStatus");
      organization.set("accessStatus", next);
      app.save(organization);
      audit(
        app,
        null,
        "organization.lifecycle_changed",
        "organization",
        organization.id,
        organization.id,
        "Transición automática del ciclo de suscripción.",
        "",
        { previous, current: next },
      );
    }
  }
}

module.exports = {
  audit,
  createOrganization,
  listAudit,
  listOrganizations,
  organizationView,
  readIdempotencyKey,
  reconcileLifecycle,
  requireOperator,
  summary,
  updateAccess,
  updateIdempotencyResult,
};
