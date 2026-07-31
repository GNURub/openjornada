function itemValue(item, key) {
  if (!item) return null
  return typeof item.get === "function" ? item.get(key) : item[key]
}

function timeMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || "")) return -1
  const parts = value.split(":")
  const hours = Number(parts[0])
  const minutes = Number(parts[1])
  if (hours > 23 || minutes > 59) return -1
  return hours * 60 + minutes
}

function localKey(value, timezone) {
  return new DateTime(value)
    .time()
    .in(new Timezone(timezone))
    .format("2006-01-02")
}

function today(timezone) {
  return new DateTime()
    .time()
    .in(new Timezone(timezone))
    .format("2006-01-02")
}

function normalizeIntervals(
  app,
  workDate,
  timezone,
  rawIntervals,
  organizationId,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate || "")) {
    throw new BadRequestError("La fecha de la jornada no es válida.")
  }
  const companyToday = today(timezone)
  if (workDate > companyToday) {
    throw new BadRequestError("No se pueden registrar jornadas futuras.")
  }
  const source = Array.from(rawIntervals || [])
  if (source.length === 0 || source.length > 24) {
    throw new BadRequestError("Añade entre uno y veinticuatro tramos.")
  }

  const timezoneLocation = new Timezone(timezone)
  const normalized = []
  for (const item of source) {
    const kind = String(itemValue(item, "kind") || "")
    const start = String(itemValue(item, "start") || "")
    const end = String(itemValue(item, "end") || "")
    const startNextDay = Boolean(itemValue(item, "startNextDay"))
    const startMinutes = timeMinutes(start)
    const endMinutes = timeMinutes(end)
    if (
      (kind !== "work" && kind !== "break") ||
      startMinutes < 0 ||
      endMinutes < 0
    ) {
      throw new BadRequestError("Hay un tramo de jornada no válido.")
    }

    const startOffset = startNextDay ? 1 : 0
    const endOffset = startOffset + (endMinutes < startMinutes ? 1 : 0)
    if (endOffset > 1) {
      throw new BadRequestError(
        "Un tramo no puede terminar dos días después de la fecha seleccionada.",
      )
    }
    const startAt = new DateTime(
      workDate + " " + start + ":00",
      timezone,
    ).addDate(0, 0, startOffset)
    const endAt = new DateTime(
      workDate + " " + end + ":00",
      timezone,
    ).addDate(0, 0, endOffset)
    const expectedStartDate = new DateTime(
      workDate + " 00:00:00",
      timezone,
    )
      .addDate(0, 0, startOffset)
      .time()
      .in(timezoneLocation)
      .format("2006-01-02")
    const expectedEndDate = new DateTime(
      workDate + " 00:00:00",
      timezone,
    )
      .addDate(0, 0, endOffset)
      .time()
      .in(timezoneLocation)
      .format("2006-01-02")
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
      )
    }

    const durationMinutes = Math.round(
      (endAt.unix() - startAt.unix()) / 60,
    )
    if (durationMinutes <= 0 || durationMinutes > 16 * 60) {
      throw new BadRequestError(
        "Cada tramo debe durar más de cero y un máximo de dieciséis horas.",
      )
    }

    let breakTypeId = ""
    let breakTypeName = ""
    let breakPaid = false
    if (kind === "break") {
      breakTypeId = String(itemValue(item, "breakType") || "")
      let breakType
      try {
        breakType = app.findRecordById("break_types", breakTypeId)
      } catch (_) {
        throw new BadRequestError("Selecciona un tipo de pausa válido.")
      }
      if (
        breakType.getString("organization") !== organizationId ||
        !breakType.getBool("active")
      ) {
        throw new BadRequestError("El tipo de pausa no está disponible.")
      }
      breakTypeName = breakType.getString("name")
      breakPaid = breakType.getBool("paid")
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
    })
  }

  normalized.sort((left, right) => left.startUnix - right.startUnix)
  if (
    normalized[0].kind !== "work" ||
    normalized[normalized.length - 1].kind !== "work"
  ) {
    throw new BadRequestError(
      "La jornada debe comenzar y terminar con un tramo de trabajo.",
    )
  }
  let workedMinutes = 0
  for (let index = 0; index < normalized.length; index += 1) {
    const item = normalized[index]
    const previous = normalized[index - 1]
    const next = normalized[index + 1]
    if (previous && item.startUnix < previous.endUnix) {
      throw new BadRequestError("Los tramos de la jornada se solapan.")
    }
    if (item.kind === "work") {
      workedMinutes += (item.endUnix - item.startUnix) / 60
    }
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
      )
    }
  }
  if (workedMinutes > 24 * 60) {
    throw new BadRequestError(
      "La jornada no puede contener más de veinticuatro horas de trabajo.",
    )
  }
  if (normalized[normalized.length - 1].endUnix > new DateTime().unix()) {
    throw new BadRequestError(
      "No puedes registrar un tramo que todavía no ha terminado.",
    )
  }
  return normalized
}

function storedIntervals(record) {
  const rawIntervals = record.get("intervals")
  const plainIntervals = rawIntervals
    ? JSON.parse(String(rawIntervals))
    : []
  const legacy =
    record.getString("timeStorageVersion") !== "iana_v1"
  const timezone = record.getString("timezone") || "Europe/Madrid"
  const workDate = record.getString("workDate").slice(0, 10)
  return Array.from(plainIntervals).map((item) => {
    const start = String(itemValue(item, "start") || "")
    const end = String(itemValue(item, "end") || "")
    const startNextDay = Boolean(itemValue(item, "startNextDay"))
    let startAt = String(itemValue(item, "startAt") || "")
    let endAt = String(itemValue(item, "endAt") || "")
    if (legacy) {
      const startMinutes = timeMinutes(start)
      const endMinutes = timeMinutes(end)
      const startOffset = startNextDay ? 1 : 0
      const endOffset =
        startOffset + (endMinutes <= startMinutes ? 1 : 0)
      startAt = new DateTime(
        workDate + " " + start + ":00",
        timezone,
      ).addDate(0, 0, startOffset).string()
      endAt = new DateTime(
        workDate + " " + end + ":00",
        timezone,
      ).addDate(0, 0, endOffset).string()
    }
    return {
      kind: String(itemValue(item, "kind") || ""),
      start,
      end,
      startNextDay,
      startAt,
      endAt,
      startUnix: new DateTime(startAt).unix(),
      endUnix: new DateTime(endAt).unix(),
      breakType: String(itemValue(item, "breakType") || ""),
      breakTypeName: String(itemValue(item, "breakTypeName") || ""),
      breakPaid: Boolean(itemValue(item, "breakPaid")),
    }
  })
}

function effectiveOccurredAt(app, record, requestCache) {
  const occurredAt = record.getString("occurredAt")
  if (
    record.getString("source") !== "manual" ||
    !record.getString("manualRequest")
  ) {
    return occurredAt
  }
  const requestId = record.getString("manualRequest")
  if (requestCache[requestId] === undefined) {
    try {
      requestCache[requestId] = app.findRecordById(
        "manual_time_requests",
        requestId,
      )
    } catch (_) {
      requestCache[requestId] = null
    }
  }
  const request = requestCache[requestId]
  if (
    !request ||
    request.getString("timeStorageVersion") === "iana_v1"
  ) {
    return occurredAt
  }
  const wallTime = occurredAt.replace("T", " ").slice(0, 19)
  return new DateTime(
    wallTime,
    request.getString("timezone") || "Europe/Madrid",
  ).string()
}

function effectiveEvents(app, employeeId, until) {
  const requestCache = {}
  const queryUntil = new DateTime(until).addDate(0, 0, 1).string()
  const records = app.findRecordsByFilter(
    "work_events",
    "employee = {:employee} && occurredAt <= {:until}",
    "occurredAt",
    10000,
    0,
    { employee: employeeId, until: queryUntil },
  )
  const regular = {}
  const corrections = []
  for (const record of records) {
    if (record.getString("kind") === "correction") corrections.push(record)
    else {
      const occurredAt = effectiveOccurredAt(
        app,
        record,
        requestCache,
      )
      regular[record.id] = {
        id: record.id,
        kind: record.getString("kind"),
        occurredAt,
        occurredUnix: new DateTime(occurredAt).unix(),
        source: record.getString("source"),
        note: record.getString("note"),
        manualRequest: record.getString("manualRequest"),
        breakType: record.getString("breakType"),
        breakPaid: record.getBool("breakPaid"),
        created: record.getString("created"),
        integrityHash: record.getString("integrityHash"),
      }
    }
  }
  corrections.sort(
    (left, right) =>
      new DateTime(left.getString("created")).unix() -
      new DateTime(right.getString("created")).unix(),
  )
  for (const correction of corrections) {
    const targetId = correction.getString("corrects")
    if (!targetId) continue
    if (!regular[targetId]) {
      try {
        const target = app.findRecordById("work_events", targetId)
        if (target.getString("employee") !== employeeId) continue
        const occurredAt = effectiveOccurredAt(
          app,
          target,
          requestCache,
        )
        regular[targetId] = {
          id: target.id,
          kind: target.getString("kind"),
          occurredAt,
          occurredUnix: new DateTime(occurredAt).unix(),
          source: target.getString("source"),
          note: target.getString("note"),
          manualRequest: target.getString("manualRequest"),
          breakType: target.getString("breakType"),
          breakPaid: target.getBool("breakPaid"),
          created: target.getString("created"),
          integrityHash: target.getString("integrityHash"),
        }
      } catch (_) {
        continue
      }
    }
    if (correction.getBool("voidsTarget")) {
      delete regular[targetId]
      continue
    }
    regular[targetId].kind =
      correction.getString("correctedKind") || regular[targetId].kind
    regular[targetId].occurredAt = correction.getString("occurredAt")
    regular[targetId].occurredUnix = new DateTime(
      correction.getString("occurredAt"),
    ).unix()
    regular[targetId].note = correction.getString("note")
  }
  return Object.keys(regular)
    .map((id) => regular[id])
    .sort((left, right) => left.occurredUnix - right.occurredUnix)
}

function eventLocalTime(event, timezone) {
  return new DateTime(event.occurredAt)
    .time()
    .in(new Timezone(timezone))
    .format("15:04")
}

function editableDays(events, timezone) {
  const groups = {}
  let shiftDate = ""
  let workStart = null
  let breakStart = null

  const groupFor = (date) => {
    if (!groups[date]) {
      groups[date] = {
        events: [],
        eventIds: [],
        intervals: [],
        closed: false,
      }
    }
    return groups[date]
  }
  const addEvent = (date, event) => {
    const group = groupFor(date)
    if (group.eventIds.indexOf(event.id) < 0) {
      group.events.push(event)
      group.eventIds.push(event.id)
    }
  }
  const addInterval = (date, kind, start, end) => {
    const group = groupFor(date)
    group.intervals.push({
      kind,
      start: eventLocalTime(start, timezone),
      end: eventLocalTime(end, timezone),
      startNextDay: localKey(start.occurredAt, timezone) > date,
      breakType: kind === "break" ? start.breakType || "" : "",
      breakTypeName: "",
      breakPaid: kind === "break" ? Boolean(start.breakPaid) : false,
      startAt: start.occurredAt,
      endAt: end.occurredAt,
    })
  }

  for (const event of events) {
    const eventDate = localKey(event.occurredAt, timezone)
    if (event.kind === "clock_in") {
      shiftDate = eventDate
      workStart = event
      breakStart = null
      groupFor(shiftDate).closed = false
      addEvent(shiftDate, event)
      continue
    }

    const ownerDate = shiftDate || eventDate
    addEvent(ownerDate, event)
    if (event.kind === "break_start") {
      if (workStart) addInterval(ownerDate, "work", workStart, event)
      workStart = null
      breakStart = event
    } else if (event.kind === "break_end") {
      if (breakStart) addInterval(ownerDate, "break", breakStart, event)
      breakStart = null
      workStart = event
    } else if (event.kind === "clock_out") {
      if (workStart) addInterval(ownerDate, "work", workStart, event)
      groupFor(ownerDate).closed = true
      workStart = null
      breakStart = null
      shiftDate = ""
    }
  }

  return groups
}

function editableDayState(app, employeeId, workDate, timezone) {
  const until = new DateTime(
    workDate + " 00:00:00",
    timezone,
  ).addDate(0, 0, 2)
  const days = editableDays(
    effectiveEvents(app, employeeId, until.string()),
    timezone,
  )
  const day = days[workDate] || {
    events: [],
    eventIds: [],
    intervals: [],
    closed: false,
  }
  const fingerprint = $security.sha256(
    day.events
      .map((event) =>
        [
          event.id,
          event.kind,
          event.occurredAt,
          event.breakType || "",
          event.breakPaid ? "1" : "0",
          event.integrityHash || "",
        ].join("|"),
      )
      .join(";"),
  )
  return {
    eventIds: day.eventIds,
    intervals: day.intervals,
    closed: day.closed,
    fingerprint,
  }
}

function hasApprovedTimeHistory(app, employeeId, workDate, timezone) {
  const start = new DateTime(workDate + " 00:00:00", timezone)
  const end = start.addDate(0, 0, 1)
  return (
    app.findRecordsByFilter(
      "manual_time_requests",
      "employee = {:employee} && status = 'approved' && workDate >= {:start} && workDate < {:end}",
      "created",
      1,
      0,
      {
        employee: employeeId,
        start: start.string(),
        end: end.string(),
      },
    ).length > 0
  )
}

function workSpans(events, openUntil) {
  const spans = []
  let activeAt = null
  let anomaly = false
  for (const event of events) {
    if (event.kind === "clock_in") {
      if (activeAt !== null) anomaly = true
      activeAt = event.occurredUnix
    } else if (event.kind === "break_start") {
      if (activeAt === null) anomaly = true
      else if (!event.breakPaid) {
        spans.push({ startUnix: activeAt, endUnix: event.occurredUnix })
        activeAt = null
      }
    } else if (event.kind === "break_end") {
      if (activeAt === null) activeAt = event.occurredUnix
    } else if (event.kind === "clock_out") {
      if (activeAt === null) anomaly = true
      else {
        spans.push({ startUnix: activeAt, endUnix: event.occurredUnix })
        activeAt = null
      }
    }
  }
  if (activeAt !== null) {
    anomaly = true
    spans.push({
      startUnix: activeAt,
      endUnix: Math.max(activeAt, openUntil),
      open: true,
    })
  }
  return { spans, anomaly }
}

function sequenceAnomalyDates(events, timezone) {
  const dates = {}
  let state = "off"
  let lastDate = ""
  for (const event of events) {
    const date = localKey(event.occurredAt, timezone)
    lastDate = date
    if (event.kind === "clock_in") {
      if (state !== "off") dates[date] = true
      state = "work"
    } else if (event.kind === "break_start") {
      if (state !== "work") dates[date] = true
      state = event.breakPaid ? "paid_break" : "break"
    } else if (event.kind === "break_end") {
      if (state !== "break" && state !== "paid_break") dates[date] = true
      state = "work"
    } else if (event.kind === "clock_out") {
      if (state !== "work") dates[date] = true
      state = "off"
    }
  }
  if (state !== "off" && lastDate) dates[lastDate] = true
  return dates
}

function intervalsOverlap(left, right) {
  return left.startUnix < right.endUnix && left.endUnix > right.startUnix
}

function validateConflicts(
  app,
  employeeId,
  intervals,
  excludeRequestId,
  excludeEventIds,
) {
  if (intervals.length === 0) return
  const lastEnd = intervals[intervals.length - 1].endAt
  const excluded = {}
  for (const eventId of Array.from(excludeEventIds || [])) {
    excluded[String(eventId)] = true
  }
  const events = effectiveEvents(app, employeeId, lastEnd).filter(
    (event) => !excluded[event.id],
  )
  const effective = workSpans(events, new DateTime().unix())
  for (const interval of intervals) {
    for (const span of effective.spans) {
      if (intervalsOverlap(interval, span)) {
        throw new BadRequestError(
          "El tramo coincide con horas de trabajo ya registradas.",
        )
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
  )
  for (const request of pending) {
    if (request.id === excludeRequestId) continue
    for (const existing of storedIntervals(request)) {
      for (const interval of intervals) {
        if (intervalsOverlap(interval, existing)) {
          throw new BadRequestError(
            "El tramo coincide con otra solicitud pendiente.",
          )
        }
      }
    }
  }
}

function createAudit(app, request, action, actorId) {
  const collection = app.findCollectionByNameOrId("audit_logs")
  const audit = new Record(collection)
  audit.set("organization", request.getString("organization"))
  audit.set("actor", actorId)
  audit.set("action", action)
  audit.set("entityType", "manual_time_request")
  audit.set("entityId", request.id)
  audit.set("metadata", {
    employee: request.getString("employee"),
    workDate: request.getString("workDate"),
    status: request.getString("status"),
    requestType: request.getString("requestType") || "addition",
  })
  audit.set("occurredAt", new Date().toISOString())
  app.save(audit)
}

function integrityTipHash(app, employeeId) {
  const events = app.findRecordsByFilter(
    "work_events",
    "employee = {:employee}",
    "-created",
    10000,
    0,
    { employee: employeeId },
  )
  const referencedHashes = {}
  for (const event of events) {
    const previousHash = event.getString("previousHash")
    if (previousHash) referencedHashes[previousHash] = true
  }
  const tip = events.find(
    (event) => !referencedHashes[event.getString("integrityHash")],
  )
  return tip ? tip.getString("integrityHash") : ""
}

function materializeRequest(app, request, intervals) {
  let previousHash = integrityTipHash(
    app,
    request.getString("employee"),
  )

  const specifications = []
  for (let index = 0; index < intervals.length; index += 1) {
    const item = intervals[index]
    const previous = intervals[index - 1]
    const next = intervals[index + 1]
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
        })
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
        })
      }
    } else {
      specifications.push({
        kind: "break_start",
        occurredAt: item.startAt,
        breakType: item.breakType,
        breakTypeName: item.breakTypeName,
        breakPaid: item.breakPaid,
      })
      specifications.push({
        kind: "break_end",
        occurredAt: item.endAt,
        breakType: item.breakType,
        breakTypeName: item.breakTypeName,
        breakPaid: item.breakPaid,
      })
    }
  }
  specifications.sort(
    (left, right) =>
      new DateTime(left.occurredAt).unix() -
      new DateTime(right.occurredAt).unix(),
  )

  const collection = app.findCollectionByNameOrId("work_events")
  for (let index = 0; index < specifications.length; index += 1) {
    const specification = specifications[index]
    const requestId = "manual-" + request.id + "-" + index
    const event = new Record(collection)
    event.set("employee", request.getString("employee"))
    event.set("organization", request.getString("organization"))
    event.set("kind", specification.kind)
    event.set("occurredAt", specification.occurredAt)
    event.set("timezone", request.getString("timezone"))
    event.set("source", "manual")
    event.set(
      "note",
      request.getString("reason") +
        (specification.breakTypeName
          ? " · Pausa: " + specification.breakTypeName
          : ""),
    )
    event.set("createdBy", request.getString("employee"))
    event.set("manualRequest", request.id)
    event.set("breakType", specification.breakType)
    event.set("breakPaid", specification.breakPaid)
    event.set("previousHash", previousHash)
    event.set("clientRequestId", requestId)
    event.set("recordedAt", new Date().toISOString())
    event.set("adjustmentSeconds", 0)
    event.set("adjustmentReason", "")
    event.set("integrityVersion", "v1")
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
    )
    event.set("integrityHash", integrityHash)
    app.save(event)
    previousHash = integrityHash
  }
}

function materializeReplacement(app, request, intervals) {
  const employeeId = request.getString("employee")
  const timezone = request.getString("timezone")
  const workDate = localKey(request.getString("workDate"), timezone)
  const current = editableDayState(
    app,
    employeeId,
    workDate,
    timezone,
  )
  if (current.fingerprint !== request.getString("baseFingerprint")) {
    throw new BadRequestError(
      "La jornada ha cambiado desde que se solicitó la corrección.",
    )
  }

  const rawTargets = request.get("targetEvents")
  const targetEvents = Array.isArray(rawTargets)
    ? Array.from(rawTargets)
    : rawTargets
      ? [String(rawTargets)]
      : []
  const expectedTargets = [...targetEvents].sort().join(",")
  const currentTargets = [...current.eventIds].sort().join(",")
  if (expectedTargets !== currentTargets) {
    throw new BadRequestError(
      "Los fichajes de la jornada ya no coinciden con la solicitud.",
    )
  }

  let previousHash = integrityTipHash(app, employeeId)
  const collection = app.findCollectionByNameOrId("work_events")
  const actor =
    request.getString("resolvedBy") || request.getString("employee")
  for (let index = 0; index < targetEvents.length; index += 1) {
    const target = app.findRecordById("work_events", targetEvents[index])
    if (
      target.getString("employee") !== employeeId ||
      target.getString("organization") !==
        request.getString("organization")
    ) {
      throw new ForbiddenError(
        "Uno de los fichajes corregidos no pertenece a la jornada.",
      )
    }
    const requestId = "replacement-void-" + request.id + "-" + index
    const correction = new Record(collection)
    correction.set("employee", employeeId)
    correction.set("organization", request.getString("organization"))
    correction.set("kind", "correction")
    correction.set("correctedKind", "")
    correction.set("occurredAt", target.getString("occurredAt"))
    correction.set("timezone", timezone)
    correction.set("source", "manual")
    correction.set(
      "note",
      request.getString("reason") + " · Fichaje sustituido",
    )
    correction.set("createdBy", actor)
    correction.set("corrects", target.id)
    correction.set("voidsTarget", true)
    correction.set("manualRequest", request.id)
    correction.set("previousHash", previousHash)
    correction.set("clientRequestId", requestId)
    correction.set("recordedAt", new Date().toISOString())
    correction.set("adjustmentSeconds", 0)
    correction.set("adjustmentReason", "")
    correction.set("integrityVersion", "v1")
    const integrityHash = $security.sha256(
      [
        employeeId,
        request.getString("organization"),
        "correction",
        "void",
        target.id,
        target.getString("occurredAt"),
        requestId,
        previousHash,
      ].join("|"),
    )
    correction.set("integrityHash", integrityHash)
    app.save(correction)
    previousHash = integrityHash
  }

  materializeRequest(app, request, intervals)
}

function notifyRecord(app, recipient, title, message, kind, actor) {
  const collection = app.findCollectionByNameOrId("notifications")
  const notification = new Record(collection)
  notification.set("organization", recipient.getString("organization"))
  notification.set("recipient", recipient.id)
  notification.set("title", title)
  notification.set("message", message)
  notification.set("kind", kind)
  notification.set("link", "/registros")
  notification.set("read", false)
  notification.set("createdBy", actor)
  app.save(notification)
}

function sendMail(app, recipient, subject, text) {
  if (!app.settings().smtp.enabled || !recipient.email()) return
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
    )
  } catch (error) {
    console.log("No se pudo enviar un aviso de jornada manual:", error)
  }
}

function notifyPending(app, request) {
  const employee = app.findRecordById(
    "users",
    request.getString("employee"),
  )
  const supervisors = app.findRecordsByFilter(
    "users",
    "organization = {:organization} && active = true && (role = 'admin' || role = 'manager')",
    "name",
    100,
    0,
    { organization: request.getString("organization") },
  )
  const replacement = request.getString("requestType") === "replacement"
  for (const supervisor of supervisors) {
    notifyRecord(
      app,
      supervisor,
      replacement
        ? "Corrección de jornada pendiente"
        : "Jornada manual pendiente",
      employee.getString("name") +
        (replacement
          ? " ha corregido una jornada para revisar."
          : " ha añadido una jornada manual para revisar."),
      "request",
      employee.id,
    )
    sendMail(
      app,
      supervisor,
      (replacement
        ? "Corrección de jornada pendiente en "
        : "Jornada manual pendiente en ") + app.settings().meta.appName,
      employee.getString("name") +
        (replacement
          ? " ha solicitado corregir una jornada. Accede a "
          : " ha añadido una jornada manual. Accede a ") +
        app.settings().meta.appURL +
        "/registros para revisarla.",
    )
  }
}

function notifyResolution(app, request) {
  const employee = app.findRecordById(
    "users",
    request.getString("employee"),
  )
  const approved = request.getString("status") === "approved"
  const replacement = request.getString("requestType") === "replacement"
  notifyRecord(
    app,
    employee,
    approved
      ? replacement
        ? "Corrección aprobada"
        : "Jornada aprobada"
      : replacement
        ? "Corrección rechazada"
        : "Jornada rechazada",
    request.getString("resolutionNote") ||
      (approved
        ? replacement
          ? "La corrección se ha incorporado al registro."
          : "La jornada se ha incorporado al registro."
        : replacement
          ? "La corrección no ha sido aceptada."
          : "La jornada no ha sido aceptada."),
    approved ? "success" : "warning",
    request.getString("resolvedBy"),
  )
  sendMail(
    app,
    employee,
    approved
      ? replacement
        ? "Corrección de jornada aprobada"
        : "Jornada manual aprobada"
      : replacement
        ? "Corrección de jornada rechazada"
        : "Jornada manual rechazada",
    request.getString("resolutionNote") ||
      (approved
        ? replacement
          ? "La corrección se ha incorporado al registro."
          : "La jornada se ha incorporado al registro."
        : replacement
          ? "La corrección no ha sido aceptada."
          : "La jornada no ha sido aceptada."),
  )
}

function scheduleMinutes(schedule) {
  const start = timeMinutes(schedule.getString("startTime"))
  let end = timeMinutes(schedule.getString("endTime"))
  if (start < 0 || end < 0) return 0
  if (end <= start) end += 24 * 60
  return Math.max(0, end - start - schedule.getFloat("breakMinutes"))
}

function recordDateInRange(record, date, timezone, startField, endField) {
  const start = localKey(record.getString(startField), timezone)
  const rawEnd = record.getString(endField)
  const end = rawEnd ? localKey(rawEnd, timezone) : "9999-12-31"
  return start <= date && end >= date
}

function scheduleAppliesOnDate(schedule, date, timezone) {
  if (
    !recordDateInRange(
      schedule,
      date,
      timezone,
      "validFrom",
      "validUntil",
    )
  ) {
    return false
  }
  // A bounded schedule is historical evidence even after it is archived in the
  // UI. An archived open-ended schedule has no reliable end date and therefore
  // must not keep affecting future calculations.
  return schedule.getBool("active") || Boolean(schedule.getString("validUntil"))
}

module.exports = {
  createAudit,
  editableDayState,
  editableDays,
  effectiveEvents,
  hasApprovedTimeHistory,
  integrityTipHash,
  localKey,
  materializeRequest,
  materializeReplacement,
  normalizeIntervals,
  notifyPending,
  notifyResolution,
  recordDateInRange,
  scheduleAppliesOnDate,
  scheduleMinutes,
  sequenceAnomalyDates,
  storedIntervals,
  timeMinutes,
  today,
  validateConflicts,
  workSpans,
}
