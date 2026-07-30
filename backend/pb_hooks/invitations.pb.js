routerAdd(
  "POST",
  "/api/openjornada/team/{user}/invitation",
  (e) => {
    const helper = require(`${__hooks}/invitations_helpers.js`);
    return e.json(
      201,
      helper.issueInvitation(e.app, e.auth, e.request.pathValue("user")),
    );
  },
  $apis.requireAuth("users"),
);

routerAdd("GET", "/api/openjornada/invitations/{token}", (e) => {
  const helper = require(`${__hooks}/invitations_helpers.js`);
  return e.json(
    200,
    helper.invitationDetails(e.app, e.request.pathValue("token")),
  );
});

routerAdd("POST", "/api/openjornada/invitations/{token}/accept", (e) => {
  const helper = require(`${__hooks}/invitations_helpers.js`);
  const body = new DynamicModel({ password: "", passwordConfirm: "" });
  e.bindBody(body);
  const result = helper.acceptInvitation(
    e.app,
    e.request.pathValue("token"),
    body.password,
    body.passwordConfirm,
  );
  const user = e.app.findRecordById("users", result.userId);
  return $apis.recordAuthResponse(e, user, "invitation");
});
