migrate((app) => {
  const balances = app.findCollectionByNameOrId("leave_balances")
  const users = app.findCollectionByNameOrId("users")
  balances.fields.add(
    new RelationField({
      name: "updatedBy",
      maxSelect: 1,
      collectionId: users.id,
      cascadeDelete: false,
    }),
  )
  app.save(balances)
}, (app) => {
  const balances = app.findCollectionByNameOrId("leave_balances")
  balances.fields.removeByName("updatedBy")
  app.save(balances)
})
