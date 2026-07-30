function ojPrivacyNotice(organization, user) {
  const version =
    organization.getString("privacyNoticeVersion") || "2026-07-30";
  const retentionYears = Math.max(
    4,
    Math.round(organization.getFloat("retentionYears") || 4),
  );
  return {
    version,
    acknowledged:
      user.getString("privacyNoticeAcknowledgedVersion") === version &&
      Boolean(user.getString("privacyNoticeAcknowledgedAt")),
    acknowledgedAt: user.getString("privacyNoticeAcknowledgedAt"),
    responsible: organization.getString("name"),
    taxId: organization.getString("taxId"),
    privacyContact: organization.getString("privacyContact"),
    retentionYears,
    purpose:
      "Gestionar y acreditar el registro diario de jornada, sus pausas, correcciones y resúmenes.",
    legalBasis:
      "Cumplimiento de la obligación legal prevista en el artículo 34.9 del Estatuto de los Trabajadores.",
    recipients:
      "La persona trabajadora, su representación legal y las autoridades competentes cuando proceda.",
    rights:
      "Puedes solicitar acceso, rectificación y los demás derechos aplicables mediante el contacto de privacidad. También puedes reclamar ante la Agencia Española de Protección de Datos.",
  };
}

routerAdd(
  "GET",
  "/api/openjornada/privacy-notice",
  (e) => {
    const organization = e.app.findRecordById(
      "organizations",
      e.auth.getString("organization"),
    );
    return e.json(200, ojPrivacyNotice(organization, e.auth));
  },
  $apis.requireAuth("users"),
);

routerAdd(
  "POST",
  "/api/openjornada/privacy-notice/acknowledge",
  (e) => {
    const organization = e.app.findRecordById(
      "organizations",
      e.auth.getString("organization"),
    );
    const notice = ojPrivacyNotice(organization, e.auth);
    const acknowledgedAt = new Date().toISOString();
    e.auth.set("privacyNoticeAcknowledgedVersion", notice.version);
    e.auth.set("privacyNoticeAcknowledgedAt", acknowledgedAt);
    e.app.save(e.auth);

    const audit = new Record(e.app.findCollectionByNameOrId("audit_logs"));
    audit.set("organization", organization.id);
    audit.set("actor", e.auth.id);
    audit.set("action", "privacy_notice.acknowledged");
    audit.set("entityType", "user");
    audit.set("entityId", e.auth.id);
    audit.set("metadata", { version: notice.version });
    audit.set("occurredAt", acknowledgedAt);
    e.app.save(audit);

    return e.json(200, {
      version: notice.version,
      acknowledgedAt,
    });
  },
  $apis.requireAuth("users"),
);
