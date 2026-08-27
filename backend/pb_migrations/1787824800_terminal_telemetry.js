migrate((app) => {
  const terminals = app.findCollectionByNameOrId("attendance_terminals")
  terminals.fields.add(new DateField({ name: "lastHeartbeatAt" }))
  terminals.fields.add(new DateField({ name: "lastAttendanceSyncAt" }))
  terminals.fields.add(new SelectField({
    name: "lastClockStatus",
    maxSelect: 1,
    values: ["synced", "stale", "unsynced"],
  }))
  terminals.fields.add(new DateField({ name: "lastNtpSyncAt" }))
  terminals.fields.add(new NumberField({ name: "lastWifiRssiDbm", min: -127, max: 0 }))
  terminals.fields.add(new NumberField({ name: "lastUptimeSeconds", min: 0, max: 4294967295 }))
  app.save(terminals)
}, (app) => {
  const terminals = app.findCollectionByNameOrId("attendance_terminals")
  for (const name of [
    "lastUptimeSeconds",
    "lastWifiRssiDbm",
    "lastNtpSyncAt",
    "lastClockStatus",
    "lastAttendanceSyncAt",
    "lastHeartbeatAt",
  ]) terminals.fields.removeByName(name)
  app.save(terminals)
})
