function ojItemValue(item, key) {
  if (!item) return null;
  return typeof item.get === "function" ? item.get(key) : item[key];
}

function ojTimeMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || "")) return -1;
  const parts = value.split(":");
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (hours > 23 || minutes > 59) return -1;
  return hours * 60 + minutes;
}

function ojLocalKey(value, timezone) {
  return new DateTime(value)
    .time()
    .in(new Timezone(timezone))
    .format("2006-01-02");
}

function ojToday(timezone) {
  return new DateTime()
    .time()
    .in(new Timezone(timezone))
    .format("2006-01-02");
}

function ojNormalizeIntervals(
  app,
  workDate,
  timezone,
  rawIntervals,
  organizationId,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate || "")) {
    throw new BadRequestError("La fecha de la jornada no es válida.");
  }
  const source = Array.from(rawIntervals || []);
  if (source.length === 0 || source.length > 24) {
    throw new BadRequestError("Añade entre uno y veinticuatro tramos.");
  }

  const timezoneLocation = new Timezone(timezone);
  const normalized = [];
  for (const item of source) {
    const kind = String(ojItemValue(item, "kind") || "");
    const start = String(ojItemValue(item, "start") || "");
    const end = String(ojItemValue(item, "end") || "");
    const startNextDay = Boolean(ojItemValue(item, "startNextDay"));
    const startMinutes = ojTimeMinutes(start);
    const endMinutes = ojTimeMinutes(end);
    if (
      (kind !== "work" && kind !== "break") ||
      startMinutes < 0 ||
      endMinutes < 0
    ) {
      throw new BadRequestError("Hay un tramo de jornada no válido.");
    }

    const startOffset = startNextDay ? 1 : 0;
    const endOffset = startOffset + (endMinutes < startMinutes ? 1 : 0);
    if (endOffset > 1) {
      throw new BadRequestError(
        "Un tramo no puede terminar dos días después de la fecha seleccionada.",
      );
    }
    const startAt = new DateTime(
      workDate + " " + start + ":00",
      timezone,
    ).addDate(0, 0, startOffset);
    const endAt = new DateTime(
      workDate + " " + end + ":00",
      timezone,
    ).addDate(0, 0, endOffset);
    const expectedStartDate = new DateTime(
      workDate + " 00:00:00",
      timezone,
    )
      .addDate(0, 0, startOffset)
      .time()
      .in(timezoneLocation)
      .format("2006-01-02");
    const expectedEndDate = new DateTime(
      workDate + " 00:00:00",
      timezone,
    )
      .addDate(0, 0, endOffset)
      .time()
      .in(timezoneLocation)
      .format("2006-01-02");
    if (
      startAt
        .time()
        .in(timezoneLocation)
        .format("2006-01-02 15:04") !==
        expectedStartDate + " " + start ||
      endAt.time().in(timezoneLocation).format("2006-01-02 15:04") !==
        expectedEndDate + " " + end
    ) {
      throw new BadRequestError(
        "Una de las horas no existe en la zona horaria de la empresa.",
      );
    }

    const durationMinutes = Math.round(
      (endAt.unix() - startAt.unix()) / 60,
    );
    if (durationMinutes <= 0 || durationMinutes > 16 * 60) {
      throw new BadRequestError(
        "Cada tramo debe durar más de cero y un máximo de dieciséis horas.",
      );
    }

    let breakTypeId = "";
    let breakTypeName = "";
    let breakPaid = false;
    if (kind === "break") {
      breakTypeId = String(ojItemValue(item, "breakType") || "");
      let breakType;
      try {
        breakType = app.findRecordById("break_types", breakTypeId);
      } catch (_) {
        throw new BadRequestError("Selecciona un tipo de pausa válido.");
      }
      if (
        breakType.getString("organization") !== organizationId ||
        !breakType.getBool("active")
      ) {
        throw new BadRequestError("El tipo de pausa no está disponible.");
      }
      breakTypeName = breakType.getString("name");
      breakPaid = breakType.getBool("paid");
    }

    normalized.push({
      kind,
      start,
      end,
      startNextDay,
      startAt: startAt.string(),
      endAt: endAt.string(),
      startUnix: startAt.unix(),
      endUnix: endAt.unix(),
      breakType: breakTypeId,
      breakTypeName,
      breakPaid,
    });
  }

  normalized.sort((left, right) => left.startUnix - right.startUnix);
  if (
    normalized[0].kind !== "work" ||
    normalized[normalized.length - 1].kind !== "work"
  ) {
    throw new BadRequestError(
      "La jornada debe comenzar y terminar con un tramo de trabajo.",
    );
  }
  let workedMinutes = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const item = normalized[index];
    const previous = normalized[index - 1];
    const next = normalized[index + 1];
    if (previous && item.startUnix < previous.endUnix) {
      throw new BadRequestError("Los tramos de la jornada se solapan.");
    }
    if (item.kind === "work") workedMinutes += (item.endUnix - item.startUnix) / 60;
    if (
      item.kind === "break" &&
      (!previous ||
        !next ||
        previous.kind !== "work" ||
        next.kind !== "work" ||
        previous.endUnix !== item.startUnix ||
        item.endUnix !== next.startUnix)
    ) {
      throw new BadRequestError(
        "Cada pausa debe estar unida a los tramos de trabajo anterior y posterior.",
      );
    }
  }
  if (workedMinutes > 24 * 60) {
    throw new BadRequestError(
      "La jornada no puede contener más de veinticuatro horas de trabajo.",
    );
  }
  if (normalized[normalized.length - 1].endUnix > new DateTime().unix()) {
    throw new BadRequestError("No se pueden registrar horas futuras.");
  }
  if (workDate >= ojToday(timezone)) {
    throw new BadRequestError(
      "Las altas manuales sólo están disponibles para jornadas pasadas.",
    );
  }
  return normalized;
}

function ojStoredIntervals(record) {
  return Array.from(record.get("intervals") || []).map((item) => ({
    kind: String(ojItemValue(item, "kind") || ""),
    start: String(ojItemValue(item, "start") || ""),
    end: String(ojItemValue(item, "end") || ""),
    startNextDay: Boolean(ojItemValue(item, "startNextDay")),
    startAt: String(ojItemValue(item, "startAt") || ""),
    endAt: String(ojItemValue(item, "endAt") || ""),
    startUnix: new DateTime(String(ojItemValue(item, "startAt") || "")).unix(),
    endUnix: new DateTime(String(ojItemValue(item, "endAt") || "")).unix(),
    breakType: String(ojItemValue(item, "breakType") || ""),
    breakTypeName: String(ojItemValue(item, "breakTypeName") || ""),
    breakPaid: Boolean(ojItemValue(item, "breakPaid")),
  }));
}

function ojEffectiveEvents(app, employeeId, until) {
  const records = app.findRecordsByFilter(
    "work_events",
    "employee = {:employee} && occurredAt <= {:until}",
    "occurredAt",
    10000,
    0,
    { employee: employeeId, until },
  );
  const regular = {};
  const corrections = [];
  for (const record of records) {
    if (record.getString("kind") === "correction") corrections.push(record);
    else regular[record.id] = {
      id: record.id,
      kind: record.getString("kind"),
      occurredAt: record.getString("occurredAt"),
      occurredUnix: new DateTime(record.getString("occurredAt")).unix(),
      source: record.getString("source"),
      note: record.getString("note"),
      manualRequest: record.getString("manualRequest"),
      breakType: record.getString("breakType"),
      breakPaid: record.getBool("breakPaid"),
      created: record.getString("created"),
      integrityHash: record.getString("integrityHash"),
    };
  }
  corrections.sort(
    (left, right) =>
      new DateTime(left.getString("created")).unix() -
      new DateTime(right.getString("created")).unix(),
  );
  for (const correction of corrections) {
    const targetId = correction.getString("corrects");
    if (!targetId) continue;
    if (!regular[targetId]) {
      try {
        const target = app.findRecordById("work_events", targetId);
        if (target.getString("employee") !== employeeId) continue;
        regular[targetId] = {
          id: target.id,
          kind: target.getString("kind"),
          occurredAt: target.getString("occurredAt"),
          occurredUnix: new DateTime(target.getString("occurredAt")).unix(),
          source: target.getString("source"),
          note: target.getString("note"),
          manualRequest: target.getString("manualRequest"),
          breakType: target.getString("breakType"),
          breakPaid: target.getBool("breakPaid"),
          created: target.getString("created"),
          integrityHash: target.getString("integrityHash"),
        };
      } catch (_) {
        continue;
      }
    }
    regular[targetId].kind =
      correction.getString("correctedKind") || regular[targetId].kind;
    regular[targetId].occurredAt = correction.getString("occurredAt");
    regular[targetId].occurredUnix = new DateTime(
      correction.getString("occurredAt"),
    ).unix();
    regular[targetId].note = correction.getString("note");
  }
  return Object.keys(regular)
    .map((id) => regular[id])
    .sort((left, right) => left.occurredUnix - right.occurredUnix);
}

function ojWorkSpans(events, openUntil) {
  const spans = [];
  let activeAt = null;
  let anomaly = false;
  for (const event of events) {
    if (event.kind === "clock_in") {
      if (activeAt !== null) anomaly = true;
      activeAt = event.occurredUnix;
    } else if (event.kind === "break_start") {
      if (activeAt === null) {
        anomaly = true;
      } else if (!event.breakPaid) {
        spans.push({ startUnix: activeAt, endUnix: event.occurredUnix });
        activeAt = null;
      }
    } else if (event.kind === "break_end") {
      if (activeAt === null) activeAt = event.occurredUnix;
    } else if (event.kind === "clock_out") {
      if (activeAt === null) anomaly = true;
      else {
        spans.push({ startUnix: activeAt, endUnix: event.occurredUnix });
        activeAt = null;
      }
    }
  }
  if (activeAt !== null) {
    anomaly = true;
    spans.push({
      startUnix: activeAt,
      endUnix: Math.max(activeAt, openUntil),
      open: true,
    });
  }
  return { spans, anomaly };
}

function ojIntervalsOverlap(left, right) {
  return left.startUnix < right.endUnix && left.endUnix > right.startUnix;
}

function ojValidateConflicts(app, employeeId, intervals, excludeRequestId) {
  const lastEnd = intervals[intervals.length - 1].endAt;
  const events = ojEffectiveEvents(app, employeeId, lastEnd);
  const effective = ojWorkSpans(events, new DateTime().unix());
  for (const interval of intervals) {
    for (const span of effective.spans) {
      if (ojIntervalsOverlap(interval, span)) {
        throw new BadRequestError(
          "El tramo coincide con horas de trabajo ya registradas.",
        );
      }
    }
  }

  const pending = app.findRecordsByFilter(
    "manual_time_requests",
    "employee = {:employee} && status = 'pending'",
    "created",
    500,
    0,
    { employee: employeeId },
  );
  for (const request of pending) {
    if (request.id === excludeRequestId) continue;
    for (const existing of ojStoredIntervals(request)) {
      for (const interval of intervals) {
        if (ojIntervalsOverlap(interval, existing)) {
          throw new BadRequestError(
            "El tramo coincide con otra solicitud pendiente.",
          );
        }
      }
    }
  }
}

function ojCreateAudit(app, request, action, actorId) {
  const collection = app.findCollectionByNameOrId("audit_logs");
  const audit = new Record(collection);
  audit.set("organization", request.getString("organization"));
  audit.set("actor", actorId);
  audit.set("action", action);
  audit.set("entityType", "manual_time_request");
  audit.set("entityId", request.id);
  audit.set("metadata", {
    employee: request.getString("employee"),
    workDate: request.getString("workDate"),
    status: request.getString("status"),
  });
  audit.set("occurredAt", new Date().toISOString());
  app.save(audit);
}

function ojMaterializeRequest(app, request, intervals) {
  let previousHash = "";
  try {
    previousHash = app
      .findRecordsByFilter(
        "work_events",
        "employee = {:employee} && kind != 'correction'",
        "-created",
        1,
        0,
        { employee: request.getString("employee") },
      )[0]
      .getString("integrityHash");
  } catch (_) {
    previousHash = "";
  }

  const specifications = [];
  for (let index = 0; index < intervals.length; index += 1) {
    const item = intervals[index];
    const previous = intervals[index - 1];
    const next = intervals[index + 1];
    if (item.kind === "work") {
      if (
        !previous ||
        previous.kind !== "break" ||
        previous.endUnix !== item.startUnix
      ) {
        specifications.push({
          kind: "clock_in",
          occurredAt: item.startAt,
          breakType: "",
          breakTypeName: "",
          breakPaid: false,
        });
      }
      if (
        !next ||
        next.kind !== "break" ||
        item.endUnix !== next.startUnix
      ) {
        specifications.push({
          kind: "clock_out",
          occurredAt: item.endAt,
          breakType: "",
          breakTypeName: "",
          breakPaid: false,
        });
      }
    } else {
      specifications.push({
        kind: "break_start",
        occurredAt: item.startAt,
        breakType: item.breakType,
        breakTypeName: item.breakTypeName,
        breakPaid: item.breakPaid,
      });
      specifications.push({
        kind: "break_end",
        occurredAt: item.endAt,
        breakType: item.breakType,
        breakTypeName: item.breakTypeName,
        breakPaid: item.breakPaid,
      });
    }
  }
  specifications.sort(
    (left, right) =>
      new DateTime(left.occurredAt).unix() -
      new DateTime(right.occurredAt).unix(),
  );

  const collection = app.findCollectionByNameOrId("work_events");
  for (let index = 0; index < specifications.length; index += 1) {
    const specification = specifications[index];
    const requestId = "manual-" + request.id + "-" + index;
    const event = new Record(collection);
    event.set("employee", request.getString("employee"));
    event.set("organization", request.getString("organization"));
    event.set("kind", specification.kind);
    event.set("occurredAt", specification.occurredAt);
    event.set("timezone", request.getString("timezone"));
    event.set("source", "manual");
    event.set(
      "note",
      request.getString("reason") +
        (specification.breakTypeName
          ? " · Pausa: " + specification.breakTypeName
          : ""),
    );
    event.set("createdBy", request.getString("employee"));
    event.set("manualRequest", request.id);
    event.set("breakType", specification.breakType);
    event.set("breakPaid", specification.breakPaid);
    event.set("previousHash", previousHash);
    event.set("clientRequestId", requestId);
    const integrityHash = $security.sha256(
      [
        request.getString("employee"),
        request.getString("organization"),
        specification.kind,
        specification.occurredAt,
        request.id,
        index,
        previousHash,
      ].join("|"),
    );
    event.set("integrityHash", integrityHash);
    app.save(event);
    previousHash = integrityHash;
  }
}

function ojNotifyRecord(app, recipient, title, message, kind, actor) {
  const collection = app.findCollectionByNameOrId("notifications");
  const notification = new Record(collection);
  notification.set("organization", recipient.getString("organization"));
  notification.set("recipient", recipient.id);
  notification.set("title", title);
  notification.set("message", message);
  notification.set("kind", kind);
  notification.set("link", "/registros");
  notification.set("read", false);
  notification.set("createdBy", actor);
  app.save(notification);
}

function ojSendMail(app, recipient, subject, text) {
  if (!app.settings().smtp.enabled || !recipient.email()) return;
  try {
    app.newMailClient().send(
      new MailerMessage({
        from: {
          address: app.settings().meta.senderAddress,
          name: app.settings().meta.senderName,
        },
        to: [{ address: recipient.email() }],
        subject,
        text,
      }),
    );
  } catch (error) {
    console.log("No se pudo enviar un aviso de jornada manual:", error);
  }
}

function ojNotifyPending(app, request) {
  const employee = app.findRecordById(
    "users",
    request.getString("employee"),
  );
  const supervisors = app.findRecordsByFilter(
    "users",
    "organization = {:organization} && active = true && (role = 'admin' || role = 'manager')",
    "name",
    100,
    0,
    { organization: request.getString("organization") },
  );
  for (const supervisor of supervisors) {
    ojNotifyRecord(
      app,
      supervisor,
      "Jornada pasada pendiente",
      employee.getString("name") + " ha añadido una jornada para revisar.",
      "request",
      employee.id,
    );
    ojSendMail(
      app,
      supervisor,
      "Jornada pasada pendiente en " + app.settings().meta.appName,
      employee.getString("name") +
        " ha añadido una jornada pasada. Accede a " +
        app.settings().meta.appURL +
        "/registros para revisarla.",
    );
  }
}

function ojNotifyResolution(app, request) {
  const employee = app.findRecordById(
    "users",
    request.getString("employee"),
  );
  const approved = request.getString("status") === "approved";
  ojNotifyRecord(
    app,
    employee,
    approved ? "Jornada aprobada" : "Jornada rechazada",
    request.getString("resolutionNote") ||
      (approved
        ? "La jornada pasada se ha incorporado al registro."
        : "La jornada pasada no ha sido aceptada."),
    approved ? "success" : "warning",
    request.getString("resolvedBy"),
  );
  ojSendMail(
    app,
    employee,
    approved ? "Jornada pasada aprobada" : "Jornada pasada rechazada",
    request.getString("resolutionNote") ||
      (approved
        ? "La jornada pasada se ha incorporado al registro."
        : "La jornada pasada no ha sido aceptada."),
  );
}

routerAdd(
  "POST",
  "/api/openjornada/manual-time-requests",
  (e) => {
    const helper = require(`${__hooks}/timesheet_helpers.js`);
    const body = new DynamicModel({
      workDate: "",
      intervals: [],
      reason: "",
    });
    e.bindBody(body);
    const organization = e.app.findRecordById(
      "organizations",
      e.auth.getString("organization"),
    );
    const timezone = organization.getString("timezone") || "Europe/Madrid";
    const reason = String(body.reason || "").trim();
    if ((reason.length > 0 && reason.length < 8) || reason.length > 500) {
      throw new BadRequestError(
        "Si indicas un motivo, debe tener entre ocho y quinientos caracteres.",
      );
    }
    const intervals = helper.normalizeIntervals(
      e.app,
      body.workDate,
      timezone,
      body.intervals,
      organization.id,
    );
    const current = helper.editableDayState(
      e.app,
      e.auth.id,
      body.workDate,
      timezone,
    );
    if (
      current.eventIds.length > 0 ||
      helper.hasApprovedTimeHistory(
        e.app,
        e.auth.id,
        body.workDate,
        timezone,
      )
    ) {
      throw new BadRequestError(
        "Esta jornada ya tenía fichajes. Utiliza una corrección e indica el motivo.",
      );
    }
    helper.validateConflicts(e.app, e.auth.id, intervals, "");

    let created;
    e.app.runInTransaction((txApp) => {
      const collection = txApp.findCollectionByNameOrId(
        "manual_time_requests",
      );
      const request = new Record(collection);
      const approvalRequired = organization.getBool(
        "manualTimeApprovalRequired",
      );
      request.set("organization", organization.id);
      request.set("employee", e.auth.id);
      request.set(
        "workDate",
        new DateTime(body.workDate + " 00:00:00", timezone).string(),
      );
      request.set("timezone", timezone);
      request.set("intervals", intervals);
      request.set("requestType", "addition");
      request.set("timeStorageVersion", "iana_v1");
      request.set("originalIntervals", []);
      request.set("targetEvents", []);
      request.set("baseFingerprint", "");
      request.set("reason", reason);
      request.set("approvalRequired", approvalRequired);
      request.set("status", approvalRequired ? "pending" : "approved");
      request.set("resolvedBy", "");
      request.set(
        "resolvedAt",
        approvalRequired ? "" : new Date().toISOString(),
      );
      request.set(
        "resolutionNote",
        approvalRequired
          ? ""
          : "Aplicada automáticamente según la política de la empresa.",
      );
      txApp.save(request);
      if (!approvalRequired) {
        helper.materializeRequest(txApp, request, intervals);
      }
      helper.createAudit(
        txApp,
        request,
        approvalRequired
          ? "manual_time_request.created"
          : "manual_time_request.auto_approved",
        e.auth.id,
      );
      created = request;
    });

    if (created.getString("status") === "pending") {
      try {
        helper.notifyPending(e.app, created);
      } catch (error) {
        console.log("No se pudo notificar la jornada pendiente:", error);
      }
    }
    return e.json(201, created.publicExport());
  },
  $apis.requireAuth("users"),
);

routerAdd(
  "POST",
  "/api/openjornada/timesheet-corrections",
  (e) => {
    const helper = require(`${__hooks}/timesheet_helpers.js`);
    const body = new DynamicModel({
      workDate: "",
      intervals: [],
      reason: "",
    });
    e.bindBody(body);
    const organization = e.app.findRecordById(
      "organizations",
      e.auth.getString("organization"),
    );
    const timezone = organization.getString("timezone") || "Europe/Madrid";
    const reason = String(body.reason || "").trim();
    if (reason.length < 8 || reason.length > 500) {
      throw new BadRequestError(
        "El motivo debe tener entre ocho y quinientos caracteres.",
      );
    }
    const rawIntervals = Array.from(body.intervals || []);
    const intervals = rawIntervals.length
      ? helper.normalizeIntervals(
          e.app,
          body.workDate,
          timezone,
          rawIntervals,
          organization.id,
        )
      : [];
    const original = helper.editableDayState(
      e.app,
      e.auth.id,
      body.workDate,
      timezone,
    );
    const hadApprovedTimeHistory = helper.hasApprovedTimeHistory(
      e.app,
      e.auth.id,
      body.workDate,
      timezone,
    );
    if (original.eventIds.length === 0 && !hadApprovedTimeHistory) {
      throw new BadRequestError(
        "No hay fichajes que corregir en esta jornada.",
      );
    }
    if (
      original.eventIds.length > 0 &&
      body.workDate === helper.today(timezone) &&
      !original.closed
    ) {
      throw new BadRequestError(
        "Finaliza la jornada actual antes de corregirla.",
      );
    }

    const pending = e.app.findRecordsByFilter(
      "manual_time_requests",
      "employee = {:employee} && status = 'pending'",
      "created",
      500,
      0,
      { employee: e.auth.id },
    );
    for (const request of pending) {
      if (
        request.getString("requestType") === "replacement" &&
        helper.localKey(request.getString("workDate"), timezone) ===
          body.workDate
      ) {
        throw new BadRequestError(
          "Ya hay una corrección pendiente para esta jornada.",
        );
      }
    }
    for (const eventId of original.eventIds) {
      try {
        e.app.findFirstRecordByFilter(
          "correction_requests",
          "workEvent = {:event} && status = 'pending'",
          { event: eventId },
        );
        throw new BadRequestError(
          "Hay una corrección de fichaje pendiente en esta jornada.",
        );
      } catch (error) {
        if (error instanceof BadRequestError) throw error;
      }
    }
    helper.validateConflicts(
      e.app,
      e.auth.id,
      intervals,
      "",
      original.eventIds,
    );

    let created;
    e.app.runInTransaction((txApp) => {
      const collection = txApp.findCollectionByNameOrId(
        "manual_time_requests",
      );
      const request = new Record(collection);
      const approvalRequired = organization.getBool(
        "timeCorrectionApprovalRequired",
      );
      request.set("organization", organization.id);
      request.set("employee", e.auth.id);
      request.set(
        "workDate",
        new DateTime(body.workDate + " 00:00:00", timezone).string(),
      );
      request.set("timezone", timezone);
      request.set("intervals", intervals);
      request.set("requestType", "replacement");
      request.set("timeStorageVersion", "iana_v1");
      request.set("originalIntervals", original.intervals);
      request.set("targetEvents", original.eventIds);
      request.set("baseFingerprint", original.fingerprint);
      request.set("reason", reason);
      request.set("approvalRequired", approvalRequired);
      request.set("status", approvalRequired ? "pending" : "approved");
      request.set("resolvedBy", approvalRequired ? "" : e.auth.id);
      request.set(
        "resolvedAt",
        approvalRequired ? "" : new Date().toISOString(),
      );
      request.set(
        "resolutionNote",
        approvalRequired
          ? ""
          : "Corrección aplicada automáticamente según la política de la empresa.",
      );
      txApp.save(request);
      if (!approvalRequired) {
        helper.materializeReplacement(txApp, request, intervals);
      }
      helper.createAudit(
        txApp,
        request,
        approvalRequired
          ? "timesheet_correction.created"
          : "timesheet_correction.auto_approved",
        e.auth.id,
      );
      created = request;
    });

    if (created.getString("status") === "pending") {
      try {
        helper.notifyPending(e.app, created);
      } catch (error) {
        console.log("No se pudo notificar la corrección pendiente:", error);
      }
    }
    return e.json(201, created.publicExport());
  },
  $apis.requireAuth("users"),
);

routerAdd(
  "POST",
  "/api/openjornada/manual-time-requests/{request}/resolve",
  (e) => {
    const helper = require(`${__hooks}/timesheet_helpers.js`);
    const role = e.auth.getString("role");
    if (role !== "admin" && role !== "manager") {
      throw new ForbiddenError("No tienes permisos para resolver jornadas.");
    }
    const body = new DynamicModel({ status: "", resolutionNote: "" });
    e.bindBody(body);
    if (body.status !== "approved" && body.status !== "rejected") {
      throw new BadRequestError("La resolución no es válida.");
    }

    let resolved;
    e.app.runInTransaction((txApp) => {
      const request = txApp.findRecordById(
        "manual_time_requests",
        e.request.pathValue("request"),
      );
      if (
        request.getString("organization") !==
          e.auth.getString("organization") ||
        request.getString("status") !== "pending"
      ) {
        throw new BadRequestError(
          "La solicitud ya no está disponible para resolver.",
        );
      }
      request.set("status", body.status);
      request.set("resolvedBy", e.auth.id);
      request.set("resolvedAt", new Date().toISOString());
      request.set(
        "resolutionNote",
        String(body.resolutionNote || "").trim() ||
          (body.status === "approved"
            ? request.getString("requestType") === "replacement"
              ? "Corrección revisada y aprobada."
              : "Jornada revisada y aprobada."
            : request.getString("requestType") === "replacement"
              ? "La corrección no ha sido aprobada."
              : "La jornada no ha sido aprobada."),
      );
      if (body.status === "approved") {
        const intervals = helper.storedIntervals(request);
        if (request.getString("requestType") === "replacement") {
          const targetEvents = Array.from(
            request.get("targetEvents") || [],
          );
          helper.validateConflicts(
            txApp,
            request.getString("employee"),
            intervals,
            request.id,
            targetEvents,
          );
          helper.materializeReplacement(txApp, request, intervals);
        } else {
          helper.validateConflicts(
            txApp,
            request.getString("employee"),
            intervals,
            request.id,
          );
          helper.materializeRequest(txApp, request, intervals);
        }
      }
      txApp.save(request);
      helper.createAudit(
        txApp,
        request,
        body.status === "approved"
          ? request.getString("requestType") === "replacement"
            ? "timesheet_correction.approved"
            : "manual_time_request.approved"
          : request.getString("requestType") === "replacement"
            ? "timesheet_correction.rejected"
            : "manual_time_request.rejected",
        e.auth.id,
      );
      resolved = request;
    });
    try {
      helper.notifyResolution(e.app, resolved);
    } catch (error) {
      console.log("No se pudo notificar la resolución de jornada:", error);
    }
    return e.json(200, resolved.publicExport());
  },
  $apis.requireAuth("users"),
);

routerAdd(
  "POST",
  "/api/openjornada/manual-time-requests/{request}/cancel",
  (e) => {
    const helper = require(`${__hooks}/timesheet_helpers.js`);
    let cancelled;
    e.app.runInTransaction((txApp) => {
      const request = txApp.findRecordById(
        "manual_time_requests",
        e.request.pathValue("request"),
      );
      if (
        request.getString("organization") !==
          e.auth.getString("organization") ||
        request.getString("employee") !== e.auth.id ||
        request.getString("status") !== "pending"
      ) {
        throw new BadRequestError("La solicitud ya no se puede cancelar.");
      }
      request.set("status", "cancelled");
      request.set("resolvedBy", e.auth.id);
      request.set("resolvedAt", new Date().toISOString());
      request.set("resolutionNote", "Cancelada por la persona solicitante.");
      txApp.save(request);
      helper.createAudit(
        txApp,
        request,
        request.getString("requestType") === "replacement"
          ? "timesheet_correction.cancelled"
          : "manual_time_request.cancelled",
        e.auth.id,
      );
      cancelled = request;
    });
    return e.json(200, cancelled.publicExport());
  },
  $apis.requireAuth("users"),
);

function ojScheduleMinutes(schedule) {
  const start = ojTimeMinutes(schedule.getString("startTime"));
  let end = ojTimeMinutes(schedule.getString("endTime"));
  if (start < 0 || end < 0) return 0;
  if (end <= start) end += 24 * 60;
  return Math.max(0, end - start - schedule.getFloat("breakMinutes"));
}

function ojRecordDateInRange(record, date, timezone, startField, endField) {
  const start = ojLocalKey(record.getString(startField), timezone);
  const rawEnd = record.getString(endField);
  const end = rawEnd ? ojLocalKey(rawEnd, timezone) : "9999-12-31";
  return start <= date && end >= date;
}

routerAdd(
  "GET",
  "/api/openjornada/timesheet",
  (e) => {
    const helper = require(`${__hooks}/timesheet_helpers.js`);
    const query = e.requestInfo().query;
    const from = String(query.from || "");
    const to = String(query.to || "");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      from > to
    ) {
      throw new BadRequestError("El intervalo de la hoja no es válido.");
    }
    const authOrganization = e.auth.getString("organization");
    const role = e.auth.getString("role");
    let employeeId = String(query.employee || e.auth.id);
    if (role === "employee") employeeId = e.auth.id;
    const employee = e.app.findRecordById("users", employeeId);
    if (employee.getString("organization") !== authOrganization) {
      throw new ForbiddenError("La persona no pertenece a tu empresa.");
    }
    const organization = e.app.findRecordById(
      "organizations",
      authOrganization,
    );
    const timezone = organization.getString("timezone") || "Europe/Madrid";
    const startAt = new DateTime(from + " 00:00:00", timezone);
    const endAt = new DateTime(to + " 23:59:59", timezone);
    if ((endAt.unix() - startAt.unix()) / 86400 > 366) {
      throw new BadRequestError("La hoja no puede abarcar más de un año.");
    }

    const effectiveEvents = helper.effectiveEvents(
      e.app,
      employeeId,
      endAt.addDate(0, 0, 1).string(),
    );
    const spanResult = helper.workSpans(
      effectiveEvents,
      Math.min(new DateTime().unix(), endAt.unix()),
    );
    const anomalyDates = helper.sequenceAnomalyDates(
      effectiveEvents,
      timezone,
    );
    const editableByDate = helper.editableDays(
      effectiveEvents,
      timezone,
    );
    const schedules = e.app.findRecordsByFilter(
      "work_schedules",
      "employee = {:employee} && active = true",
      "-validFrom",
      500,
      0,
      { employee: employeeId },
    );
    const holidays = e.app.findRecordsByFilter(
      "public_holidays",
      "organization = {:organization} && date >= {:start} && date <= {:end}",
      "date",
      500,
      0,
      {
        organization: authOrganization,
        start: startAt.string(),
        end: endAt.string(),
      },
    );
    const holidayByDate = {};
    for (const holiday of holidays) {
      holidayByDate[helper.localKey(holiday.getString("date"), timezone)] =
        holiday.getString("name");
    }
    const leaves = e.app.findRecordsByFilter(
      "leave_requests",
      "employee = {:employee} && status = 'approved' && startDate <= {:end} && endDate >= {:start}",
      "startDate",
      500,
      0,
      {
        employee: employeeId,
        start: startAt.string(),
        end: endAt.string(),
      },
    );
    const requests = e.app.findRecordsByFilter(
      "manual_time_requests",
      "employee = {:employee} && workDate >= {:start} && workDate <= {:end}",
      "-created",
      500,
      0,
      {
        employee: employeeId,
        start: startAt.string(),
        end: endAt.string(),
      },
    );
    const requestsByDate = {};
    for (const request of requests) {
      const key = helper.localKey(request.getString("workDate"), timezone);
      requestsByDate[key] = requestsByDate[key] || [];
      requestsByDate[key].push({
        id: request.id,
        requestType: request.getString("requestType") || "addition",
        status: request.getString("status"),
        reason: request.getString("reason"),
        intervals: request.get("intervals"),
        originalIntervals: request.get("originalIntervals") || [],
        approvalRequired: request.getBool("approvalRequired"),
        resolutionNote: request.getString("resolutionNote"),
        created: request.getString("created"),
      });
    }

    const days = [];
    const today = helper.today(timezone);
    let totalWorked = 0;
    let totalPlanned = 0;
    for (
      let cursor = startAt;
      cursor.unix() <= endAt.unix();
      cursor = cursor.addDate(0, 0, 1)
    ) {
      const date = cursor
        .time()
        .in(new Timezone(timezone))
        .format("2006-01-02");
      const next = cursor.addDate(0, 0, 1);
      const editableDay = editableByDate[date] || {
        eventIds: [],
        intervals: [],
        closed: false,
      };
      const dayRequests = requestsByDate[date] || [];
      const hadApprovedTimeHistory = dayRequests.some(
        (request) => request.status === "approved",
      );
      const dayEvents = effectiveEvents
        .filter(
          (event) =>
            event.occurredUnix >= cursor.unix() &&
            event.occurredUnix < next.unix(),
        )
        .map((event) => ({
          id: event.id,
          kind: event.kind,
          occurredAt: event.occurredAt,
          occurredUnix: event.occurredUnix,
          source: event.source,
          note: event.note,
          manualRequest: event.manualRequest,
          breakType: event.breakType,
          breakPaid: event.breakPaid,
          integrityHash: event.integrityHash,
        }));
      let workedMinutes = 0;
      for (const span of spanResult.spans) {
        const overlapStart = Math.max(span.startUnix, cursor.unix());
        const overlapEnd = Math.min(span.endUnix, next.unix());
        if (overlapEnd > overlapStart) {
          workedMinutes += Math.round((overlapEnd - overlapStart) / 60);
        }
      }

      let selectedSchedule = null;
      for (const schedule of schedules) {
        if (
          !helper.recordDateInRange(
            schedule,
            date,
            timezone,
            "validFrom",
            "validUntil",
          )
        ) {
          continue;
        }
        let weekdays = [];
        try {
          weekdays = JSON.parse(schedule.getString("weekdays") || "[]");
        } catch (_) {}
        const weekday = cursor.time().in(new Timezone(timezone)).weekday();
        if (weekdays.indexOf(Number(weekday)) >= 0) {
          selectedSchedule = schedule;
          break;
        }
      }
      let plannedMinutes = selectedSchedule
        ? helper.scheduleMinutes(selectedSchedule)
        : 0;
      const absences = [];
      let fullAbsence = false;
      let halfAbsences = 0;
      for (const leave of leaves) {
        if (
          !helper.recordDateInRange(
            leave,
            date,
            timezone,
            "startDate",
            "endDate",
          )
        ) {
          continue;
        }
        let name = leave.getString("type");
        const leaveTypeId = leave.getString("leaveType");
        if (leaveTypeId) {
          try {
            name = e.app
              .findRecordById("leave_types", leaveTypeId)
              .getString("name");
          } catch (_) {}
        }
        absences.push({ name, dayPart: leave.getString("dayPart") });
        if (leave.getString("dayPart") === "full") fullAbsence = true;
        else halfAbsences += 1;
      }
      if (holidayByDate[date] || fullAbsence) plannedMinutes = 0;
      else if (halfAbsences > 0) plannedMinutes = Math.round(plannedMinutes / 2);

      const balanceMinutes = workedMinutes - plannedMinutes;
      totalWorked += workedMinutes;
      totalPlanned += plannedMinutes;
      days.push({
        date,
        workedMinutes,
        plannedMinutes,
        balanceMinutes,
        overtimeMinutes: Math.max(0, balanceMinutes),
        holiday: holidayByDate[date] || "",
        absences,
        events: dayEvents,
        editableIntervals: editableDay.intervals,
        requests: dayRequests,
        anomaly: Boolean(anomalyDates[date]),
        canAddManualTime:
          date <= today &&
          employeeId === e.auth.id &&
          editableDay.eventIds.length === 0 &&
          !hadApprovedTimeHistory,
        canCorrectTime:
          date <= today &&
          employeeId === e.auth.id &&
          ((editableDay.eventIds.length > 0 &&
            (date < today || editableDay.closed)) ||
            (editableDay.eventIds.length === 0 &&
              hadApprovedTimeHistory)),
      });
    }

    return e.json(200, {
      employee: {
        id: employee.id,
        name: employee.getString("name"),
        employeeCode: employee.getString("employeeCode"),
      },
      timezone,
      from,
      to,
      approvalRequired: organization.getBool(
        "manualTimeApprovalRequired",
      ),
      correctionApprovalRequired: organization.getBool(
        "timeCorrectionApprovalRequired",
      ),
      totals: {
        workedMinutes: totalWorked,
        plannedMinutes: totalPlanned,
        balanceMinutes: totalWorked - totalPlanned,
        overtimeMinutes: Math.max(0, totalWorked - totalPlanned),
      },
      days,
    });
  },
  $apis.requireAuth("users"),
);
