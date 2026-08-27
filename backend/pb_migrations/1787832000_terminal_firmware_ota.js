migrate((app) => {
  const terminals = app.findCollectionByNameOrId("attendance_terminals")
  terminals.fields.add(new SelectField({
    name: "firmwareUpdateStatus",
    maxSelect: 1,
    values: [
      "idle", "checking", "available", "downloading", "verifying",
      "pending_reboot", "updated", "failed", "rolled_back", "blocked",
    ],
  }))
  terminals.fields.add(new TextField({ name: "firmwareTargetVersion", max: 32 }))
  terminals.fields.add(new DateField({ name: "lastFirmwareCheckAt" }))
  terminals.fields.add(new SelectField({
    name: "firmwareUpdateErrorCode",
    maxSelect: 1,
    values: [
      "manifest_fetch", "manifest_signature", "manifest_invalid",
      "incompatible", "download", "size", "hash", "flash",
      "boot_validation", "rollback",
    ],
  }))
  app.save(terminals)
}, (app) => {
  const terminals = app.findCollectionByNameOrId("attendance_terminals")
  for (const name of [
    "firmwareUpdateErrorCode",
    "lastFirmwareCheckAt",
    "firmwareTargetVersion",
    "firmwareUpdateStatus",
  ]) terminals.fields.removeByName(name)
  app.save(terminals)
})
