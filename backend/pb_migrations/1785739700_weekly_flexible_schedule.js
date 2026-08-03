migrate((app) => {
  const users = app.findCollectionByNameOrId("users")

  users.fields.add(new SelectField({
    name: "scheduleMode",
    maxSelect: 1,
    values: ["scheduled", "weekly_flexible"],
  }))
  users.fields.add(new JSONField({
    name: "flexibleWeekdays",
    maxSize: 1024,
  }))
  app.save(users)

  const records = app.findRecordsByFilter(
    "users",
    "id != ''",
    "id",
    10000,
    0,
  )
  for (const user of records) {
    user.set("scheduleMode", "scheduled")
    user.set("flexibleWeekdays", [1, 2, 3, 4, 5])
    app.save(user)
  }

  users.fields.getByName("scheduleMode").required = true
  app.save(users)
}, (app) => {
  const users = app.findCollectionByNameOrId("users")
  users.fields.removeByName("flexibleWeekdays")
  users.fields.removeByName("scheduleMode")
  app.save(users)
})
