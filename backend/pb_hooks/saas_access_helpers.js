function tenantAccessStatus(app, auth) {
  if (!auth || auth.collection().name !== "users") return null;
  const organizationId = auth.getString("organization");
  if (!organizationId) return null;
  try {
    const organization = app.findRecordById("organizations", organizationId);
    return organization.getString("accessStatus") || "active";
  } catch (_) {
    return "suspended";
  }
}

function enforce(event) {
  if (($os.getenv("PB_SAAS_ENFORCEMENT") || "false") !== "true") {
    return event.next();
  }
  const status = tenantAccessStatus(event.app, event.auth);
  if (
    !status ||
    status === "active" ||
    status === "trialing" ||
    status === "grace"
  ) {
    return event.next();
  }

  let path = "";
  let method = "";
  try {
    path = event.request.url.path;
    method = event.request.method;
  } catch (_) {}
  const role = event.auth.getString("role");
  const isRead = method === "GET" || method === "HEAD" || method === "OPTIONS";
  const isBilling = path.indexOf("/api/openjornada/billing/") === 0;
  const isReadSessionMaintenance =
    path === "/api/collections/users/auth-refresh" ||
    path === "/api/files/token";

  if (
    status === "read_only" &&
    role === "admin" &&
    (isRead || isBilling || isReadSessionMaintenance)
  ) {
    return event.next();
  }
  if (status === "read_only") {
    throw new ForbiddenError(
      "La empresa está en modo de sólo lectura. La administración puede consultar y exportar los datos.",
    );
  }
  throw new ForbiddenError(
    "El acceso de esta empresa está suspendido. Contacta con la administración del servicio.",
  );
}

module.exports = { enforce, tenantAccessStatus };
