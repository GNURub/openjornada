migrate(
  (app) => {
    const balances = app.findCollectionByNameOrId("leave_balances")
    balances.fields.getByName("allowance").required = false
    app.save(balances)
  },
  (app) => {
    const balances = app.findCollectionByNameOrId("leave_balances")
    balances.fields.getByName("allowance").required = true
    app.save(balances)
  },
)
