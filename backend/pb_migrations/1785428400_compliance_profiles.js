migrate((app) => {
  const organizations = app.findCollectionByNameOrId("organizations")
  const users = app.findCollectionByNameOrId("users")

  organizations.fields.add(new TextField({
    name: "privacyNoticeVersion",
    max: 40,
  }))
  app.save(organizations)

  users.fields.add(new SelectField({
    name: "employmentType",
    maxSelect: 1,
    values: ["unknown", "full_time", "part_time"],
  }))
  users.fields.add(new NumberField({
    name: "contractedWeeklyMinutes",
    min: 0,
    max: 10080,
  }))
  users.fields.add(new BoolField({
    name: "complementaryHoursAgreement",
  }))
  users.fields.add(new TextField({
    name: "privacyNoticeAcknowledgedVersion",
    max: 40,
  }))
  users.fields.add(new DateField({
    name: "privacyNoticeAcknowledgedAt",
  }))
  users.fields.removeByName("privacyNoticeAcceptedAt")
  app.save(users)

  const organizationRecords = app.findRecordsByFilter(
    "organizations",
    "id != ''",
    "id",
    10000,
    0,
  )
  for (const organization of organizationRecords) {
    organization.set("privacyNoticeVersion", "2026-07-30")
    app.save(organization)
  }

  const userRecords = app.findRecordsByFilter(
    "users",
    "id != ''",
    "id",
    10000,
    0,
  )
  for (const user of userRecords) {
    user.set("employmentType", "unknown")
    user.set(
      "contractedWeeklyMinutes",
      Math.max(0, Math.round(user.getFloat("weeklyHours") * 60)),
    )
    user.set("complementaryHoursAgreement", false)
    user.set("privacyNoticeAcknowledgedVersion", "")
    user.set("privacyNoticeAcknowledgedAt", "")
    app.save(user)
  }

  users.fields.getByName("employmentType").required = true
  users.fields.getByName("contractedWeeklyMinutes").required = true
  app.save(users)
}, (app) => {
  const users = app.findCollectionByNameOrId("users")
  users.fields.add(new DateField({ name: "privacyNoticeAcceptedAt" }))
  users.fields.removeByName("privacyNoticeAcknowledgedAt")
  users.fields.removeByName("privacyNoticeAcknowledgedVersion")
  users.fields.removeByName("complementaryHoursAgreement")
  users.fields.removeByName("contractedWeeklyMinutes")
  users.fields.removeByName("employmentType")
  app.save(users)

  const organizations = app.findCollectionByNameOrId("organizations")
  organizations.fields.removeByName("privacyNoticeVersion")
  app.save(organizations)
})
