function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function publicURL(app, token) {
  return (
    app.settings().meta.appURL.replace(/\/+$/, "") + "/invitacion/" + token
  );
}

function audit(app, invitation, action, actor) {
  const record = new Record(app.findCollectionByNameOrId("audit_logs"));
  record.set("organization", invitation.getString("organization"));
  record.set("actor", actor);
  record.set("action", action);
  record.set("entityType", "user_invitation");
  record.set("entityId", invitation.id);
  record.set("metadata", {
    user: invitation.getString("user"),
    expiresAt: invitation.getString("expiresAt"),
  });
  record.set("occurredAt", new Date().toISOString());
  app.save(record);
}

function pendingInvitation(app, rawToken) {
  const token = String(rawToken || "");
  if (!/^[A-Za-z0-9]{64}$/.test(token)) {
    throw new BadRequestError(
      "La invitación no es válida, ha caducado o ya se ha utilizado.",
    );
  }

  let invitation;
  try {
    invitation = app.findFirstRecordByFilter(
      "user_invitations",
      "tokenHash = {:tokenHash} && status = 'pending'",
      { tokenHash: $security.sha256(token) },
    );
  } catch (_) {
    throw new BadRequestError(
      "La invitación no es válida, ha caducado o ya se ha utilizado.",
    );
  }

  if (new Date(invitation.getString("expiresAt")).getTime() <= Date.now()) {
    throw new BadRequestError(
      "La invitación no es válida, ha caducado o ya se ha utilizado.",
    );
  }
  return invitation;
}

function issueInvitation(app, actor, userId) {
  const actorRole = actor.getString("role");
  if (actorRole !== "admin" && actorRole !== "manager") {
    throw new ForbiddenError("No tienes permisos para enviar invitaciones.");
  }
  if (!app.settings().smtp.enabled) {
    throw new BadRequestError(
      "El correo SMTP no está configurado. Revisa la configuración antes de enviar la invitación.",
    );
  }

  const user = app.findRecordById("users", userId);
  if (
    user.getString("organization") !== actor.getString("organization") ||
    (actorRole === "manager" && user.getString("role") !== "employee")
  ) {
    throw new ForbiddenError("No puedes invitar a esta persona.");
  }
  if (!user.email()) {
    throw new BadRequestError("La persona no tiene un correo válido.");
  }

  const token = $security.randomString(64);
  const sentAt = new Date();
  const expiresAt = new Date(sentAt.getTime() + 72 * 60 * 60 * 1000);
  const invitation = new Record(
    app.findCollectionByNameOrId("user_invitations"),
  );
  invitation.set("organization", user.getString("organization"));
  invitation.set("user", user.id);
  invitation.set("email", user.email());
  invitation.set("tokenHash", $security.sha256(token));
  invitation.set("status", "pending");
  invitation.set("sentAt", sentAt.toISOString());
  invitation.set("expiresAt", expiresAt.toISOString());
  invitation.set("invitedBy", actor.id);
  app.save(invitation);

  const link = publicURL(app, token);
  const appName = app.settings().meta.appName;
  const name = user.getString("name");
  try {
    app.newMailClient().send(
      new MailerMessage({
        from: {
          address: app.settings().meta.senderAddress,
          name: app.settings().meta.senderName,
        },
        to: [{ address: user.email(), name }],
        subject: "Tu invitación a " + appName,
        text:
          "Hola " +
          name +
          ". Tu empresa te ha invitado a " +
          appName +
          ". Crea tu contraseña en " +
          link +
          ". El enlace caduca en 72 horas y sólo puede utilizarse una vez.",
        html:
          "<p>Hola " +
          htmlEscape(name) +
          ",</p><p>Tu empresa te ha invitado a " +
          htmlEscape(appName) +
          '.</p><p><a class="btn" href="' +
          htmlEscape(link) +
          '" target="_blank" rel="noopener">Crear mi contraseña</a></p>' +
          "<p>El enlace caduca en 72 horas y sólo puede utilizarse una vez.</p>" +
          "<p>Si no esperabas esta invitación, puedes ignorar el mensaje.</p>",
      }),
    );
  } catch (_) {
    try {
      app.delete(invitation);
    } catch (_) {
      invitation.set("status", "revoked");
      app.save(invitation);
    }
    throw new BadRequestError(
      "No se pudo enviar la invitación. Revisa la configuración SMTP e inténtalo de nuevo.",
    );
  }

  let previous;
  try {
    previous = app.findRecordsByFilter(
      "user_invitations",
      "user = {:targetUser} && status = 'pending'",
      "-sentAt",
      100,
      0,
      { targetUser: user.id },
    );
  } catch (_) {
    throw new BadRequestError(
      "La invitación se envió, pero no se pudo revisar su estado anterior.",
    );
  }
  for (const item of previous) {
    if (item.id === invitation.id) continue;
    item.set("status", "revoked");
    app.save(item);
  }

  user.set("invitationStatus", "pending");
  user.set("invitationSentAt", sentAt.toISOString());
  user.set("invitationExpiresAt", expiresAt.toISOString());
  user.set("invitationAcceptedAt", "");
  try {
    app.save(user);
  } catch (_) {
    throw new BadRequestError(
      "La invitación se envió, pero no se pudo actualizar el estado de la persona.",
    );
  }
  try {
    audit(app, invitation, "user_invitation.sent", actor.id);
  } catch (_) {
    throw new BadRequestError(
      "La invitación se envió, pero no se pudo crear su auditoría.",
    );
  }

  return {
    userId: user.id,
    status: "pending",
    sentAt: sentAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function invitationDetails(app, token) {
  const invitation = pendingInvitation(app, token);
  const user = app.findRecordById("users", invitation.getString("user"));
  if (
    user.email() !== invitation.getString("email") ||
    !user.getBool("active")
  ) {
    throw new BadRequestError(
      "La invitación no es válida, ha caducado o ya se ha utilizado.",
    );
  }
  const organization = app.findRecordById(
    "organizations",
    invitation.getString("organization"),
  );
  return {
    name: user.getString("name"),
    email: user.email(),
    organization: organization.getString("name"),
    expiresAt: invitation.getString("expiresAt"),
  };
}

function acceptInvitation(app, token, passwordValue, confirmationValue) {
  const password = String(passwordValue || "");
  const passwordConfirm = String(confirmationValue || "");
  if (password.length < 10 || password !== passwordConfirm) {
    throw new BadRequestError(
      "La contraseña debe tener al menos 10 caracteres y coincidir.",
    );
  }

  const invitation = pendingInvitation(app, token);
  app.runInTransaction((txApp) => {
    const currentInvitation = txApp.findRecordById(
      "user_invitations",
      invitation.id,
    );
    if (
      currentInvitation.getString("status") !== "pending" ||
      new Date(currentInvitation.getString("expiresAt")).getTime() <= Date.now()
    ) {
      throw new BadRequestError(
        "La invitación no es válida, ha caducado o ya se ha utilizado.",
      );
    }

    const user = txApp.findRecordById(
      "users",
      currentInvitation.getString("user"),
    );
    if (
      user.email() !== currentInvitation.getString("email") ||
      !user.getBool("active")
    ) {
      throw new BadRequestError(
        "La invitación no es válida, ha caducado o ya se ha utilizado.",
      );
    }

    const acceptedAt = new Date().toISOString();
    user.set("password", password);
    user.set("passwordConfirm", passwordConfirm);
    user.set("verified", true);
    user.set("invitationStatus", "accepted");
    user.set("invitationAcceptedAt", acceptedAt);
    txApp.save(user);

    currentInvitation.set("status", "accepted");
    currentInvitation.set("acceptedAt", acceptedAt);
    txApp.save(currentInvitation);

    const pending = txApp.findRecordsByFilter(
      "user_invitations",
      "user = {:targetUser} && status = 'pending'",
      "-sentAt",
      100,
      0,
      { targetUser: user.id },
    );
    for (const item of pending) {
      item.set("status", "revoked");
      txApp.save(item);
    }
    audit(txApp, currentInvitation, "user_invitation.accepted", user.id);
  });

  return { userId: invitation.getString("user") };
}

module.exports = {
  acceptInvitation,
  invitationDetails,
  issueInvitation,
};
