migrate((app) => {
  const manualRequests = app.findCollectionByNameOrId(
    "manual_time_requests",
  )
  manualRequests.fields.add(new SelectField({
    name: "timeStorageVersion",
    maxSelect: 1,
    values: ["utc_wall_v0", "iana_v1"],
  }))
  app.save(manualRequests)

  const existingRequests = app.findRecordsByFilter(
    "manual_time_requests",
    "id != ''",
    "id",
    10000,
    0,
  )
  for (const request of existingRequests) {
    request.set("timeStorageVersion", "utc_wall_v0")
    if (
      request.getString("requestType") === "replacement" &&
      request.getString("status") === "pending"
    ) {
      request.set("status", "cancelled")
      request.set(
        "resolutionNote",
        "Cancelada al activar la interpretación IANA de zonas horarias. Vuelve a solicitar la corrección.",
      )
      request.set("resolvedAt", new Date().toISOString())
    }
    app.save(request)
  }

  manualRequests.fields.getByName("timeStorageVersion").required = true
  app.save(manualRequests)
}, (app) => {
  const manualRequests = app.findCollectionByNameOrId(
    "manual_time_requests",
  )
  manualRequests.fields.removeByName("timeStorageVersion")
  app.save(manualRequests)
})
