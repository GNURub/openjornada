if (($os.getenv("PB_PLATFORM_ENABLED") || "false") === "true") {
  routerAdd(
    "GET",
    "/api/openjornada/platform/v1/summary",
    (e) => {
      const helper = require(`${__hooks}/platform_helpers.js`);
      return e.json(200, helper.summary(e.app, e.auth));
    },
    $apis.requireAuth("platform_operators"),
  );

  routerAdd(
    "GET",
    "/api/openjornada/platform/v1/organizations",
    (e) => {
      const helper = require(`${__hooks}/platform_helpers.js`);
      return e.json(
        200,
        helper.listOrganizations(e.app, e.auth, e.requestInfo().query),
      );
    },
    $apis.requireAuth("platform_operators"),
  );

  routerAdd(
    "GET",
    "/api/openjornada/platform/v1/organizations/{organization}",
    (e) => {
      const helper = require(`${__hooks}/platform_helpers.js`);
      helper.requireOperator(e.auth, false);
      const organization = e.app.findRecordById(
        "organizations",
        e.request.pathValue("organization"),
      );
      return e.json(200, helper.organizationView(e.app, organization));
    },
    $apis.requireAuth("platform_operators"),
  );

  routerAdd(
    "POST",
    "/api/openjornada/platform/v1/organizations",
    (e) => {
      const helper = require(`${__hooks}/platform_helpers.js`);
      const invitation = require(`${__hooks}/invitations_helpers.js`);
      const body = new DynamicModel({
        name: "",
        taxId: "",
        timezone: "",
        privacyContact: "",
        ownerName: "",
        ownerEmail: "",
        declaredHeadcount: 0,
        planCode: "",
        idempotencyKey: "",
      });
      e.bindBody(body);
      const created = helper.createOrganization(e.app, e.auth, e, body);
      if (!created.replay) {
        const key = helper.readIdempotencyKey(e, body);
        try {
          invitation.issuePlatformInvitation(
            e.app,
            e.auth,
            created.result.ownerId,
          );
          created.result.invitationSent = true;
          helper.updateIdempotencyResult(e.app, e.auth, key, created.result);
          helper.audit(
            e.app,
            e.auth,
            "organization.owner_invited",
            "user",
            created.result.ownerId,
            created.result.organizationId,
            "Invitación inicial enviada durante el alta.",
            key,
            {},
          );
        } catch (_) {
          created.result.invitationSent = false;
        }
      }
      return e.json(created.replay ? 200 : 201, created.result);
    },
    $apis.requireAuth("platform_operators"),
  );

  routerAdd(
    "POST",
    "/api/openjornada/platform/v1/organizations/{organization}/owner-invitation",
    (e) => {
      const helper = require(`${__hooks}/platform_helpers.js`);
      const invitation = require(`${__hooks}/invitations_helpers.js`);
      helper.requireOperator(e.auth, true);
      const organizationId = e.request.pathValue("organization");
      e.app.findRecordById("organizations", organizationId);
      const owners = e.app.findRecordsByFilter(
        "users",
        "organization = {:organization} && role = 'admin' && active = true",
        "created",
        2,
        0,
        { organization: organizationId },
      );
      if (owners.length !== 1) {
        throw new BadRequestError(
          "La empresa debe tener exactamente una persona administradora activa para reenviar la invitación.",
        );
      }
      const result = invitation.issuePlatformInvitation(
        e.app,
        e.auth,
        owners[0].id,
      );
      helper.audit(
        e.app,
        e.auth,
        "organization.owner_invited",
        "user",
        owners[0].id,
        organizationId,
        "Invitación reenviada desde el área de proveedor.",
        "",
        {},
      );
      return e.json(200, result);
    },
    $apis.requireAuth("platform_operators"),
  );

  routerAdd(
    "PATCH",
    "/api/openjornada/platform/v1/organizations/{organization}/access",
    (e) => {
      const helper = require(`${__hooks}/platform_helpers.js`);
      const body = new DynamicModel({ accessStatus: "", reason: "" });
      e.bindBody(body);
      return e.json(
        200,
        helper.updateAccess(
          e.app,
          e.auth,
          e.request.pathValue("organization"),
          body,
        ),
      );
    },
    $apis.requireAuth("platform_operators"),
  );

  routerAdd(
    "GET",
    "/api/openjornada/platform/v1/audit",
    (e) => {
      const helper = require(`${__hooks}/platform_helpers.js`);
      return e.json(
        200,
        helper.listAudit(e.app, e.auth, e.requestInfo().query),
      );
    },
    $apis.requireAuth("platform_operators"),
  );
}

cronAdd("openjornada-saas-lifecycle", "*/15 * * * *", () => {
  require(`${__hooks}/platform_helpers.js`).reconcileLifecycle($app);
});
