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
  const scheduleMode = helper.scheduleMode(employee)

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
    "employee = {:employee}",
    "-validFrom,-created",
    500,
    0,
    { employee: employee.id },
  )
  if (scheduleMode === "scheduled") {
    let applicableSchedule = false
    for (
      let cursor = bounds.start;
      cursor.unix() < bounds.next.unix() && !applicableSchedule;
      cursor = cursor.addDate(0, 0, 1)
    ) {
      const date = cursor
        .time()
        .in(new Timezone(timezone))
        .format("2006-01-02")
      for (const candidate of schedules) {
        if (!helper.scheduleAppliesOnDate(candidate, date, timezone)) continue
        let weekdays = []
        try {
          weekdays = JSON.parse(candidate.getString("weekdays") || "[]")
        } catch (_) {}
        if (weekdays.indexOf(calendarWeekday(date)) >= 0) {
          applicableSchedule = true
          break
        }
      }
    }
    if (!applicableSchedule) {
      throw new BadRequestError(
        `No existe una planificación aplicable a ${period}. Configura el horario del periodo o activa el cómputo semanal flexible antes de cerrarlo.`,
      )
    }
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

    let planned = 0
    if (scheduleMode === "weekly_flexible") {
      planned = helper.flexibleMinutesForWeekday(
        employee,
        calendarWeekday(date),
      )
    } else {
      let schedule = null
      for (const candidate of schedules) {
        if (!helper.scheduleAppliesOnDate(candidate, date, timezone)) continue
        let weekdays = []
        try {
          weekdays = JSON.parse(candidate.getString("weekdays") || "[]")
        } catch (_) {}
        if (weekdays.indexOf(calendarWeekday(date)) >= 0) {
          schedule = candidate
          break
        }
      }
      planned = schedule ? helper.scheduleMinutes(schedule) : 0
    }
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

    let ordinary = Math.min(worked, planned)
    if (scheduleMode === "weekly_flexible") {
      const weekStart = new DateTime(
        helper.mondayKey(date) + " 00:00:00",
        timezone,
      )
      let workedBefore = 0
      for (const span of spans.spans) {
        const overlapStart = Math.max(span.startUnix, weekStart.unix())
        const overlapEnd = Math.min(span.endUnix, cursor.unix())
        if (overlapEnd > overlapStart) {
          workedBefore += Math.round((overlapEnd - overlapStart) / 60)
        }
      }
      ordinary = Math.min(
        worked,
        Math.max(
          0,
          Math.round(employee.getFloat("contractedWeeklyMinutes")) -
            workedBefore,
        ),
      )
    }
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
    scheduleMode,
    contractedMinutes,
    totalMinutes,
    ordinaryMinutes,
    complementaryMinutes,
    overtimeMinutes,
    dailyRecords,
  }
}

function dateVariants(value) {
  const variants = [String(value || "")]
  const parsed = new Date(value)
  if (!isNaN(parsed.getTime())) {
    const canonical = parsed.toISOString()
    if (variants.indexOf(canonical) < 0) variants.push(canonical)
  }
  return variants
}

function eventHashMatches(record) {
  const employee = record.getString("employee")
  const organization = record.getString("organization")
  const kind = record.getString("kind")
  const occurredAt = record.getString("occurredAt")
  const requestId = record.getString("clientRequestId")
  const previousHash = record.getString("previousHash")
  const expected = record.getString("integrityHash")
  const source = record.getString("source")
  const manualRequest = record.getString("manualRequest")
  const candidates = []

  if (record.getString("integrityVersion") === "v3") {
    for (const occurred of dateVariants(occurredAt)) {
      for (const recorded of dateVariants(record.getString("recordedAt"))) {
        for (const captured of dateVariants(record.getString("deviceCapturedAt"))) {
          for (const synced of dateVariants(record.getString("clockSyncedAt"))) {
            candidates.push([
              "v3",
              employee,
              organization,
              kind,
              record.getString("correctedKind"),
              record.getString("corrects"),
              occurred,
              recorded,
              record.getFloat("adjustmentSeconds"),
              record.getString("adjustmentReason"),
              requestId,
              previousHash,
              record.getString("terminal"),
              captured,
              synced,
              record.getFloat("deviceSequence"),
              record.getBool("queuedOffline"),
            ])
          }
        }
      }
    }
  } else if (record.getString("integrityVersion") === "v2") {
    for (const occurred of dateVariants(occurredAt)) {
      for (const recorded of dateVariants(record.getString("recordedAt"))) {
        candidates.push([
          "v2",
          employee,
          organization,
          kind,
          record.getString("correctedKind"),
          record.getString("corrects"),
          occurred,
          recorded,
          record.getFloat("adjustmentSeconds"),
          record.getString("adjustmentReason"),
          requestId,
          previousHash,
        ])
      }
    }
  } else if (source === "manual" && record.getBool("voidsTarget")) {
    for (const occurred of dateVariants(occurredAt)) {
      candidates.push([
        employee,
        organization,
        "correction",
        "void",
        record.getString("corrects"),
        occurred,
        requestId,
        previousHash,
      ])
    }
  } else if (source === "manual" && manualRequest) {
    const index = Number(requestId.slice(requestId.lastIndexOf("-") + 1))
    for (const occurred of dateVariants(occurredAt)) {
      candidates.push([
        employee,
        organization,
        kind,
        occurred,
        manualRequest,
        index,
        previousHash,
      ])
    }
  } else {
    for (const occurred of dateVariants(occurredAt)) {
      candidates.push([
        employee,
        organization,
        kind,
        record.getString("correctedKind"),
        record.getString("corrects"),
        occurred,
        requestId,
        previousHash,
      ])
    }
  }

  return candidates.some(
    (parts) => $security.sha256(parts.join("|")) === expected,
  )
}

function exportedEvent(record) {
  return {
    id: record.id,
    employee: record.getString("employee"),
    organization: record.getString("organization"),
    kind: record.getString("kind"),
    correctedKind: record.getString("correctedKind"),
    corrects: record.getString("corrects"),
    occurredAt: record.getString("occurredAt"),
    recordedAt: record.getString("recordedAt"),
    adjustmentSeconds: record.getFloat("adjustmentSeconds"),
    adjustmentReason: record.getString("adjustmentReason"),
    timezone: record.getString("timezone"),
    source: record.getString("source"),
    note: record.getString("note"),
    createdBy: record.getString("createdBy"),
    manualRequest: record.getString("manualRequest"),
    voidsTarget: record.getBool("voidsTarget"),
    clientRequestId: record.getString("clientRequestId"),
    previousHash: record.getString("previousHash"),
    integrityHash: record.getString("integrityHash"),
    integrityVersion: record.getString("integrityVersion") || "v1",
    terminal: record.getString("terminal"),
    deviceCapturedAt: record.getString("deviceCapturedAt"),
    clockSyncedAt: record.getString("clockSyncedAt"),
    deviceSequence: record.getFloat("deviceSequence"),
    queuedOffline: record.getBool("queuedOffline"),
    created: record.getString("created"),
  }
}

function workEventExportData(app, auth, query) {
  const from = String(query.from || "")
  const to = String(query.to || "")
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    from > to
  ) {
    throw new BadRequestError("El intervalo de exportación no es válido.")
  }

  const organization = app.findRecordById(
    "organizations",
    auth.getString("organization"),
  )
  const timezone = organization.getString("timezone") || "Europe/Madrid"
  const startAt = new DateTime(from + " 00:00:00", timezone)
  const nextAt = new DateTime(to + " 00:00:00", timezone).addDate(0, 0, 1)
  if ((nextAt.unix() - startAt.unix()) / 86400 > 367) {
    throw new BadRequestError("La exportación no puede abarcar más de un año.")
  }

  const role = auth.getString("role")
  let employeeId = String(query.employee || auth.id)
  if (
    role !== "admin" &&
    role !== "manager" &&
    role !== "representative"
  ) {
    employeeId = auth.id
  }
  const employee = app.findRecordById("users", employeeId)
  if (employee.getString("organization") !== organization.id) {
    throw new ForbiddenError("La persona no pertenece a tu empresa.")
  }

  const allRecords = app.findRecordsByFilter(
    "work_events",
    "employee = {:employee}",
    "created",
    50000,
    0,
    { employee: employee.id },
  )
  const selectedRecords = allRecords.filter((record) => {
    const occurred = new DateTime(record.getString("occurredAt")).unix()
    return occurred >= startAt.unix() && occurred < nextAt.unix()
  })

  const hashes = {}
  const referenced = {}
  const errors = []
  let cryptographicallyVerified = 0
  for (const record of allRecords) {
    const hash = record.getString("integrityHash")
    if (!hash || hashes[hash]) {
      errors.push({
        eventId: record.id,
        code: hash ? "duplicate_hash" : "missing_hash",
      })
    } else {
      hashes[hash] = record.id
    }
    const previousHash = record.getString("previousHash")
    if (previousHash) referenced[previousHash] = true
    if (eventHashMatches(record)) {
      cryptographicallyVerified += 1
    } else {
      errors.push({ eventId: record.id, code: "hash_mismatch" })
    }
  }
  for (const record of allRecords) {
    const previousHash = record.getString("previousHash")
    if (previousHash && !hashes[previousHash]) {
      errors.push({ eventId: record.id, code: "missing_predecessor" })
    }
  }
  const tips = allRecords.filter(
    (record) => !referenced[record.getString("integrityHash")],
  )
  const roots = allRecords.filter((record) => !record.getString("previousHash"))
  if (allRecords.length && roots.length !== 1) {
    errors.push({ code: "invalid_root_count", count: roots.length })
  }
  if (allRecords.length && tips.length !== 1) {
    errors.push({ code: "invalid_tip_count", count: tips.length })
  }

  return {
    schemaVersion: "openjornada-work-events-export-v1",
    generatedAt: new Date().toISOString(),
    organization: {
      id: organization.id,
      name: organization.getString("name"),
      taxId: organization.getString("taxId"),
      timezone,
    },
    employee: {
      id: employee.id,
      name: employee.getString("name"),
      employeeCode: employee.getString("employeeCode"),
    },
    range: { from, to },
    verification: {
      status: errors.length ? "invalid" : "valid",
      totalChainEvents: allRecords.length,
      exportedEvents: selectedRecords.length,
      cryptographicallyVerified,
      roots: roots.length,
      tips: tips.length,
      errors,
    },
    events: selectedRecords.map(exportedEvent),
  }
}

module.exports = {
  monthlyStatementData,
  privacyNotice,
  statementAudit,
  workEventExportData,
}
