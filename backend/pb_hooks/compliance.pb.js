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
    return e.json(
      200,
      require(`${__hooks}/compliance_helpers.js`).privacyNotice(
        organization,
        e.auth,
      ),
    );
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
    const notice = require(
      `${__hooks}/compliance_helpers.js`,
    ).privacyNotice(organization, e.auth);
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

function ojMonthBounds(period, timezone) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || "")) {
    throw new BadRequestError("El periodo mensual no es válido.");
  }
  const start = new DateTime(period + "-01 00:00:00", timezone);
  return { start, end: start.addDate(0, 1, 0).add(-1) };
}

function ojStatementAudit(app, statement, action, actor) {
  const audit = new Record(app.findCollectionByNameOrId("audit_logs"));
  audit.set("organization", statement.getString("organization"));
  audit.set("actor", actor);
  audit.set("action", action);
  audit.set("entityType", "monthly_time_statement");
  audit.set("entityId", statement.id);
  audit.set("metadata", {
    employee: statement.getString("employee"),
    period: statement.getString("period"),
    version: statement.getFloat("version"),
    integrityHash: statement.getString("integrityHash"),
  });
  audit.set("occurredAt", new Date().toISOString());
  app.save(audit);
}

function ojMonthlyStatementData(app, organization, employee, period) {
  const helper = require(`${__hooks}/timesheet_helpers.js`);
  const timezone = organization.getString("timezone") || "Europe/Madrid";
  const bounds = ojMonthBounds(period, timezone);
  if (period >= helper.today(timezone).slice(0, 7)) {
    throw new BadRequestError(
      "Sólo se pueden cerrar meses completamente terminados.",
    );
  }

  const employmentType = employee.getString("employmentType");
  if (employmentType !== "full_time" && employmentType !== "part_time") {
    throw new BadRequestError(
      "Clasifica primero el contrato como tiempo completo o parcial.",
    );
  }
  if (employee.getFloat("contractedWeeklyMinutes") <= 0) {
    throw new BadRequestError(
      "Indica los minutos contratados por semana antes de cerrar el mes.",
    );
  }
  const scheduleMode = helper.scheduleMode(employee);

  const pending = app.findRecordsByFilter(
    "manual_time_requests",
    "employee = {:employee} && status = 'pending' && workDate >= {:start} && workDate <= {:end}",
    "workDate",
    1,
    0,
    {
      employee: employee.id,
      start: bounds.start.string(),
      end: bounds.end.string(),
    },
  );
  if (pending.length) {
    throw new BadRequestError(
      "Resuelve las jornadas o correcciones pendientes antes de cerrar el mes.",
    );
  }

  const events = helper.effectiveEvents(
    app,
    employee.id,
    bounds.end.addDate(0, 0, 1).string(),
  );
  const spans = helper.workSpans(events, bounds.end.unix());
  const anomalies = helper.sequenceAnomalyDates(events, timezone);
  const schedules = app.findRecordsByFilter(
    "work_schedules",
    "employee = {:employee}",
    "-validFrom,-created",
    500,
    0,
    { employee: employee.id },
  );
  if (scheduleMode === "scheduled") {
    let applicableSchedule = false;
    for (
      let cursor = bounds.start;
      cursor.unix() <= bounds.end.unix() && !applicableSchedule;
      cursor = cursor.addDate(0, 0, 1)
    ) {
      const date = cursor
        .time()
        .in(new Timezone(timezone))
        .format("2006-01-02");
      const weekday = cursor.time().in(new Timezone(timezone)).weekday();
      for (const candidate of schedules) {
        if (!helper.scheduleAppliesOnDate(candidate, date, timezone)) continue;
        const weekdays = Array.from(candidate.get("weekdays") || []);
        if (weekdays.indexOf(Number(weekday)) >= 0) {
          applicableSchedule = true;
          break;
        }
      }
    }
    if (!applicableSchedule) {
      throw new BadRequestError(
        `No existe una planificación aplicable a ${period}. Configura el horario del periodo o activa el cómputo semanal flexible antes de cerrarlo.`,
      );
    }
  }

  const holidays = app.findRecordsByFilter(
    "public_holidays",
    "organization = {:organization} && date >= {:start} && date <= {:end}",
    "date",
    500,
    0,
    {
      organization: organization.id,
      start: bounds.start.string(),
      end: bounds.end.string(),
    },
  );
  const holidayByDate = {};
  for (const holiday of holidays) {
    holidayByDate[helper.localKey(holiday.getString("date"), timezone)] = true;
  }
  const leaves = app.findRecordsByFilter(
    "leave_requests",
    "employee = {:employee} && status = 'approved' && startDate <= {:end} && endDate >= {:start}",
    "startDate",
    500,
    0,
    {
      employee: employee.id,
      start: bounds.start.string(),
      end: bounds.end.string(),
    },
  );

  const dailyRecords = [];
  let contractedMinutes = 0;
  let totalMinutes = 0;
  let ordinaryMinutes = 0;
  let complementaryMinutes = 0;
  let overtimeMinutes = 0;
  for (
    let cursor = bounds.start;
    cursor.unix() <= bounds.end.unix();
    cursor = cursor.addDate(0, 0, 1)
  ) {
    const next = cursor.addDate(0, 0, 1);
    const date = cursor
      .time()
      .in(new Timezone(timezone))
      .format("2006-01-02");
    if (anomalies[date]) {
      throw new BadRequestError(
        "Corrige las secuencias incompletas o anómalas antes de cerrar el mes.",
      );
    }

    let worked = 0;
    for (const span of spans.spans) {
      const overlapStart = Math.max(span.startUnix, cursor.unix());
      const overlapEnd = Math.min(span.endUnix, next.unix());
      if (overlapEnd > overlapStart) {
        worked += Math.round((overlapEnd - overlapStart) / 60);
      }
    }

    const weekday = cursor.time().in(new Timezone(timezone)).weekday();
    let planned = 0;
    if (scheduleMode === "weekly_flexible") {
      planned = helper.flexibleMinutesForWeekday(employee, weekday);
    } else {
      let schedule = null;
      for (const candidate of schedules) {
        if (!helper.scheduleAppliesOnDate(candidate, date, timezone)) continue;
        const weekdays = Array.from(candidate.get("weekdays") || []);
        if (weekdays.indexOf(Number(weekday)) >= 0) {
          schedule = candidate;
          break;
        }
      }
      planned = schedule ? helper.scheduleMinutes(schedule) : 0;
    }
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
      if (leave.getString("dayPart") === "full") fullAbsence = true;
      else halfAbsences += 1;
    }
    if (holidayByDate[date] || fullAbsence) planned = 0;
    else if (halfAbsences) planned = Math.round(planned / 2);

    let ordinary = Math.min(worked, planned);
    if (scheduleMode === "weekly_flexible") {
      const weekStart = new DateTime(
        helper.mondayKey(date) + " 00:00:00",
        timezone,
      );
      let workedBefore = 0;
      for (const span of spans.spans) {
        const overlapStart = Math.max(span.startUnix, weekStart.unix());
        const overlapEnd = Math.min(span.endUnix, cursor.unix());
        if (overlapEnd > overlapStart) {
          workedBefore += Math.round((overlapEnd - overlapStart) / 60);
        }
      }
      ordinary = Math.min(
        worked,
        Math.max(
          0,
          Math.round(employee.getFloat("contractedWeeklyMinutes")) -
            workedBefore,
        ),
      );
    }
    const excess = Math.max(0, worked - ordinary);
    let complementary = 0;
    let overtime = 0;
    if (employmentType === "part_time") {
      if (excess && !employee.getBool("complementaryHoursAgreement")) {
        throw new BadRequestError(
          "Hay horas sobre la jornada parcial sin pacto de horas complementarias; revísalas antes del cierre.",
        );
      }
      complementary = excess;
    } else {
      overtime = excess;
    }

    const dayEvents = events
      .filter(
        (event) =>
          event.occurredUnix >= cursor.unix() &&
          event.occurredUnix < next.unix(),
      )
      .map((event) => ({
        id: event.id,
        kind: event.kind,
        occurredAt: event.occurredAt,
        integrityHash: event.integrityHash,
      }));
    contractedMinutes += planned;
    totalMinutes += worked;
    ordinaryMinutes += ordinary;
    complementaryMinutes += complementary;
    overtimeMinutes += overtime;
    dailyRecords.push({
      date,
      plannedMinutes: planned,
      workedMinutes: worked,
      ordinaryMinutes: ordinary,
      complementaryMinutes: complementary,
      overtimeMinutes: overtime,
      events: dayEvents,
    });
  }

  return {
    employmentType,
    scheduleMode,
    contractedMinutes,
    totalMinutes,
    ordinaryMinutes,
    complementaryMinutes,
    overtimeMinutes,
    dailyRecords,
  };
}

routerAdd(
  "GET",
  "/api/openjornada/work-events/export",
  (e) => {
    const data = require(
      `${__hooks}/compliance_helpers.js`,
    ).workEventExportData(e.app, e.auth, e.requestInfo().query);
    return e.json(200, data);
  },
  $apis.requireAuth("users"),
);

routerAdd(
  "POST",
  "/api/openjornada/monthly-statements/close",
  (e) => {
    const role = e.auth.getString("role");
    if (role !== "admin" && role !== "manager") {
      throw new ForbiddenError("No tienes permisos para cerrar periodos.");
    }
    const body = e.requestInfo().body;
    const employee = e.app.findRecordById("users", String(body.employee || ""));
    const organization = e.app.findRecordById(
      "organizations",
      e.auth.getString("organization"),
    );
    if (employee.getString("organization") !== organization.id) {
      throw new ForbiddenError("La persona no pertenece a tu empresa.");
    }
    const period = String(body.period || "");
    const data = require(
      `${__hooks}/compliance_helpers.js`,
    ).monthlyStatementData(
      e.app,
      organization,
      employee,
      period,
    );

    const previous = e.app.findRecordsByFilter(
      "monthly_time_statements",
      "employee = {:employee} && period = {:period}",
      "-version",
      1,
      0,
      { employee: employee.id, period },
    );
    const previousStatement = previous.length ? previous[0] : null;
    const previousHash = previousStatement
      ? previousStatement.getString("integrityHash")
      : "";
    const version = previousStatement
      ? previousStatement.getFloat("version") + 1
      : 1;
    const generatedAt = new Date().toISOString();
    const hashPayload = [
      organization.id,
      employee.id,
      period,
      version,
      data.employmentType,
      data.contractedMinutes,
      data.ordinaryMinutes,
      data.complementaryMinutes,
      data.overtimeMinutes,
      data.totalMinutes,
      JSON.stringify(data.dailyRecords),
      previousHash,
    ].join("|");

    const statement = new Record(
      e.app.findCollectionByNameOrId("monthly_time_statements"),
    );
    statement.set("organization", organization.id);
    statement.set("employee", employee.id);
    statement.set("period", period);
    statement.set("version", version);
    statement.set("employmentType", data.employmentType);
    statement.set("contractedMinutes", data.contractedMinutes);
    statement.set("ordinaryMinutes", data.ordinaryMinutes);
    statement.set("complementaryMinutes", data.complementaryMinutes);
    statement.set("overtimeMinutes", data.overtimeMinutes);
    statement.set("totalMinutes", data.totalMinutes);
    statement.set("dailyRecords", data.dailyRecords);
    statement.set("generatedBy", e.auth.id);
    statement.set("generatedAt", generatedAt);
    statement.set("deliveredAt", generatedAt);
    statement.set("previousStatement", previousStatement?.id || "");
    statement.set("previousHash", previousHash);
    statement.set("integrityHash", $security.sha256(hashPayload));
    e.app.save(statement);
    require(`${__hooks}/compliance_helpers.js`).statementAudit(
      e.app,
      statement,
      "monthly_time_statement.closed",
      e.auth.id,
    );

    try {
      const notification = new Record(
        e.app.findCollectionByNameOrId("notifications"),
      );
      notification.set("organization", organization.id);
      notification.set("recipient", employee.id);
      notification.set("title", "Resumen mensual disponible");
      notification.set(
        "message",
        "Ya puedes consultar el resumen de jornada de " + period + ".",
      );
      notification.set("kind", "success");
      notification.set("link", "/resumenes");
      notification.set("read", false);
      notification.set("createdBy", e.auth.id);
      e.app.save(notification);
    } catch (_) {}

    return e.json(201, {
      id: statement.id,
      period,
      version,
      integrityHash: statement.getString("integrityHash"),
    });
  },
  $apis.requireAuth("users"),
);

routerAdd(
  "POST",
  "/api/openjornada/monthly-statements/{id}/acknowledge",
  (e) => {
    const statement = e.app.findRecordById(
      "monthly_time_statements",
      e.request.pathValue("id"),
    );
    if (
      statement.getString("organization") !==
        e.auth.getString("organization") ||
      statement.getString("employee") !== e.auth.id
    ) {
      throw new ForbiddenError(
        "Sólo puedes confirmar la recepción de tu propio resumen.",
      );
    }
    try {
      const existing = e.app.findFirstRecordByFilter(
        "monthly_statement_acknowledgements",
        "statement = {:statement} && user = {:user}",
        { statement: statement.id, user: e.auth.id },
      );
      return e.json(200, {
        id: existing.id,
        acknowledgedAt: existing.getString("acknowledgedAt"),
      });
    } catch (_) {}

    const acknowledgedAt = new Date().toISOString();
    const acknowledgement = new Record(
      e.app.findCollectionByNameOrId(
        "monthly_statement_acknowledgements",
      ),
    );
    acknowledgement.set("organization", statement.getString("organization"));
    acknowledgement.set("statement", statement.id);
    acknowledgement.set("user", e.auth.id);
    acknowledgement.set("acknowledgedAt", acknowledgedAt);
    e.app.save(acknowledgement);
    require(`${__hooks}/compliance_helpers.js`).statementAudit(
      e.app,
      statement,
      "monthly_time_statement.acknowledged",
      e.auth.id,
    );
    return e.json(201, {
      id: acknowledgement.id,
      acknowledgedAt,
    });
  },
  $apis.requireAuth("users"),
);
