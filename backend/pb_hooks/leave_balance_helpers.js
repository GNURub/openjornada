function validateValues(record) {
  for (const field of ["allowance", "carriedOver", "adjustment"]) {
    const value = record.getFloat(field)
    const minimum = field === "adjustment" ? -366 : 0
    if (
      value < minimum ||
      value > 366 ||
      Math.abs(value * 2 - Math.round(value * 2)) > 0.000001
    ) {
      throw new BadRequestError(
        "Los saldos deben expresarse en días completos o medios días.",
      )
    }
  }
}

function validateReferences(app, record, organization) {
  const employee = app.findRecordById("users", record.getString("employee"))
  const leaveType = app.findRecordById(
    "leave_types",
    record.getString("leaveType"),
  )
  if (
    employee.getString("organization") !== organization ||
    leaveType.getString("organization") !== organization
  ) {
    throw new BadRequestError(
      "La persona y el tipo de ausencia deben pertenecer a la misma empresa.",
    )
  }
  validateValues(record)
}

function auditUpdate(app, record, original, actor) {
  const changed = ["allowance", "carriedOver", "adjustment"].some(
    (field) => original.getFloat(field) !== record.getFloat(field),
  )
  if (!changed) return

  const audit = new Record(app.findCollectionByNameOrId("audit_logs"))
  audit.set("organization", record.getString("organization"))
  audit.set("actor", actor)
  audit.set("action", "leave_balance.updated")
  audit.set("entityType", "leave_balance")
  audit.set("entityId", record.id)
  audit.set("metadata", {
    employee: record.getString("employee"),
    leaveType: record.getString("leaveType"),
    year: record.getFloat("year"),
    before: {
      allowance: original.getFloat("allowance"),
      carriedOver: original.getFloat("carriedOver"),
      adjustment: original.getFloat("adjustment"),
    },
    after: {
      allowance: record.getFloat("allowance"),
      carriedOver: record.getFloat("carriedOver"),
      adjustment: record.getFloat("adjustment"),
    },
  })
  audit.set("occurredAt", new Date().toISOString())
  app.save(audit)
}

module.exports = { auditUpdate, validateReferences }
