function privacyNotice(organization, user) {
  const version =
    organization.getString("privacyNoticeVersion") || "2026-07-30"
  const retentionYears = Math.max(
    4,
    Math.round(organization.getFloat("retentionYears") || 4),
  )
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
  }
}

function monthBounds(period, timezone) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || "")) {
    throw new BadRequestError("El periodo mensual no es válido.")
  }
  const start = new DateTime(period + "-01 00:00:00", timezone)
  const next = start.addDate(0, 1, 0)
  return { start, next, last: next.addDate(0, 0, -1) }
}

function calendarWeekday(date) {
  const parts = date.split("-").map(Number)
  let year = parts[0]
  let month = parts[1]
  const day = parts[2]
  if (month < 3) {
    month += 12
    year -= 1
  }
  const yearOfCentury = year % 100
  const century = Math.floor(year / 100)
  const zeller =
    (day +
      Math.floor((13 * (month + 1)) / 5) +
      yearOfCentury +
      Math.floor(yearOfCentury / 4) +
      Math.floor(century / 4) +
      5 * century) %
    7
  return (zeller + 6) % 7
}

function statementAudit(app, statement, action, actor) {
  const audit = new Record(app.findCollectionByNameOrId("audit_logs"))
  audit.set("organization", statement.getString("organization"))
  audit.set("actor", actor)
  audit.set("action", action)
  audit.set("entityType", "monthly_time_statement")
  audit.set("entityId", statement.id)
  audit.set("metadata", {
    employee: statement.getString("employee"),
    period: statement.getString("period"),
    version: statement.getFloat("version"),
    integrityHash: statement.getString("integrityHash"),
  })
  audit.set("occurredAt", new Date().toISOString())
  app.save(audit)
}

function monthlyStatementData(app, organization, employee, period) {
  const helper = require(`${__hooks}/timesheet_helpers.js`)
  const timezone = organization.getString("timezone") || "Europe/Madrid"
  const bounds = monthBounds(period, timezone)
  if (period >= helper.today(timezone).slice(0, 7)) {
    throw new BadRequestError(
      "Sólo se pueden cerrar meses completamente terminados.",
    )
  }

  const employmentType = employee.getString("employmentType")
  if (employmentType !== "full_time" && employmentType !== "part_time") {
    throw new BadRequestError(
      "Clasifica primero el contrato como tiempo completo o parcial.",
    )
  }
  if (employee.getFloat("contractedWeeklyMinutes") <= 0) {
    throw new BadRequestError(
      "Indica los minutos contratados por semana antes de cerrar el mes.",
    )
  }

  const pending = app.findRecordsByFilter(
    "manual_time_requests",
    "employee = {:employee} && status = 'pending' && workDate >= {:start} && workDate < {:next}",
    "workDate",
    1,
    0,
    {
      employee: employee.id,
      start: bounds.start.string(),
      next: bounds.next.string(),
    },
  )
  if (pending.length) {
    throw new BadRequestError(
      "Resuelve las jornadas o correcciones pendientes antes de cerrar el mes.",
    )
  }

  const events = helper.effectiveEvents(
    app,
    employee.id,
    bounds.next.string(),
  )
  const spans = helper.workSpans(events, bounds.next.unix())
  const anomalies = helper.sequenceAnomalyDates(events, timezone)
  const schedules = app.findRecordsByFilter(
    "work_schedules",
    "employee = {:employee} && active = true",
    "-validFrom",
    500,
    0,
    { employee: employee.id },
  )
  if (!schedules.length) {
    throw new BadRequestError(
      "Asigna un horario laboral antes de cerrar el resumen mensual.",
    )
  }

  const holidays = app.findRecordsByFilter(
    "public_holidays",
    "organization = {:organization} && date >= {:start} && date < {:next}",
    "date",
    500,
    0,
    {
      organization: organization.id,
      start: bounds.start.string(),
      next: bounds.next.string(),
    },
  )
  const holidayByDate = {}
  for (const holiday of holidays) {
    holidayByDate[helper.localKey(holiday.getString("date"), timezone)] = true
  }
  const leaves = app.findRecordsByFilter(
    "leave_requests",
    "employee = {:employee} && status = 'approved' && startDate < {:next} && endDate >= {:start}",
    "startDate",
    500,
    0,
    {
      employee: employee.id,
      start: bounds.start.string(),
      next: bounds.next.string(),
    },
  )

  const dailyRecords = []
  let contractedMinutes = 0
  let totalMinutes = 0
  let ordinaryMinutes = 0
  let complementaryMinutes = 0
  let overtimeMinutes = 0
  for (
    let cursor = bounds.start;
    cursor.unix() < bounds.next.unix();
    cursor = cursor.addDate(0, 0, 1)
  ) {
    const next = cursor.addDate(0, 0, 1)
    const date = cursor
      .time()
      .in(new Timezone(timezone))
      .format("2006-01-02")
    if (anomalies[date]) {
      throw new BadRequestError(
        "Corrige las secuencias incompletas o anómalas antes de cerrar el mes.",
      )
    }

    let worked = 0
    for (const span of spans.spans) {
      const overlapStart = Math.max(span.startUnix, cursor.unix())
      const overlapEnd = Math.min(span.endUnix, next.unix())
      if (overlapEnd > overlapStart) {
        worked += Math.round((overlapEnd - overlapStart) / 60)
      }
    }

    let schedule = null
    for (const candidate of schedules) {
      if (
        !helper.recordDateInRange(
          candidate,
          date,
          timezone,
          "validFrom",
          "validUntil",
        )
      ) {
        continue
      }
      let weekdays = []
      try {
        weekdays = JSON.parse(candidate.getString("weekdays") || "[]")
      } catch (_) {}
      if (weekdays.indexOf(calendarWeekday(date)) >= 0) {
        schedule = candidate
        break
      }
    }
    let planned = schedule ? helper.scheduleMinutes(schedule) : 0
    let fullAbsence = false
    let halfAbsences = 0
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
        continue
      }
      if (leave.getString("dayPart") === "full") fullAbsence = true
      else halfAbsences += 1
    }
    if (holidayByDate[date] || fullAbsence) planned = 0
    else if (halfAbsences) planned = Math.round(planned / 2)

    const ordinary = Math.min(worked, planned)
    const excess = Math.max(0, worked - ordinary)
    let complementary = 0
    let overtime = 0
    if (employmentType === "part_time") {
      if (excess && !employee.getBool("complementaryHoursAgreement")) {
        throw new BadRequestError(
          "Hay horas sobre la jornada parcial sin pacto de horas complementarias; revísalas antes del cierre.",
        )
      }
      complementary = excess
    } else {
      overtime = excess
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
      }))
    contractedMinutes += planned
    totalMinutes += worked
    ordinaryMinutes += ordinary
    complementaryMinutes += complementary
    overtimeMinutes += overtime
    dailyRecords.push({
      date,
      plannedMinutes: planned,
      workedMinutes: worked,
      ordinaryMinutes: ordinary,
      complementaryMinutes: complementary,
      overtimeMinutes: overtime,
      events: dayEvents,
    })
  }

  return {
    employmentType,
    contractedMinutes,
    totalMinutes,
    ordinaryMinutes,
    complementaryMinutes,
    overtimeMinutes,
    dailyRecords,
  }
}

module.exports = {
  monthlyStatementData,
  privacyNotice,
  statementAudit,
}
