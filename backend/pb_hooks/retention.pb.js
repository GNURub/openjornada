routerAdd(
  "POST",
  "/api/openjornada/legal-holds",
  (e) => {
    if (e.auth.getString("role") !== "admin") {
      throw new ForbiddenError(
        "Sólo una persona administradora puede crear preservaciones.",
      )
    }
    const body = e.requestInfo().body
    const reason = String(body.reason || "").trim()
    const from = String(body.from || "")
    const to = String(body.to || "")
    const datePattern = /^\d{4}-\d{2}-\d{2}$/
    if (reason.length < 8 || reason.length > 500) {
      throw new BadRequestError(
        "El motivo de preservación debe tener entre 8 y 500 caracteres.",
      )
    }
    if (
      (from && !datePattern.test(from)) ||
      (to && !datePattern.test(to)) ||
      (from && to && from > to)
    ) {
      throw new BadRequestError("El intervalo de preservación no es válido.")
    }

    const organizationId = e.auth.getString("organization")
    const organization = e.app.findRecordById(
      "organizations",
      organizationId,
    )
    const timezone =
      organization.getString("timezone") || "Europe/Madrid"
    const employeeId = String(body.employee || "")
    if (employeeId) {
      const employee = e.app.findRecordById("users", employeeId)
      if (employee.getString("organization") !== organizationId) {
        throw new ForbiddenError(
          "La persona no pertenece a tu empresa.",
        )
      }
    }

    const hold = new Record(
      e.app.findCollectionByNameOrId("legal_holds"),
    )
    hold.set("organization", organizationId)
    hold.set("employee", employeeId)
    hold.set("reason", reason)
    hold.set(
      "fromDate",
      from ? new DateTime(from + " 00:00:00", timezone).string() : "",
    )
    hold.set(
      "toDate",
      to ? new DateTime(to + " 23:59:59", timezone).string() : "",
    )
    hold.set("active", true)
    hold.set("createdBy", e.auth.id)
    e.app.save(hold)

    const audit = new Record(
      e.app.findCollectionByNameOrId("audit_logs"),
    )
    audit.set("organization", organizationId)
    audit.set("actor", e.auth.id)
    audit.set("action", "legal_hold.created")
    audit.set("entityType", "legal_hold")
    audit.set("entityId", hold.id)
    audit.set("metadata", { employee: employeeId, from, to })
    audit.set("occurredAt", new Date().toISOString())
    e.app.save(audit)

    return e.json(201, hold.publicExport())
  },
  $apis.requireAuth("users"),
)

routerAdd(
  "POST",
  "/api/openjornada/legal-holds/{id}/release",
  (e) => {
    if (e.auth.getString("role") !== "admin") {
      throw new ForbiddenError(
        "Sólo una persona administradora puede liberar preservaciones.",
      )
    }
    const hold = e.app.findRecordById(
      "legal_holds",
      e.request.pathValue("id"),
    )
    if (
      hold.getString("organization") !==
      e.auth.getString("organization")
    ) {
      throw new ForbiddenError(
        "La preservación no pertenece a tu empresa.",
      )
    }
    if (!hold.getBool("active")) {
      return e.json(200, hold.publicExport())
    }
    const releasedAt = new Date().toISOString()
    hold.set("active", false)
    hold.set("releasedBy", e.auth.id)
    hold.set("releasedAt", releasedAt)
    e.app.save(hold)

    const audit = new Record(
      e.app.findCollectionByNameOrId("audit_logs"),
    )
    audit.set("organization", hold.getString("organization"))
    audit.set("actor", e.auth.id)
    audit.set("action", "legal_hold.released")
    audit.set("entityType", "legal_hold")
    audit.set("entityId", hold.id)
    audit.set("metadata", {
      employee: hold.getString("employee"),
      releasedAt,
    })
    audit.set("occurredAt", releasedAt)
    e.app.save(audit)
    return e.json(200, hold.publicExport())
  },
  $apis.requireAuth("users"),
)

routerAdd(
  "GET",
  "/api/openjornada/retention-preview",
  (e) => {
    if (e.auth.getString("role") !== "admin") {
      throw new ForbiddenError(
        "Sólo una persona administradora puede revisar la retención.",
      )
    }
    const organizationId = e.auth.getString("organization")
    const organization = e.app.findRecordById(
      "organizations",
      organizationId,
    )
    const retentionYears = Math.max(
      4,
      Math.round(organization.getFloat("retentionYears") || 4),
    )
    const cutoff = new DateTime().addDate(-retentionYears, 0, 0)
    const records = e.app.findRecordsByFilter(
      "work_events",
      "organization = {:organization} && occurredAt < {:cutoff}",
      "occurredAt",
      50000,
      0,
      { organization: organizationId, cutoff: cutoff.string() },
    )
    const holds = e.app.findRecordsByFilter(
      "legal_holds",
      "organization = {:organization} && active = true",
      "created",
      1000,
      0,
      { organization: organizationId },
    )
    let held = 0
    for (const record of records) {
      const occurred = new DateTime(record.getString("occurredAt")).unix()
      const protectedByHold = holds.some((hold) => {
        const employee = hold.getString("employee")
        if (employee && employee !== record.getString("employee")) {
          return false
        }
        const rawFrom = hold.getString("fromDate")
        const rawTo = hold.getString("toDate")
        return (
          (!rawFrom || occurred >= new DateTime(rawFrom).unix()) &&
          (!rawTo || occurred <= new DateTime(rawTo).unix())
        )
      })
      if (protectedByHold) held += 1
    }
    return e.json(200, {
      retentionYears,
      cutoff: cutoff.string(),
      activeLegalHolds: holds.length,
      recordsPastRetention: records.length,
      protectedByLegalHold: held,
      eligibleForFuturePurge: records.length - held,
      destructiveActionExecuted: false,
    })
  },
  $apis.requireAuth("users"),
)
