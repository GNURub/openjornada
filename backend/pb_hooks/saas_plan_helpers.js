function planContext(app, organizationId) {
  try {
    const subscription = app.findFirstRecordByFilter(
      "organization_subscriptions",
      "organization = {:organization}",
      { organization: organizationId },
    );
    const plan = app.findRecordById(
      "saas_plans",
      subscription.getString("plan"),
    );
    return { subscription, plan };
  } catch (_) {
    return null;
  }
}

function activeUsers(app, organizationId) {
  return app.findRecordsByFilter(
    "users",
    "organization = {:organization} && active = true",
    "id",
    100000,
    0,
    { organization: organizationId },
  ).length;
}

function ensureCapacity(app, organizationId, additional) {
  const context = planContext(app, organizationId);
  if (!context) return;
  const limit = context.plan.getFloat("headcountLimit");
  if (limit > 0 && activeUsers(app, organizationId) + additional > limit) {
    throw new BadRequestError(
      "La empresa ha alcanzado el límite de personas activas de su plan.",
    );
  }
}

function raiseDeclaredHeadcount(app, organizationId) {
  const context = planContext(app, organizationId);
  if (!context) return;
  const count = Math.max(1, activeUsers(app, organizationId));
  if (count > context.subscription.getFloat("declaredHeadcount")) {
    context.subscription.set("declaredHeadcount", count);
    app.save(context.subscription);
  }
}

module.exports = { ensureCapacity, raiseDeclaredHeadcount };
