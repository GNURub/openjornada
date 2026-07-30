routerAdd(
  "POST",
  "/api/openjornada/work-schedules/bulk",
  (e) => {
    const role = e.auth.getString("role");
    if (role !== "admin" && role !== "manager") {
      throw new ForbiddenError("No tienes permisos para crear horarios.");
    }

    const body = new DynamicModel({
      employeeIds: [],
      name: "",
      validFrom: "",
      validUntil: "",
      weekdays: [],
      startTime: "",
      endTime: "",
      breakMinutes: 0,
    });
    e.bindBody(body);

    const employeeIds = Array.from(
      new Set(
        Array.from(body.employeeIds || [])
          .map((id) => String(id || "").trim())
          .filter(Boolean),
      ),
    );
    if (employeeIds.length === 0 || employeeIds.length > 200) {
      throw new BadRequestError(
        "Selecciona entre una y doscientas personas.",
      );
    }

    const name = String(body.name || "").trim();
    if (name.length === 0 || name.length > 120) {
      throw new BadRequestError("El nombre del horario no es válido.");
    }
    const validFrom = String(body.validFrom || "");
    const validUntil = String(body.validUntil || "");
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (
      !datePattern.test(validFrom) ||
      (validUntil &&
        (!datePattern.test(validUntil) || validUntil < validFrom))
    ) {
      throw new BadRequestError("La vigencia del horario no es válida.");
    }

    const weekdays = Array.from(
      new Set(Array.from(body.weekdays || []).map(Number)),
    ).sort();
    if (
      weekdays.length === 0 ||
      weekdays.some(
        (weekday) =>
          !Number.isInteger(weekday) || weekday < 0 || weekday > 6,
      )
    ) {
      throw new BadRequestError("Selecciona al menos un día de trabajo.");
    }

    const startTime = String(body.startTime || "");
    const endTime = String(body.endTime || "");
    const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (
      !timePattern.test(startTime) ||
      !timePattern.test(endTime) ||
      startTime >= endTime
    ) {
      throw new BadRequestError("El horario de inicio y fin no es válido.");
    }
    const breakMinutes = Number(body.breakMinutes);
    if (
      !Number.isFinite(breakMinutes) ||
      breakMinutes < 0 ||
      breakMinutes > 240
    ) {
      throw new BadRequestError("La pausa prevista no es válida.");
    }

    const organizationId = e.auth.getString("organization");
    const organization = e.app.findRecordById(
      "organizations",
      organizationId,
    );
    const timezone =
      organization.getString("timezone") || "Europe/Madrid";
    const validFromAt = new DateTime(
      validFrom + " 00:00:00",
      timezone,
    ).string();
    const validUntilAt = validUntil
      ? new DateTime(validUntil + " 23:59:59", timezone).string()
      : "";

    const created = [];
    e.app.runInTransaction((txApp) => {
      const collection = txApp.findCollectionByNameOrId(
        "work_schedules",
      );
      for (const employeeId of employeeIds) {
        const employee = txApp.findRecordById("users", employeeId);
        if (
          employee.getString("organization") !== organizationId ||
          !employee.getBool("active")
        ) {
          throw new BadRequestError(
            "Una de las personas seleccionadas no está disponible.",
          );
        }
        const schedule = new Record(collection);
        schedule.set("organization", organizationId);
        schedule.set("employee", employee.id);
        schedule.set("name", name);
        schedule.set("validFrom", validFromAt);
        schedule.set("validUntil", validUntilAt);
        schedule.set("weekdays", weekdays);
        schedule.set("startTime", startTime);
        schedule.set("endTime", endTime);
        schedule.set("breakMinutes", breakMinutes);
        schedule.set("active", true);
        schedule.set("createdBy", e.auth.id);
        txApp.save(schedule);
        created.push(schedule.publicExport());
      }
    });

    return e.json(201, {
      items: created,
      total: created.length,
    });
  },
  $apis.requireAuth("users"),
);
