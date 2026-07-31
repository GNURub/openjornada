function seedRecord(app, collectionName, lookupFilter, params, values) {
  try {
    return app.findFirstRecordByFilter(collectionName, lookupFilter, params)
  } catch (_) {
    const record = new Record(app.findCollectionByNameOrId(collectionName))
    for (const key of Object.keys(values)) record.set(key, values[key])
    app.save(record)
    return record
  }
}

function ensureDefaultLeaveBalances(app, user, types) {
  if (!user.getBool("active")) return
  const year = new Date().getUTCFullYear()
  for (const config of [
    [types.vacation.id, 22],
    [types.personal.id, 0],
  ]) {
    seedRecord(
      app,
      "leave_balances",
      "employee = {:employee} && leaveType = {:leaveType} && year = {:year}",
      { employee: user.id, leaveType: config[0], year },
      {
        organization: user.getString("organization"),
        employee: user.id,
        leaveType: config[0],
        year,
        allowance: config[1],
        carriedOver: 0,
        adjustment: 0,
      },
    )
  }
}

function seedOrganization(app, organization) {
  const defaults = [
    ["vacation", "Vacaciones", "#f97360", true, true, false],
    ["medical", "Consulta médica", "#38bdf8", false, true, true],
    ["personal", "Asuntos propios", "#a78bfa", true, true, false],
    ["other", "Otro permiso", "#94a3b8", false, true, false],
  ]
  const types = {}
  for (const item of defaults) {
    types[item[0]] = seedRecord(
      app,
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
      app,
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

  const users = app.findRecordsByFilter(
    "users",
    "organization = {:organization} && active = true",
    "name",
    500,
    0,
    { organization: organization.id },
  )
  for (const user of users) ensureDefaultLeaveBalances(app, user, types)
}

function seedOrganizations(app) {
  app.findCollectionByNameOrId("leave_types")
  const organizations = app.findRecordsByFilter(
    "organizations",
    "id != ''",
    "name",
    200,
    0,
  )
  for (const organization of organizations) seedOrganization(app, organization)
}

function ensureUserDefaultLeaveBalances(app, user) {
  const organization = app.findRecordById(
    "organizations",
    user.getString("organization"),
  )
  const types = {
    vacation: app.findFirstRecordByFilter(
      "leave_types",
      "organization = {:organization} && code = 'vacation'",
      { organization: organization.id },
    ),
    personal: app.findFirstRecordByFilter(
      "leave_types",
      "organization = {:organization} && code = 'personal'",
      { organization: organization.id },
    ),
  }
  ensureDefaultLeaveBalances(app, user, types)
}

module.exports = {
  ensureUserDefaultLeaveBalances,
  seedOrganization,
  seedOrganizations,
}
