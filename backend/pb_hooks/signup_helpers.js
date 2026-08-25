function text(value, max) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function validate(body) {
  const input = {
    organizationName: text(body.organizationName, 160),
    taxId: text(body.taxId, 24).toUpperCase(),
    timezone: text(body.timezone, 64) || "Europe/Madrid",
    ownerName: text(body.ownerName, 160),
    ownerEmail: text(body.ownerEmail, 254).toLowerCase(),
    declaredHeadcount: Math.round(Number(body.declaredHeadcount || 1)),
    planCode: text(body.planCode, 40),
    idempotencyKey: text(body.idempotencyKey, 80),
  };
  if (
    !input.organizationName ||
    !input.taxId ||
    !input.ownerName ||
    !/^\S+@\S+\.\S+$/.test(input.ownerEmail)
  ) {
    throw new BadRequestError(
      "Completa los datos de empresa y de la persona responsable.",
    );
  }
  if (
    !/^[A-Za-z_]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(
      input.timezone,
    )
  ) {
    throw new BadRequestError("La zona horaria no es válida.");
  }
  if (input.declaredHeadcount < 1 || input.declaredHeadcount > 100000) {
    throw new BadRequestError("La plantilla declarada no es válida.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,79}$/.test(input.idempotencyKey)) {
    throw new BadRequestError(
      "La solicitud no incluye una clave de idempotencia válida.",
    );
  }
  return input;
}

function plans(app) {
  return app
    .findRecordsByFilter(
      "saas_plans",
      "active = true && code != 'managed-manual'",
      "headcountLimit",
      100,
      0,
    )
    .map((plan) => ({
      code: plan.getString("code"),
      name: plan.getString("name"),
      billingModel: plan.getString("billingModel"),
      headcountLimit: plan.getFloat("headcountLimit"),
    }));
}

function signup(app, body) {
  if (!app.settings().smtp.enabled) {
    throw new BadRequestError(
      "El alta está temporalmente deshabilitada porque el correo no está disponible.",
    );
  }
  const input = validate(body);
  const scope = "signup:" + $security.sha256(input.ownerEmail);
  try {
    const previous = app.findFirstRecordByFilter(
      "platform_idempotency",
      "scope = {:scope} && key = {:key}",
      { scope, key: input.idempotencyKey },
    );
    if (new Date(previous.getString("expiresAt")).getTime() > Date.now()) {
      return previous.get("result");
    }
  } catch (_) {}

  let duplicate = null;
  try {
    duplicate = app.findFirstRecordByData(
      "organizations",
      "taxId",
      input.taxId,
    );
  } catch (_) {}
  if (duplicate)
    throw new BadRequestError("Ya existe una empresa con ese NIF/CIF.");
  try {
    duplicate = app.findAuthRecordByEmail("users", input.ownerEmail);
  } catch (_) {
    duplicate = null;
  }
  if (duplicate)
    throw new BadRequestError("Ya existe una cuenta con ese correo.");

  let result = null;
  app.runInTransaction((txApp) => {
    const plan = txApp.findFirstRecordByData(
      "saas_plans",
      "code",
      input.planCode,
    );
    if (
      !plan.getBool("active") ||
      plan.getString("code") === "managed-manual"
    ) {
      throw new BadRequestError("El plan seleccionado no está disponible.");
    }
    const limit = plan.getFloat("headcountLimit");
    if (limit > 0 && input.declaredHeadcount > limit) {
      throw new BadRequestError(
        "La plantilla declarada supera el límite del plan.",
      );
    }

    const organization = new Record(
      txApp.findCollectionByNameOrId("organizations"),
    );
    organization.set("name", input.organizationName);
    organization.set("taxId", input.taxId);
    organization.set("timezone", input.timezone);
    organization.set("retentionYears", 4);
    organization.set("privacyContact", input.ownerEmail);
    organization.set("privacyNoticeVersion", "2026-07-30");
    organization.set("brandPrimaryColor", "#ef4d32");
    organization.set("brandSecondaryColor", "#1c1917");
    organization.set("pwaName", input.organizationName);
    organization.set("pwaShortName", input.organizationName.slice(0, 20));
    organization.set("manualTimeApprovalRequired", false);
    organization.set("timeCorrectionApprovalRequired", true);
    organization.set("accessStatus", "trialing");
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
    owner.set("invitationStatus", "");
    owner.set("privacyNoticeAcknowledgedVersion", "");
    owner.set("privacyNoticeAcknowledgedAt", "");
    txApp.save(owner);

    const subscription = new Record(
      txApp.findCollectionByNameOrId("organization_subscriptions"),
    );
    subscription.set("organization", organization.id);
    subscription.set("plan", plan.id);
    subscription.set("billingStatus", "trialing");
    subscription.set("declaredHeadcount", input.declaredHeadcount);
    txApp.save(subscription);

    result = {
      organizationId: organization.id,
      ownerId: owner.id,
      invitationSent: false,
      trialStartsAfterVerification: true,
    };
    const idempotency = new Record(
      txApp.findCollectionByNameOrId("platform_idempotency"),
    );
    idempotency.set("scope", scope);
    idempotency.set("key", input.idempotencyKey);
    idempotency.set("result", result);
    idempotency.set(
      "expiresAt",
      new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    );
    txApp.save(idempotency);
  });

  try {
    require(`${__hooks}/invitations_helpers.js`).issueSignupInvitation(
      app,
      result.ownerId,
    );
    result.invitationSent = true;
    const stored = app.findFirstRecordByFilter(
      "platform_idempotency",
      "scope = {:scope} && key = {:key}",
      { scope, key: input.idempotencyKey },
    );
    stored.set("result", result);
    app.save(stored);
  } catch (_) {}
  return result;
}

module.exports = { plans, signup };
