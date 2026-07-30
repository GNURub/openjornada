migrate(
  (app) => {
    const requests = app.findCollectionByNameOrId("manual_time_requests")
    requests.fields.getByName("reason").required = false
    app.save(requests)
  },
  (app) => {
    const records = app.findRecordsByFilter(
      "manual_time_requests",
      "reason = ''",
      "created",
      10000,
      0,
    )
    for (const record of records) {
      record.set("reason", "Jornada incorporada sin corrección.")
      app.save(record)
    }

    const requests = app.findCollectionByNameOrId("manual_time_requests")
    requests.fields.getByName("reason").required = true
    app.save(requests)
  },
)
