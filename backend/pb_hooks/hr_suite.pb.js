onBootstrap((e) => {
  e.next()
  try {
    e.app.findCollectionByNameOrId("leave_types")
    const seedRecord = (collectionName, lookupFilter, params, values) => {
      try {
        return e.app.findFirstRecordByFilter(collectionName, lookupFilter, params)
      } catch (_) {
        const record = new Record(e.app.findCollectionByNameOrId(collectionName))
        for (const key of Object.keys(values)) record.set(key, values[key])
        e.app.save(record)
        return record
      }
    }
    const seedOrganization = (organization) => {
      const defaults = [
        ["vacation", "Vacaciones", "#f97360", true, true, false],
        ["medical", "Consulta médica", "#38bdf8", false, true, true],
        ["personal", "Asuntos propios", "#a78bfa", true, true, false],
        ["other", "Otro permiso", "#94a3b8", false, true, false],
      ]
      const types = {}
      for (const item of defaults) {
        types[item[0]] = seedRecord(
          "leave_types",
          "organization = {:organization} && code = {:code}",
          { organization: organization.id, code: item[0] },
          {
            organization: organization.id,
            code: item[0],
            name: item[1],
            color: item[2],
            deductsBalance: item[3],
            requiresApproval: item[4],
            requiresDocument: item[5],
            active: true,
          },
        )
      }
      const categories = [
        ["Transporte", "#38bdf8", 150],
        ["Comidas", "#f59e0b", 80],
        ["Material", "#a78bfa", 500],
        ["Formación", "#10b981", 1000],
        ["Otros", "#94a3b8", 250],
      ]
      for (const item of categories) {
        seedRecord(
          "expense_categories",
          "organization = {:organization} && name = {:name}",
          { organization: organization.id, name: item[0] },
          {
            organization: organization.id,
            name: item[0],
            color: item[1],
            limitAmount: item[2],
            active: true,
          },
        )
      }
      const year = new Date().getUTCFullYear()
      const users = e.app.findRecordsByFilter(
        "users",
        "organization = {:organization} && active = true",
        "name",
        500,
        0,
        { organization: organization.id },
      )
      for (const user of users) {
        for (const item of [
          [types.vacation.id, 22],
          [types.personal.id, 2],
        ]) {
          seedRecord(
            "leave_balances",
            "employee = {:employee} && leaveType = {:leaveType} && year = {:year}",
            { employee: user.id, leaveType: item[0], year },
            {
              organization: organization.id,
              employee: user.id,
              leaveType: item[0],
              year,
              allowance: item[1],
              carriedOver: 0,
              adjustment: 0,
            },
          )
        }
      }
    }
    const organizations = e.app.findRecordsByFilter(
      "organizations",
      "id != ''",
      "name",
      200,
      0,
    )
    for (const organization of organizations) {
      seedOrganization(organization)
    }
  } catch (_) {
    // The first bootstrap can run before migrations are applied.
  }
})

onRecordAfterCreateSuccess((e) => {
  try {
    const year = new Date().getUTCFullYear()
    for (const config of [["vacation", 22], ["personal", 2]]) {
      const type = e.app.findFirstRecordByFilter(
        "leave_types",
        "organization = {:organization} && code = {:code}",
        { organization: e.record.getString("organization"), code: config[0] },
      )
      try {
        e.app.findFirstRecordByFilter(
          "leave_balances",
          "employee = {:employee} && leaveType = {:leaveType} && year = {:year}",
          { employee: e.record.id, leaveType: type.id, year },
        )
      } catch (_) {
        const balance = new Record(e.app.findCollectionByNameOrId("leave_balances"))
        balance.set("organization", e.record.getString("organization"))
        balance.set("employee", e.record.id)
        balance.set("leaveType", type.id)
        balance.set("year", year)
        balance.set("allowance", config[1])
        balance.set("carriedOver", 0)
        balance.set("adjustment", 0)
        e.app.save(balance)
      }
    }
  } catch (error) {
    console.log("No se pudieron inicializar los saldos de la persona:", error)
  }
  e.next()
}, "users")

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next()
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.")

  const category = e.app.findRecordById(
    "expense_categories",
    e.record.getString("category"),
  )
  if (
    category.getString("organization") !== e.auth.getString("organization") ||
    !category.getBool("active")
  ) {
    throw new BadRequestError("La categoría de gasto no es válida.")
  }

  const status = e.record.getString("status")
  if (status !== "draft" && status !== "pending") {
    throw new BadRequestError("El gasto debe guardarse como borrador o enviarse.")
  }
  e.record.set("organization", e.auth.getString("organization"))
  e.record.set("employee", e.auth.id)
  e.record.set(
    "outOfPolicy",
    category.getFloat("limitAmount") > 0 &&
      e.record.getFloat("amount") > category.getFloat("limitAmount"),
  )
  e.record.set("reviewedBy", "")
  e.record.set("reviewedAt", "")
  e.record.set("paidAt", "")
  e.next()
}, "expenses")

onRecordAfterCreateSuccess((e) => {
  if (e.record.getString("status") !== "pending") return e.next()
  try {
    const employee = e.app.findRecordById("users", e.record.getString("employee"))
    const managers = e.app.findRecordsByFilter(
      "users",
      "organization = {:organization} && active = true && (role = 'admin' || role = 'manager')",
      "name",
      100,
      0,
      { organization: e.record.getString("organization") },
    )
    for (const manager of managers) {
      const notification = new Record(
        e.app.findCollectionByNameOrId("notifications"),
      )
      notification.set("organization", e.record.getString("organization"))
      notification.set("recipient", manager.id)
      notification.set("title", "Nuevo gasto pendiente")
      notification.set(
        "message",
        employee.getString("name") + " ha enviado un gasto para revisión.",
      )
      notification.set("kind", "request")
      notification.set("link", "/gastos")
      notification.set("read", false)
      notification.set("createdBy", employee.id)
      e.app.save(notification)
    }
  } catch (error) {
    console.log("No se pudo notificar el nuevo gasto:", error)
  }
  e.next()
}, "expenses")

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next()
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.")
  const original = e.record.original()
  const role = e.auth.getString("role")
  const owner = original.getString("employee") === e.auth.id
  const requestedStatus = e.record.getString("status")

  e.record.set("organization", original.getString("organization"))
  e.record.set("employee", original.getString("employee"))

  if (owner && role === "employee") {
    if (
      original.getString("status") !== "draft" &&
      original.getString("status") !== "changes_requested"
    ) {
      throw new ForbiddenError("Este gasto ya no se puede editar.")
    }
    if (requestedStatus !== "draft" && requestedStatus !== "pending") {
      throw new BadRequestError("El estado solicitado no es válido.")
    }
    e.record.set("reviewedBy", "")
    e.record.set("reviewedAt", "")
    e.record.set("paidAt", "")
    return e.next()
  }

  if (role !== "admin" && role !== "manager") {
    throw new ForbiddenError("No tienes permisos para revisar gastos.")
  }
  for (const field of [
    "category",
    "merchant",
    "expenseDate",
    "amount",
    "currency",
    "description",
    "receipt",
    "outOfPolicy",
  ]) {
    e.record.set(field, original.get(field))
  }

  const allowed = ["changes_requested", "approved", "rejected"]
  if (original.getString("status") === "pending" && allowed.includes(requestedStatus)) {
    e.record.set("reviewedBy", e.auth.id)
    e.record.set("reviewedAt", new Date().toISOString())
    return e.next()
  }
  if (
    original.getString("status") === "approved" &&
    requestedStatus === "paid" &&
    role === "admin"
  ) {
    e.record.set("paidAt", new Date().toISOString())
    return e.next()
  }
  throw new BadRequestError("La transición del gasto no es válida.")
}, "expenses")

onRecordAfterUpdateSuccess((e) => {
  const original = e.record.original()
  if (original.getString("status") === e.record.getString("status")) return e.next()
  try {
    const labels = {
      pending: "enviado",
      changes_requested: "devuelto para cambios",
      approved: "aprobado",
      rejected: "rechazado",
      paid: "pagado",
    }
    const status = e.record.getString("status")
    const notification = new Record(
      e.app.findCollectionByNameOrId("notifications"),
    )
    notification.set("organization", e.record.getString("organization"))
    notification.set("recipient", e.record.getString("employee"))
    notification.set("title", "Gasto " + (labels[status] || status))
    notification.set(
      "message",
      e.record.getString("reviewComment") ||
        "Tu gasto ha cambiado de estado a " + (labels[status] || status) + ".",
    )
    notification.set(
      "kind",
      status === "approved" || status === "paid" ? "success" : "warning",
    )
    notification.set("link", "/gastos")
    notification.set("read", false)
    notification.set("createdBy", e.record.getString("reviewedBy"))
    e.app.save(notification)
  } catch (error) {
    console.log("No se pudo notificar el estado del gasto:", error)
  }
  e.next()
}, "expenses")

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next()
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.")
  const role = e.auth.getString("role")
  if (role !== "admin" && role !== "manager") {
    throw new ForbiddenError("No tienes permisos para gestionar carpetas.")
  }

  e.record.set("organization", e.auth.getString("organization"))
  e.record.set("createdBy", e.auth.id)
  const name = e.record.getString("name").trim()
  if (!name) throw new BadRequestError("La carpeta debe tener un nombre.")
  e.record.set("name", name)

  const visibility = e.record.getString("visibility")
  if (!["company", "selected", "management"].includes(visibility)) {
    throw new BadRequestError("La visibilidad de la carpeta no es válida.")
  }
  if (visibility !== "selected") {
    e.record.set("allowedUsers", [])
    return e.next()
  }

  const allowedUsers = e.record.getStringSlice("allowedUsers")
  if (allowedUsers.length === 0) {
    throw new BadRequestError("Selecciona al menos una persona para la carpeta.")
  }
  for (const userId of allowedUsers) {
    const user = e.app.findRecordById("users", userId)
    if (
      user.getString("organization") !== e.auth.getString("organization") ||
      !user.getBool("active")
    ) {
      throw new ForbiddenError("La carpeta contiene una persona no válida.")
    }
  }
  e.next()
}, "document_folders")

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next()
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.")
  const role = e.auth.getString("role")
  if (role !== "admin" && role !== "manager") {
    throw new ForbiddenError("No tienes permisos para gestionar carpetas.")
  }

  e.record.set("organization", e.auth.getString("organization"))
  e.record.set("createdBy", e.record.original().getString("createdBy"))
  const name = e.record.getString("name").trim()
  if (!name) throw new BadRequestError("La carpeta debe tener un nombre.")
  e.record.set("name", name)

  const visibility = e.record.getString("visibility")
  if (!["company", "selected", "management"].includes(visibility)) {
    throw new BadRequestError("La visibilidad de la carpeta no es válida.")
  }
  if (visibility !== "selected") {
    e.record.set("allowedUsers", [])
    return e.next()
  }

  const allowedUsers = e.record.getStringSlice("allowedUsers")
  if (allowedUsers.length === 0) {
    throw new BadRequestError("Selecciona al menos una persona para la carpeta.")
  }
  for (const userId of allowedUsers) {
    const user = e.app.findRecordById("users", userId)
    if (
      user.getString("organization") !== e.auth.getString("organization") ||
      !user.getBool("active")
    ) {
      throw new ForbiddenError("La carpeta contiene una persona no válida.")
    }
  }
  e.next()
}, "document_folders")

onRecordDeleteRequest((e) => {
  const documentCount = e.app.countRecords(
    "employee_documents",
    $dbx.hashExp({ folder: e.record.id }),
  )
  if (documentCount > 0) {
    throw new BadRequestError(
      "Mueve o elimina los documentos antes de borrar la carpeta.",
    )
  }
  e.next()
}, "document_folders")

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next()
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.")
  const role = e.auth.getString("role")
  const folderId = e.record.getString("folder")
  e.record.set("organization", e.auth.getString("organization"))
  e.record.set("uploadedBy", e.auth.id)
  e.record.set("acknowledgedAt", "")
  const title = e.record.getString("title").trim()
  if (!title) throw new BadRequestError("El título es obligatorio.")
  e.record.set("title", title)

  if (folderId) {
    if (role !== "admin" && role !== "manager") {
      throw new ForbiddenError("No tienes permisos para usar esta carpeta.")
    }
    const folder = e.app.findRecordById("document_folders", folderId)
    if (folder.getString("organization") !== e.auth.getString("organization")) {
      throw new ForbiddenError("La carpeta no pertenece a tu empresa.")
    }
    e.record.set("employee", "")
    e.record.set("visibility", "folder")
    return e.next()
  }

  const employeeId =
    role === "admin" || role === "manager"
      ? e.record.getString("employee") || e.auth.id
      : e.auth.id
  const employee = e.app.findRecordById("users", employeeId)
  if (employee.getString("organization") !== e.auth.getString("organization")) {
    throw new ForbiddenError("La persona no pertenece a tu empresa.")
  }
  e.record.set("employee", employeeId)
  if (role === "employee") e.record.set("visibility", "employee")
  if (e.record.getString("visibility") === "folder") {
    throw new BadRequestError("Selecciona una visibilidad para el documento.")
  }
  e.next()
}, "employee_documents")

onRecordAfterCreateSuccess((e) => {
  const uploadedBy = e.record.getString("uploadedBy")
  try {
    let recipients = []
    const folderId = e.record.getString("folder")
    if (folderId) {
      const folder = e.app.findRecordById("document_folders", folderId)
      const organization = folder.getString("organization")
      const recipientIds = {}
      const addRecipient = (user) => {
        if (
          user.getString("organization") === organization &&
          user.getBool("active") &&
          !recipientIds[user.id]
        ) {
          recipientIds[user.id] = true
          recipients.push(user)
        }
      }

      if (folder.getString("visibility") === "company") {
        for (const user of e.app.findRecordsByFilter(
          "users",
          "organization = {:organization} && active = true",
          "name",
          500,
          0,
          { organization },
        )) {
          addRecipient(user)
        }
      } else if (folder.getString("visibility") === "selected") {
        for (const userId of folder.getStringSlice("allowedUsers")) {
          addRecipient(e.app.findRecordById("users", userId))
        }
      }

      for (const manager of e.app.findRecordsByFilter(
        "users",
        "organization = {:organization} && active = true && (role = 'admin' || role = 'manager')",
        "name",
        500,
        0,
        { organization },
      )) {
        addRecipient(manager)
      }
    } else {
      recipients = [
        e.app.findRecordById("users", e.record.getString("employee")),
      ]
    }

    for (const recipient of recipients) {
      if (recipient.id === uploadedBy) continue
      const notification = new Record(
        e.app.findCollectionByNameOrId("notifications"),
      )
      notification.set("organization", e.record.getString("organization"))
      notification.set("recipient", recipient.id)
      notification.set("title", "Nuevo documento disponible")
      notification.set("message", e.record.getString("title"))
      notification.set("kind", "info")
      notification.set("link", "/documentos")
      notification.set("read", false)
      notification.set("createdBy", uploadedBy)
      e.app.save(notification)

      if (e.app.settings().smtp.enabled) {
        try {
          e.app.newMailClient().send(new MailerMessage({
            from: {
              address: e.app.settings().meta.senderAddress,
              name: e.app.settings().meta.senderName,
            },
            to: [{ address: recipient.email() }],
            subject: "Nuevo documento disponible en " + e.app.settings().meta.appName,
            text:
              "Hola " +
              recipient.getString("name") +
              ". Tienes un nuevo documento disponible. Accede a " +
              e.app.settings().meta.appURL +
              "/documentos para consultarlo.",
          }))
        } catch (_) {
          console.log("No se pudo enviar el aviso de nuevo documento.")
        }
      }
    }
  } catch (_) {
    console.log("No se pudo notificar el nuevo documento.")
  }
  e.next()
}, "employee_documents")

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next()
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.")
  const original = e.record.original()
  const role = e.auth.getString("role")
  const owner = original.getString("employee") === e.auth.id
  e.record.set("organization", original.getString("organization"))
  e.record.set("uploadedBy", original.getString("uploadedBy"))
  if (owner && role === "employee") {
    for (const field of [
      "employee",
      "folder",
      "title",
      "category",
      "visibility",
      "file",
      "acknowledgementRequired",
    ]) {
      e.record.set(field, original.get(field))
    }
    if (!original.getBool("acknowledgementRequired")) {
      throw new BadRequestError("Este documento no requiere confirmación.")
    }
    e.record.set("acknowledgedAt", new Date().toISOString())
    return e.next()
  }

  if (role !== "admin" && role !== "manager") {
    throw new ForbiddenError("No tienes permisos para modificar el documento.")
  }
  const title = e.record.getString("title").trim()
  if (!title) throw new BadRequestError("El título es obligatorio.")
  e.record.set("title", title)
  e.record.set("acknowledgedAt", original.get("acknowledgedAt"))

  const folderId = e.record.getString("folder")
  if (folderId) {
    const folder = e.app.findRecordById("document_folders", folderId)
    if (folder.getString("organization") !== e.auth.getString("organization")) {
      throw new ForbiddenError("La carpeta no pertenece a tu empresa.")
    }
    e.record.set("employee", "")
    e.record.set("visibility", "folder")
  } else {
    const employeeId = e.record.getString("employee")
    if (!employeeId) {
      throw new BadRequestError(
        "Selecciona una persona para mover el documento a Sin carpeta.",
      )
    }
    const employee = e.app.findRecordById("users", employeeId)
    if (employee.getString("organization") !== e.auth.getString("organization")) {
      throw new ForbiddenError("La persona no pertenece a tu empresa.")
    }
    if (
      !["employee", "company", "management"].includes(
        e.record.getString("visibility"),
      )
    ) {
      throw new BadRequestError("Selecciona una visibilidad para el documento.")
    }
  }
  e.next()
}, "employee_documents")

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next()
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.")
  const document = e.app.findRecordById(
    "employee_documents",
    e.record.getString("document"),
  )
  const folderId = document.getString("folder")
  if (!folderId || !document.getBool("acknowledgementRequired")) {
    throw new BadRequestError("Este documento no admite esta confirmación.")
  }
  const folder = e.app.findRecordById("document_folders", folderId)
  const role = e.auth.getString("role")
  const hasAccess =
    e.auth.getString("organization") === folder.getString("organization") &&
    (
      role === "admin" ||
      role === "manager" ||
      folder.getString("visibility") === "company" ||
      (
        folder.getString("visibility") === "selected" &&
        folder.getStringSlice("allowedUsers").includes(e.auth.id)
      )
    )
  if (!hasAccess) {
    throw new ForbiddenError("No tienes acceso a este documento.")
  }
  try {
    e.app.findFirstRecordByFilter(
      "document_acknowledgements",
      "document = {:document} && user = {:user}",
      { document: document.id, user: e.auth.id },
    )
    throw new BadRequestError("La lectura ya estaba confirmada.")
  } catch (error) {
    if (error instanceof BadRequestError) throw error
  }
  e.record.set("organization", e.auth.getString("organization"))
  e.record.set("document", document.id)
  e.record.set("user", e.auth.id)
  e.record.set("acknowledgedAt", new Date().toISOString())
  e.next()
}, "document_acknowledgements")

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next()
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.")
  const assignee = e.app.findRecordById("users", e.record.getString("assignee"))
  if (assignee.getString("organization") !== e.auth.getString("organization")) {
    throw new ForbiddenError("La persona no pertenece a tu empresa.")
  }
  e.record.set("organization", e.auth.getString("organization"))
  e.record.set("createdBy", e.auth.id)
  e.record.set("status", "pending")
  e.record.set("completedAt", "")
  e.next()
}, "employee_tasks")

onRecordAfterCreateSuccess((e) => {
  try {
    const notification = new Record(
      e.app.findCollectionByNameOrId("notifications"),
    )
    notification.set("organization", e.record.getString("organization"))
    notification.set("recipient", e.record.getString("assignee"))
    notification.set("title", "Nueva tarea asignada")
    notification.set("message", e.record.getString("title"))
    notification.set("kind", "request")
    notification.set("link", "/tareas")
    notification.set("read", false)
    notification.set("createdBy", e.record.getString("createdBy"))
    e.app.save(notification)

    if (e.app.settings().smtp.enabled) {
      try {
        const assignee = e.app.findRecordById(
          "users",
          e.record.getString("assignee"),
        )
        e.app.newMailClient().send(new MailerMessage({
          from: {
            address: e.app.settings().meta.senderAddress,
            name: e.app.settings().meta.senderName,
          },
          to: [{ address: assignee.email() }],
          subject: "Nueva tarea asignada en " + e.app.settings().meta.appName,
          text:
            "Hola " +
            assignee.getString("name") +
            ". Tienes una nueva tarea asignada. Accede a " +
            e.app.settings().meta.appURL +
            "/tareas para consultarla.",
        }))
      } catch (_) {
        console.log("No se pudo enviar el aviso de nueva tarea.")
      }
    }
  } catch (error) {
    console.log("No se pudo notificar la tarea:", error)
  }
  e.next()
}, "employee_tasks")

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next()
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.")
  const original = e.record.original()
  const role = e.auth.getString("role")
  const owner = original.getString("assignee") === e.auth.id
  e.record.set("organization", original.getString("organization"))
  e.record.set("assignee", original.getString("assignee"))
  e.record.set("createdBy", original.getString("createdBy"))
  if (owner && role === "employee") {
    for (const field of ["title", "description", "category", "dueDate", "required"]) {
      e.record.set(field, original.get(field))
    }
    const status = e.record.getString("status")
    if (status !== "in_progress" && status !== "completed") {
      throw new BadRequestError("Sólo puedes iniciar o completar la tarea.")
    }
  }
  e.record.set(
    "completedAt",
    e.record.getString("status") === "completed" ? new Date().toISOString() : "",
  )
  e.next()
}, "employee_tasks")

onRecordAfterUpdateSuccess((e) => {
  if (
    e.record.getString("status") !== "completed" ||
    e.record.original().getString("status") === "completed"
  ) {
    return e.next()
  }
  try {
    const employee = e.app.findRecordById("users", e.record.getString("assignee"))
    const notification = new Record(
      e.app.findCollectionByNameOrId("notifications"),
    )
    notification.set("organization", e.record.getString("organization"))
    notification.set("recipient", e.record.getString("createdBy"))
    notification.set("title", "Tarea completada")
    notification.set(
      "message",
      employee.getString("name") +
        " ha completado " +
        e.record.getString("title") +
        ".",
    )
    notification.set("kind", "success")
    notification.set("link", "/tareas")
    notification.set("read", false)
    notification.set("createdBy", employee.id)
    e.app.save(notification)
  } catch (error) {
    console.log("No se pudo notificar la tarea completada:", error)
  }
  e.next()
}, "employee_tasks")

onRecordCreateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next()
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.")
  const employee = e.app.findRecordById("users", e.record.getString("employee"))
  if (employee.getString("organization") !== e.auth.getString("organization")) {
    throw new ForbiddenError("La persona no pertenece a tu empresa.")
  }
  e.record.set("organization", e.auth.getString("organization"))
  e.record.set("createdBy", e.auth.id)
  e.record.set("status", "active")
  e.record.set("progress", Math.max(0, Math.min(100, e.record.getFloat("progress"))))
  e.next()
}, "goals")

onRecordAfterCreateSuccess((e) => {
  try {
    const notification = new Record(
      e.app.findCollectionByNameOrId("notifications"),
    )
    notification.set("organization", e.record.getString("organization"))
    notification.set("recipient", e.record.getString("employee"))
    notification.set("title", "Nuevo objetivo")
    notification.set("message", e.record.getString("title"))
    notification.set("kind", "info")
    notification.set("link", "/objetivos")
    notification.set("read", false)
    notification.set("createdBy", e.record.getString("createdBy"))
    e.app.save(notification)
  } catch (error) {
    console.log("No se pudo notificar el objetivo:", error)
  }
  e.next()
}, "goals")

onRecordUpdateRequest((e) => {
  if (e.hasSuperuserAuth()) return e.next()
  if (!e.auth) throw new UnauthorizedError("Debes iniciar sesión.")
  const original = e.record.original()
  const role = e.auth.getString("role")
  const owner = original.getString("employee") === e.auth.id
  e.record.set("organization", original.getString("organization"))
  e.record.set("employee", original.getString("employee"))
  e.record.set("createdBy", original.getString("createdBy"))
  if (owner && role === "employee") {
    for (const field of ["title", "description", "cycle", "dueDate", "public"]) {
      e.record.set(field, original.get(field))
    }
    const progress = Math.max(0, Math.min(100, e.record.getFloat("progress")))
    e.record.set("progress", progress)
    e.record.set("status", progress === 100 ? "completed" : "active")
  }
  e.next()
}, "goals")
