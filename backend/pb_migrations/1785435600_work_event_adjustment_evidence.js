migrate((app) => {
  const workEvents = app.findCollectionByNameOrId("work_events")
  workEvents.fields.add(
    new DateField({
      name: "recordedAt",
    }),
  )
  workEvents.fields.add(
    new NumberField({
      name: "adjustmentSeconds",
      min: 0,
    }),
  )
  workEvents.fields.add(
    new TextField({
      name: "adjustmentReason",
      max: 500,
    }),
  )
  workEvents.fields.add(
    new SelectField({
      name: "integrityVersion",
      maxSelect: 1,
      values: ["v1", "v2"],
    }),
  )
  app.save(workEvents)

  const records = app.findRecordsByFilter(
    "work_events",
    "id != ''",
    "created",
    100000,
    0,
  )
  for (const record of records) {
    record.set(
      "recordedAt",
      record.getString("created") || record.getString("occurredAt"),
    )
    record.set("adjustmentSeconds", 0)
    record.set("adjustmentReason", "")
    record.set("integrityVersion", "v1")
    app.save(record)
  }
}, (app) => {
  const workEvents = app.findCollectionByNameOrId("work_events")
  workEvents.fields.removeByName("integrityVersion")
  workEvents.fields.removeByName("adjustmentReason")
  workEvents.fields.removeByName("adjustmentSeconds")
  workEvents.fields.removeByName("recordedAt")
  app.save(workEvents)
})
