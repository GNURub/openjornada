migrate((app) => {
  const organizations = app.findCollectionByNameOrId("organizations")
  const users = app.findCollectionByNameOrId("users")
  const employeeDocuments = app.findCollectionByNameOrId("employee_documents")

  const documentFolders = new Collection({
    type: "base",
    name: "document_folders",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager' || visibility = 'company' || (visibility = 'selected' && allowedUsers.id ?= @request.auth.id))",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager' || visibility = 'company' || (visibility = 'selected' && allowedUsers.id ?= @request.auth.id))",
    createRule:
      "@request.auth.id != '' && (@request.auth.role = 'admin' || @request.auth.role = 'manager') && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager')",
    deleteRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager')",
    fields: [
      {
        name: "organization",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: organizations.id,
        cascadeDelete: false,
      },
      { name: "name", type: "text", required: true, max: 120 },
      {
        name: "visibility",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["company", "selected", "management"],
      },
      {
        name: "allowedUsers",
        type: "relation",
        maxSelect: 500,
        collectionId: users.id,
        cascadeDelete: false,
      },
      {
        name: "createdBy",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_document_folders_name ON document_folders (organization, name)",
      "CREATE INDEX idx_document_folders_visibility ON document_folders (organization, visibility)",
    ],
  })
  app.save(documentFolders)

  const acknowledgements = new Collection({
    type: "base",
    name: "document_acknowledgements",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (user = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (user = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    createRule:
      "@request.auth.id != '' && @request.body.organization = @request.auth.organization && @request.body.user = @request.auth.id",
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        name: "organization",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: organizations.id,
        cascadeDelete: false,
      },
      {
        name: "document",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: employeeDocuments.id,
        cascadeDelete: true,
      },
      {
        name: "user",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "acknowledgedAt", type: "date", required: true },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_document_acknowledgements_user ON document_acknowledgements (document, user)",
      "CREATE INDEX idx_document_acknowledgements_org ON document_acknowledgements (organization, document)",
    ],
  })
  app.save(acknowledgements)

  employeeDocuments.fields.getByName("employee").required = false
  employeeDocuments.fields.getByName("visibility").values = [
    "employee",
    "company",
    "management",
    "folder",
  ]
  employeeDocuments.fields.add(new RelationField({
    name: "folder",
    maxSelect: 1,
    collectionId: documentFolders.id,
    cascadeDelete: false,
  }))
  employeeDocuments.listRule =
    "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager' || (folder = '' && (visibility = 'company' || employee = @request.auth.id)) || folder.visibility = 'company' || (folder.visibility = 'selected' && folder.allowedUsers.id ?= @request.auth.id))"
  employeeDocuments.viewRule = employeeDocuments.listRule
  employeeDocuments.createRule =
    "@request.auth.id != '' && @request.body.organization = @request.auth.organization && ((@request.auth.role = 'admin' || @request.auth.role = 'manager') || (@request.body.folder = '' && @request.body.employee = @request.auth.id))"
  employeeDocuments.updateRule =
    "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || @request.auth.role = 'manager' || (folder = '' && employee = @request.auth.id))"
  employeeDocuments.deleteRule =
    "@request.auth.id != '' && organization = @request.auth.organization && (@request.auth.role = 'admin' || (folder = '' && employee = @request.auth.id))"
  employeeDocuments.indexes.push(
    "CREATE INDEX idx_employee_documents_folder ON employee_documents (organization, folder, created)",
  )
  app.save(employeeDocuments)
}, (app) => {
  const employeeDocuments = app.findCollectionByNameOrId("employee_documents")
  const folderDocuments = app.findRecordsByFilter(
    "employee_documents",
    "folder != ''",
    "created",
    10000,
    0,
  )
  for (const document of folderDocuments) {
    if (!document.getString("employee")) {
      document.set("employee", document.getString("uploadedBy"))
    }
    document.set("visibility", "management")
    document.set("folder", "")
    app.save(document)
  }

  employeeDocuments.fields.removeByName("folder")
  employeeDocuments.fields.getByName("employee").required = true
  employeeDocuments.fields.getByName("visibility").values = [
    "employee",
    "company",
    "management",
  ]
  employeeDocuments.listRule =
    "@request.auth.id != '' && organization = @request.auth.organization && (visibility = 'company' || employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')"
  employeeDocuments.viewRule = employeeDocuments.listRule
  employeeDocuments.createRule =
    "@request.auth.id != '' && @request.body.organization = @request.auth.organization && (@request.body.employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')"
  employeeDocuments.updateRule =
    "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')"
  employeeDocuments.deleteRule =
    "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin')"
  employeeDocuments.indexes = employeeDocuments.indexes.filter(
    (index) => !index.includes("idx_employee_documents_folder"),
  )
  app.save(employeeDocuments)

  app.delete(app.findCollectionByNameOrId("document_acknowledgements"))
  app.delete(app.findCollectionByNameOrId("document_folders"))
})
