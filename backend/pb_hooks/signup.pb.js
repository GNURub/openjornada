if (($os.getenv("PB_SELF_SIGNUP_ENABLED") || "false") === "true") {
  routerAdd("GET", "/api/openjornada/public/plans", (e) => {
    return e.json(200, require(`${__hooks}/signup_helpers.js`).plans(e.app));
  });

  routerAdd("POST", "/api/openjornada/signup", (e) => {
    const body = new DynamicModel({
      organizationName: "",
      taxId: "",
      timezone: "",
      ownerName: "",
      ownerEmail: "",
      declaredHeadcount: 0,
      planCode: "",
      idempotencyKey: "",
    });
    e.bindBody(body);
    const result = require(`${__hooks}/signup_helpers.js`).signup(e.app, body);
    return e.json(201, {
      invitationSent: result.invitationSent,
      trialStartsAfterVerification: true,
    });
  });
}
