onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (
    !e.auth ||
    e.auth.getString("role") !== "admin" ||
    e.record.id !== e.auth.getString("organization")
  ) {
    throw new ForbiddenError("Sólo administración puede cambiar la empresa.");
  }
  const taxId = e.record.getString("taxId").trim();
  if (!taxId) {
    throw new BadRequestError("El NIF de la empresa es obligatorio.");
  }
  e.record.set("taxId", taxId);
  const colorPattern = /^#[0-9a-fA-F]{6}$/;
  for (const field of ["brandPrimaryColor", "brandSecondaryColor"]) {
    const color = e.record.getString(field);
    if (color && !colorPattern.test(color)) {
      throw new BadRequestError("El color corporativo no es válido.");
    }
    if (color) e.record.set(field, color.toLowerCase());
  }
  e.record.set("pwaName", e.record.getString("pwaName").trim());
  e.record.set("pwaShortName", e.record.getString("pwaShortName").trim());
  e.next();
}, "organizations");

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth || e.auth.getString("role") !== "admin") {
    throw new ForbiddenError(
      "Sólo administración puede crear tipos de pausa.",
    );
  }
  const name = e.record.getString("name").trim();
  if (name.length < 2) {
    throw new BadRequestError("El nombre del tipo de pausa no es válido.");
  }
  e.record.set("organization", e.auth.getString("organization"));
  e.record.set("name", name);
  e.record.set("active", true);
  e.next();
}, "break_types");

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (
    !e.auth ||
    e.auth.getString("role") !== "admin" ||
    e.record.original().getString("organization") !==
      e.auth.getString("organization")
  ) {
    throw new ForbiddenError(
      "Sólo administración puede modificar tipos de pausa.",
    );
  }
  const name = e.record.getString("name").trim();
  if (name.length < 2) {
    throw new BadRequestError("El nombre del tipo de pausa no es válido.");
  }
  e.record.set(
    "organization",
    e.record.original().getString("organization"),
  );
  e.record.set("name", name);
  e.next();
}, "break_types");

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth || e.auth.getString("role") !== "admin") {
    throw new ForbiddenError(
      "Sólo administración puede crear saldos de ausencias.",
    );
  }
  const organization = e.auth.getString("organization");
  e.record.set("organization", organization);
  e.record.set("updatedBy", e.auth.id);
  require(`${__hooks}/leave_balance_helpers.js`).validateReferences(
    e.app,
    e.record,
    organization,
  );
  e.next();
}, "leave_balances");

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth || e.auth.getString("role") !== "admin") {
    throw new ForbiddenError(
      "Sólo administración puede modificar saldos de ausencias.",
    );
  }
  const original = e.record.original();
  const organization = original.getString("organization");
  if (organization !== e.auth.getString("organization")) {
    throw new ForbiddenError(
      "No puedes modificar saldos de ausencias de otra empresa.",
    );
  }
  e.record.set("organization", original.getString("organization"));
  e.record.set("employee", original.getString("employee"));
  e.record.set("leaveType", original.getString("leaveType"));
  e.record.set("year", original.getFloat("year"));
  e.record.set("updatedBy", e.auth.id);
  require(`${__hooks}/leave_balance_helpers.js`).validateReferences(
    e.app,
    e.record,
    organization,
  );
  e.next();
}, "leave_balances");

onRecordAfterUpdateSuccess((e) => {
  const actor = e.record.getString("updatedBy");
  if (!actor) return e.next();
  require(`${__hooks}/leave_balance_helpers.js`).auditUpdate(
    e.app,
    e.record,
    e.record.original(),
    actor,
  );
  e.next();
}, "leave_balances");

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.");
  const requestedDaysFor = (
    organization,
    employeeId,
    startValue,
    endValue,
    dayPart,
  ) => {
    const first = new Date(startValue);
    const last = new Date(endValue);
    const scheduleHelper = require(`${__hooks}/timesheet_helpers.js`);
    const timezone =
      e.app.findRecordById("organizations", organization).getString("timezone") ||
      "Europe/Madrid";
    const holidayRecords = e.app.findRecordsByFilter(
      "public_holidays",
      "organization = {:organization} && date >= {:start} && date <= {:end}",
      "date",
      366,
      0,
      { organization, start: startValue, end: endValue },
    );
    const holidays = {};
    for (const holiday of holidayRecords) {
      holidays[holiday.getString("date").slice(0, 10)] = true;
    }
    const schedules = e.app.findRecordsByFilter(
      "work_schedules",
      "employee = {:employee}",
      "-validFrom,-created",
      500,
      0,
      { employee: employeeId },
    );
    let days = 0;
    const cursor = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()),
    );
    const limit = Date.UTC(
      last.getUTCFullYear(),
      last.getUTCMonth(),
      last.getUTCDate(),
    );
    while (cursor.getTime() <= limit) {
      const weekday = cursor.getUTCDay();
      const key = cursor.toISOString().slice(0, 10);
      if (holidays[key]) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        continue;
      }
      let selectedSchedule = null;
      for (const schedule of schedules) {
        if (!scheduleHelper.scheduleAppliesOnDate(schedule, key, timezone)) {
          continue;
        }
        let weekdays = [];
        try {
          weekdays = JSON.parse(schedule.getString("weekdays") || "[]");
        } catch (_) {}
        if (weekdays.indexOf(Number(weekday)) >= 0) {
          selectedSchedule = schedule;
          break;
        }
      }
      const isWorkingDay = selectedSchedule
        ? true
        : schedules.some((schedule) =>
            scheduleHelper.scheduleAppliesOnDate(schedule, key, timezone),
          )
          ? false
          : weekday !== 0 && weekday !== 6;
      if (isWorkingDay) days += 1;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days === 1 && dayPart !== "full" ? 0.5 : days;
  };

  const start = new Date(e.record.getString("startDate"));
  const end = new Date(e.record.getString("endDate"));
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    throw new BadRequestError("El intervalo de ausencia no es válido.");
  }

  const organization = e.auth.getString("organization");
  const role = e.auth.getString("role");
  const canAssign = role === "admin" || role === "manager";
  const requestedEmployee = e.record.getString("employee");
  const employeeId =
    canAssign && requestedEmployee ? requestedEmployee : e.auth.id;
  const employee = e.app.findRecordById("users", employeeId);
  if (employee.getString("organization") !== organization) {
    throw new ForbiddenError("La persona no pertenece a tu empresa.");
  }
  e.record.set("organization", organization);
  e.record.set("employee", employeeId);
  e.record.set("reviewedBy", "");
  e.record.set("reviewedAt", "");
  e.record.set("response", "");
  e.record.set("assignedBy", employeeId === e.auth.id ? "" : e.auth.id);

  let requestedDays = requestedDaysFor(
    organization,
    employeeId,
    e.record.getString("startDate"),
    e.record.getString("endDate"),
    e.record.getString("dayPart"),
  );
  if (requestedDays <= 0) {
    throw new BadRequestError("La solicitud no contiene días laborables.");
  }
  e.record.set("requestedDays", requestedDays);

  const leaveTypeId = e.record.getString("leaveType");
  let leaveType = null;
  if (leaveTypeId) {
    leaveType = e.app.findRecordById("leave_types", leaveTypeId);
    if (
      leaveType.getString("organization") !== organization ||
      !leaveType.getBool("active")
    ) {
      throw new BadRequestError("El tipo de ausencia no es válido.");
    }
    const typeCode = leaveType.getString("code");
    e.record.set(
      "type",
      ["vacation", "medical", "personal", "other"].includes(typeCode)
        ? typeCode
        : "other",
    );
    if (
      leaveType.getBool("requiresDocument") &&
      e.findUploadedFiles("attachment").length === 0
    ) {
      throw new BadRequestError(
        "Este tipo de ausencia requiere un documento justificativo.",
      );
    }
  }

  if (role !== "admin") {
    try {
      e.app.findFirstRecordByFilter(
        "leave_blackout_periods",
        "organization = {:organization} && startDate <= {:end} && endDate >= {:start} && (leaveType = '' || leaveType = {:leaveType})",
        {
          organization,
          start: e.record.getString("startDate"),
          end: e.record.getString("endDate"),
          leaveType: leaveTypeId,
        },
      );
      throw new BadRequestError(
        "Las fechas coinciden con un período bloqueado.",
      );
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
    }
  }

  if (leaveType && leaveType.getBool("deductsBalance")) {
    const year = start.getUTCFullYear();
    try {
      const balance = e.app.findFirstRecordByFilter(
        "leave_balances",
        "employee = {:employee} && leaveType = {:leaveType} && year = {:year}",
        { employee: employeeId, leaveType: leaveTypeId, year },
      );
      const approved = e.app.findRecordsByFilter(
        "leave_requests",
        "employee = {:employee} && leaveType = {:leaveType} && status = 'approved' && startDate >= {:yearStart} && startDate <= {:yearEnd}",
        "startDate",
        500,
        0,
        {
          employee: employeeId,
          leaveType: leaveTypeId,
          yearStart: year + "-01-01 00:00:00.000Z",
          yearEnd: year + "-12-31 23:59:59.999Z",
        },
      );
      let used = 0;
      for (const request of approved) used += request.getFloat("requestedDays");
      const available =
        balance.getFloat("allowance") +
        balance.getFloat("carriedOver") +
        balance.getFloat("adjustment") -
        used;
      if (requestedDays > available) {
        throw new BadRequestError(
          "No hay saldo suficiente para esta ausencia.",
        );
      }
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
    }
  }

  const autoApproved =
    employeeId !== e.auth.id ||
    (leaveType && !leaveType.getBool("requiresApproval"));
  e.record.set("status", autoApproved ? "approved" : "pending");
  if (autoApproved) {
    e.record.set("reviewedBy", e.auth.id);
    e.record.set("reviewedAt", new Date().toISOString());
    e.record.set("response", "Ausencia asignada y aprobada.");
  }

  try {
    e.app.findFirstRecordByFilter(
      "leave_requests",
      "employee = {:employee} && startDate <= {:end} && endDate >= {:start} && (status = 'pending' || status = 'approved')",
      {
        employee: employeeId,
        start: e.record.getString("startDate"),
        end: e.record.getString("endDate"),
      },
    );
    throw new BadRequestError(
      "Ya existe una solicitud que coincide con esas fechas.",
    );
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
  }

  e.next();
}, "leave_requests");

onRecordAfterCreateSuccess((e) => {
  try {
    const employee = e.app.findRecordById(
      "users",
      e.record.getString("employee"),
    );
    const supervisors = e.app.findRecordsByFilter(
      "users",
      "organization = {:organization} && active = true && (role = 'admin' || role = 'manager')",
      "name",
      100,
      0,
      { organization: e.record.getString("organization") },
    );
    const collection = e.app.findCollectionByNameOrId("notifications");
    for (const supervisor of supervisors) {
      const notification = new Record(collection);
      notification.set("organization", e.record.getString("organization"));
      notification.set("recipient", supervisor.id);
      notification.set("title", "Nueva solicitud de ausencia");
      notification.set(
        "message",
        employee.getString("name") + " ha solicitado una ausencia.",
      );
      notification.set("kind", "request");
      notification.set("link", "/ausencias");
      notification.set("read", false);
      notification.set("createdBy", employee.id);
      e.app.save(notification);

      if (e.app.settings().smtp.enabled) {
        try {
          e.app.newMailClient().send(
            new MailerMessage({
              from: {
                address: e.app.settings().meta.senderAddress,
                name: e.app.settings().meta.senderName,
              },
              to: [{ address: supervisor.email() }],
              subject:
                "Nueva solicitud de ausencia en " +
                e.app.settings().meta.appName,
              text:
                employee.getString("name") +
                " ha solicitado una ausencia. Accede a " +
                e.app.settings().meta.appURL +
                "/ausencias para revisarla.",
            }),
          );
        } catch (mailError) {
          console.log("No se pudo enviar el aviso de ausencia:", mailError);
        }
      }
    }
  } catch (error) {
    console.log("No se pudieron crear los avisos de ausencia:", error);
  }
  e.next();
}, "leave_requests");

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.");

  const original = e.record.original();
  const actorRole = e.auth.getString("role");
  const isOwner = original.getString("employee") === e.auth.id;
  const requestedStatus = e.record.getString("status");

  for (const field of [
    "organization",
    "employee",
    "type",
    "startDate",
    "endDate",
    "dayPart",
    "reason",
    "leaveType",
    "requestedDays",
    "assignedBy",
    "attachment",
  ]) {
    e.record.set(field, original.get(field));
  }

  if (isOwner && actorRole === "employee") {
    if (
      original.getString("status") !== "pending" ||
      requestedStatus !== "cancelled"
    ) {
      throw new ForbiddenError("Sólo puedes cancelar solicitudes pendientes.");
    }
    e.record.set("reviewedBy", "");
    e.record.set("reviewedAt", new Date().toISOString());
    e.record.set("response", "Cancelada por la persona solicitante.");
    return e.next();
  }

  if (actorRole !== "admin" && actorRole !== "manager") {
    throw new ForbiddenError(
      "No tienes permisos para resolver esta solicitud.",
    );
  }
  if (
    original.getString("status") !== "pending" ||
    (requestedStatus !== "approved" && requestedStatus !== "rejected")
  ) {
    throw new BadRequestError("La resolución solicitada no es válida.");
  }
  e.record.set("reviewedBy", e.auth.id);
  e.record.set("reviewedAt", new Date().toISOString());
  e.next();
}, "leave_requests");

onRecordAfterUpdateSuccess((e) => {
  const original = e.record.original();
  if (original.getString("status") === e.record.getString("status")) {
    return e.next();
  }

  try {
    const employee = e.app.findRecordById(
      "users",
      e.record.getString("employee"),
    );
    const status = e.record.getString("status");
    const labels = {
      approved: "aprobada",
      rejected: "rechazada",
      cancelled: "cancelada",
    };
    const collection = e.app.findCollectionByNameOrId("notifications");
    const notification = new Record(collection);
    notification.set("organization", e.record.getString("organization"));
    notification.set("recipient", employee.id);
    notification.set(
      "title",
      "Solicitud de ausencia " + (labels[status] || status),
    );
    notification.set(
      "message",
      e.record.getString("response") ||
        "Tu solicitud de ausencia ha sido " + (labels[status] || status) + ".",
    );
    notification.set("kind", status === "approved" ? "success" : "warning");
    notification.set("link", "/ausencias");
    notification.set("read", false);
    notification.set("createdBy", e.record.getString("reviewedBy"));
    e.app.save(notification);

    if (e.app.settings().smtp.enabled) {
      try {
        e.app.newMailClient().send(
          new MailerMessage({
            from: {
              address: e.app.settings().meta.senderAddress,
              name: e.app.settings().meta.senderName,
            },
            to: [{ address: employee.email() }],
            subject:
              "Tu solicitud de ausencia ha sido " + (labels[status] || status),
            text:
              "Hola " +
              employee.getString("name") +
              ". Tu solicitud ha sido " +
              (labels[status] || status) +
              ". " +
              e.record.getString("response"),
          }),
        );
      } catch (mailError) {
        console.log("No se pudo enviar la resolución de ausencia:", mailError);
      }
    }
  } catch (error) {
    console.log("No se pudo notificar la resolución de ausencia:", error);
  }
  e.next();
}, "leave_requests");

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.");

  const target = e.app.findRecordById(
    "work_events",
    e.record.getString("workEvent"),
  );
  if (
    target.getString("employee") !== e.auth.id ||
    target.getString("organization") !== e.auth.getString("organization") ||
    target.getString("kind") === "correction"
  ) {
    throw new ForbiddenError("El fichaje indicado no se puede corregir.");
  }

  try {
    e.app.findFirstRecordByFilter(
      "correction_requests",
      "workEvent = {:event} && status = 'pending'",
      { event: target.id },
    );
    throw new BadRequestError(
      "Ya hay una corrección pendiente para este fichaje.",
    );
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
  }

  e.record.set("organization", e.auth.getString("organization"));
  e.record.set("employee", e.auth.id);
  e.record.set("status", "pending");
  e.record.set("resolvedBy", "");
  e.record.set("resolvedAt", "");
  e.record.set("resolutionNote", "");
  e.next();
}, "correction_requests");

onRecordAfterCreateSuccess((e) => {
  try {
    const employee = e.app.findRecordById(
      "users",
      e.record.getString("employee"),
    );
    const supervisors = e.app.findRecordsByFilter(
      "users",
      "organization = {:organization} && active = true && (role = 'admin' || role = 'manager')",
      "name",
      100,
      0,
      { organization: e.record.getString("organization") },
    );
    const collection = e.app.findCollectionByNameOrId("notifications");
    for (const supervisor of supervisors) {
      const notification = new Record(collection);
      notification.set("organization", e.record.getString("organization"));
      notification.set("recipient", supervisor.id);
      notification.set("title", "Corrección de fichaje pendiente");
      notification.set(
        "message",
        employee.getString("name") + " solicita corregir un fichaje.",
      );
      notification.set("kind", "request");
      notification.set("link", "/registros");
      notification.set("read", false);
      notification.set("createdBy", employee.id);
      e.app.save(notification);
    }
  } catch (error) {
    console.log("No se pudo avisar de la corrección:", error);
  }
  e.next();
}, "correction_requests");

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.");
  const role = e.auth.getString("role");
  if (role !== "admin" && role !== "manager") {
    throw new ForbiddenError("No tienes permisos para resolver correcciones.");
  }

  const original = e.record.original();
  const status = e.record.getString("status");
  if (
    original.getString("status") !== "pending" ||
    (status !== "approved" && status !== "rejected")
  ) {
    throw new BadRequestError("La resolución solicitada no es válida.");
  }
  for (const field of [
    "organization",
    "employee",
    "workEvent",
    "requestedKind",
    "requestedOccurredAt",
    "reason",
  ]) {
    e.record.set(field, original.get(field));
  }
  e.record.set("resolvedBy", e.auth.id);
  e.record.set("resolvedAt", new Date().toISOString());
  e.next();
}, "correction_requests");

onRecordAfterUpdateSuccess((e) => {
  const original = e.record.original();
  if (original.getString("status") !== "pending") return e.next();

  try {
    if (e.record.getString("status") === "approved") {
      const events = e.app.findRecordsByFilter(
        "work_events",
        "employee = {:employee} && kind != 'correction'",
        "-occurredAt",
        1,
        0,
        { employee: e.record.getString("employee") },
      );
      const previousHash = require(
        `${__hooks}/timesheet_helpers.js`,
      ).integrityTipHash(e.app, e.record.getString("employee"));
      const requestId = "correction-request-" + e.record.id;
      const recordedAt = new Date().toISOString();
      const collection = e.app.findCollectionByNameOrId("work_events");
      const correction = new Record(collection);
      correction.set("employee", e.record.getString("employee"));
      correction.set("organization", e.record.getString("organization"));
      correction.set("kind", "correction");
      correction.set("correctedKind", e.record.getString("requestedKind"));
      correction.set("occurredAt", e.record.getString("requestedOccurredAt"));
      correction.set("timezone", $os.getenv("PB_TIMEZONE") || "Europe/Madrid");
      correction.set("source", "admin");
      correction.set(
        "note",
        e.record.getString("reason") +
          (e.record.getString("resolutionNote")
            ? " · " + e.record.getString("resolutionNote")
            : ""),
      );
      correction.set("createdBy", e.record.getString("resolvedBy"));
      correction.set("corrects", e.record.getString("workEvent"));
      correction.set("previousHash", previousHash);
      correction.set("clientRequestId", requestId);
      correction.set("recordedAt", recordedAt);
      correction.set("adjustmentSeconds", 0);
      correction.set("adjustmentReason", "");
      correction.set("integrityVersion", "v2");
      correction.set(
        "integrityHash",
        $security.sha256(
          [
            "v2",
            e.record.getString("employee"),
            e.record.getString("organization"),
            "correction",
            e.record.getString("requestedKind"),
            e.record.getString("workEvent"),
            new Date(
              e.record.getString("requestedOccurredAt"),
            ).toISOString(),
            new Date(recordedAt).toISOString(),
            0,
            "",
            requestId,
            previousHash,
          ].join("|"),
        ),
      );
      e.app.save(correction);
    }

    const employee = e.app.findRecordById(
      "users",
      e.record.getString("employee"),
    );
    const approved = e.record.getString("status") === "approved";
    const collection = e.app.findCollectionByNameOrId("notifications");
    const notification = new Record(collection);
    notification.set("organization", e.record.getString("organization"));
    notification.set("recipient", employee.id);
    notification.set(
      "title",
      approved ? "Corrección aprobada" : "Corrección rechazada",
    );
    notification.set(
      "message",
      e.record.getString("resolutionNote") ||
        (approved
          ? "El fichaje se ha corregido sin modificar el registro original."
          : "La solicitud de corrección no ha sido aceptada."),
    );
    notification.set("kind", approved ? "success" : "warning");
    notification.set("link", "/registros");
    notification.set("read", false);
    notification.set("createdBy", e.record.getString("resolvedBy"));
    e.app.save(notification);
  } catch (error) {
    console.log("No se pudo aplicar o notificar la corrección:", error);
  }
  e.next();
}, "correction_requests");

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.");
  const role = e.auth.getString("role");
  if (role !== "admin" && role !== "manager") {
    throw new ForbiddenError("No tienes permisos para crear horarios.");
  }
  const employee = e.app.findRecordById(
    "users",
    e.record.getString("employee"),
  );
  if (employee.getString("organization") !== e.auth.getString("organization")) {
    throw new ForbiddenError("La persona no pertenece a tu empresa.");
  }
  const start = e.record.getString("startTime");
  const end = e.record.getString("endTime");
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!timePattern.test(start) || !timePattern.test(end) || start >= end) {
    throw new BadRequestError("El horario de inicio y fin no es válido.");
  }
  e.record.set("organization", e.auth.getString("organization"));
  e.record.set("createdBy", e.auth.id);
  e.next();
}, "work_schedules");

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.");
  const role = e.auth.getString("role");
  if (role !== "admin" && role !== "manager") {
    throw new ForbiddenError("No tienes permisos para modificar horarios.");
  }
  const original = e.record.original();
  e.record.set("organization", original.getString("organization"));
  e.record.set("createdBy", original.getString("createdBy"));
  const employee = e.app.findRecordById(
    "users",
    e.record.getString("employee"),
  );
  if (employee.getString("organization") !== e.auth.getString("organization")) {
    throw new ForbiddenError("La persona no pertenece a tu empresa.");
  }
  const start = e.record.getString("startTime");
  const end = e.record.getString("endTime");
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!timePattern.test(start) || !timePattern.test(end) || start >= end) {
    throw new BadRequestError("El horario de inicio y fin no es válido.");
  }
  e.next();
}, "work_schedules");

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth || e.record.getString("recipient") !== e.auth.id) {
    throw new ForbiddenError("No puedes modificar esta notificación.");
  }
  const original = e.record.original();
  for (const field of [
    "organization",
    "recipient",
    "title",
    "message",
    "kind",
    "link",
    "createdBy",
  ]) {
    e.record.set(field, original.get(field));
  }
  e.next();
}, "notifications");

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.");
  const role = e.auth.getString("role");
  if (role !== "admin" && role !== "manager") {
    throw new ForbiddenError("No tienes permisos para publicar avisos.");
  }
  e.record.set("organization", e.auth.getString("organization"));
  e.record.set("createdBy", e.auth.id);
  e.record.set("publishedAt", new Date().toISOString());
  e.next();
}, "announcements");

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next();
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.");
  const role = e.auth.getString("role");
  if (role !== "admin" && role !== "manager") {
    throw new ForbiddenError("No tienes permisos para modificar avisos.");
  }
  const original = e.record.original();
  e.record.set("organization", original.getString("organization"));
  e.record.set("createdBy", original.getString("createdBy"));
  e.next();
}, "announcements");

onRecordAfterCreateSuccess((e) => {
  try {
    const audience = e.record.getString("audience");
    let roleFilter = "";
    if (audience === "employees") {
      roleFilter = " && role = 'employee'";
    } else if (audience === "managers") {
      roleFilter = " && (role = 'admin' || role = 'manager')";
    }
    const recipients = e.app.findRecordsByFilter(
      "users",
      "organization = {:organization} && active = true" + roleFilter,
      "name",
      500,
      0,
      { organization: e.record.getString("organization") },
    );
    const collection = e.app.findCollectionByNameOrId("notifications");
    for (const recipient of recipients) {
      const notification = new Record(collection);
      notification.set("organization", e.record.getString("organization"));
      notification.set("recipient", recipient.id);
      notification.set("title", e.record.getString("title"));
      notification.set("message", e.record.getString("body").slice(0, 500));
      notification.set("kind", "info");
      notification.set("link", "/avisos");
      notification.set("read", false);
      notification.set("createdBy", e.record.getString("createdBy"));
      e.app.save(notification);

      if (e.record.getBool("sendEmail") && e.app.settings().smtp.enabled) {
        try {
          e.app.newMailClient().send(
            new MailerMessage({
              from: {
                address: e.app.settings().meta.senderAddress,
                name: e.app.settings().meta.senderName,
              },
              to: [{ address: recipient.email() }],
              subject: e.record.getString("title"),
              text: e.record.getString("body"),
            }),
          );
        } catch (mailError) {
          console.log("No se pudo enviar un aviso por email:", mailError);
        }
      }
    }
  } catch (error) {
    console.log("No se pudo distribuir el aviso:", error);
  }
  e.next();
}, "announcements");
