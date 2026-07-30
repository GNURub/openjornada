migrate((app) => {
  const organizations = app.findCollectionByNameOrId("organizations")
  const workEvents = app.findCollectionByNameOrId("work_events")
  const manualRequests = app.findCollectionByNameOrId(
    "manual_time_requests",
  )

  organizations.fields.add(new BoolField({
    name: "timeCorrectionApprovalRequired",
  }))
  app.save(organizations)

  const organizationRecords = app.findRecordsByFilter(
    "organizations",
    "id != ''",
    "id",
    10000,
    0,
  )
  for (const organization of organizationRecords) {
    organization.set("timeCorrectionApprovalRequired", true)
    app.save(organization)
  }

  manualRequests.fields.add(new SelectField({
    name: "requestType",
    maxSelect: 1,
    values: ["addition", "replacement"],
  }))
  manualRequests.fields.add(new JSONField({
    name: "originalIntervals",
    maxSize: 32768,
  }))
  manualRequests.fields.add(new RelationField({
    name: "targetEvents",
    maxSelect: 100,
    collectionId: workEvents.id,
    cascadeDelete: false,
  }))
  manualRequests.fields.add(new TextField({
    name: "baseFingerprint",
    max: 64,
  }))
  manualRequests.fields.getByName("intervals").required = false
  manualRequests.indexes.push(
    "CREATE INDEX idx_manual_time_requests_type ON manual_time_requests (organization, requestType, status)",
  )
  app.save(manualRequests)

  const existingRequests = app.findRecordsByFilter(
    "manual_time_requests",
    "id != ''",
    "id",
    10000,
    0,
  )
  for (const request of existingRequests) {
    request.set("requestType", "addition")
    app.save(request)
  }
  manualRequests.fields.getByName("requestType").required = true
  app.save(manualRequests)

  workEvents.fields.add(new BoolField({
    name: "voidsTarget",
  }))
  app.save(workEvents)
}, (app) => {
  const workEvents = app.findCollectionByNameOrId("work_events")
  workEvents.fields.removeByName("voidsTarget")
  app.save(workEvents)

  const manualRequests = app.findCollectionByNameOrId(
    "manual_time_requests",
  )
  manualRequests.indexes = manualRequests.indexes.filter(
    (index) => !index.includes("idx_manual_time_requests_type"),
  )
  manualRequests.fields.removeByName("baseFingerprint")
  manualRequests.fields.removeByName("targetEvents")
  manualRequests.fields.removeByName("originalIntervals")
  manualRequests.fields.removeByName("requestType")
  manualRequests.fields.getByName("intervals").required = true
  app.save(manualRequests)

  const organizations = app.findCollectionByNameOrId("organizations")
  organizations.fields.removeByName("timeCorrectionApprovalRequired")
  app.save(organizations)
})
