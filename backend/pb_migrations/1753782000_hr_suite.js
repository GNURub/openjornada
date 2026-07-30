migrate((app) => {
  const organizations = app.findCollectionByNameOrId("organizations")
  const users = app.findCollectionByNameOrId("users")
  const leaveRequests = app.findCollectionByNameOrId("leave_requests")

  const leaveTypes = new Collection({
    type: "base",
    name: "leave_types",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    createRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && organization = @request.auth.organization",
    deleteRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && organization = @request.auth.organization",
    fields: [
      {
        name: "organization",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: organizations.id,
        cascadeDelete: false,
      },
      { name: "code", type: "text", required: true, min: 2, max: 40 },
      { name: "name", type: "text", required: true, min: 2, max: 120 },
      { name: "color", type: "text", required: true, min: 4, max: 9 },
      { name: "deductsBalance", type: "bool" },
      { name: "requiresApproval", type: "bool" },
      { name: "requiresDocument", type: "bool" },
      { name: "active", type: "bool" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_leave_types_code ON leave_types (organization, code)",
      "CREATE INDEX idx_leave_types_active ON leave_types (organization, active)",
    ],
  })
  app.save(leaveTypes)

  const leaveBalances = new Collection({
    type: "base",
    name: "leave_balances",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    createRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && organization = @request.auth.organization",
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
        name: "employee",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      {
        name: "leaveType",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: leaveTypes.id,
        cascadeDelete: false,
      },
      { name: "year", type: "number", required: true, min: 2020, max: 2200 },
      { name: "allowance", type: "number", required: true, min: 0, max: 366 },
      { name: "carriedOver", type: "number", min: 0, max: 366 },
      { name: "adjustment", type: "number", min: -366, max: 366 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_leave_balances_period ON leave_balances (employee, leaveType, year)",
      "CREATE INDEX idx_leave_balances_org_year ON leave_balances (organization, year)",
    ],
  })
  app.save(leaveBalances)

  const blackoutPeriods = new Collection({
    type: "base",
    name: "leave_blackout_periods",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    createRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && organization = @request.auth.organization",
    deleteRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && organization = @request.auth.organization",
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
        name: "leaveType",
        type: "relation",
        maxSelect: 1,
        collectionId: leaveTypes.id,
        cascadeDelete: false,
      },
      { name: "name", type: "text", required: true, max: 120 },
      { name: "startDate", type: "date", required: true },
      { name: "endDate", type: "date", required: true },
      { name: "reason", type: "text", max: 500 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_leave_blackouts_dates ON leave_blackout_periods (organization, startDate, endDate)",
    ],
  })
  app.save(blackoutPeriods)

  const publicHolidays = new Collection({
    type: "base",
    name: "public_holidays",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    createRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && organization = @request.auth.organization",
    deleteRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && organization = @request.auth.organization",
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
      { name: "date", type: "date", required: true },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_public_holidays_date ON public_holidays (organization, date)",
    ],
  })
  app.save(publicHolidays)

  leaveRequests.createRule =
    "@request.auth.id != '' && @request.body.organization = @request.auth.organization && (@request.body.employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')"
  leaveRequests.fields.add(new RelationField({
    name: "leaveType",
    maxSelect: 1,
    collectionId: leaveTypes.id,
    cascadeDelete: false,
  }))
  leaveRequests.fields.add(new NumberField({
    name: "requestedDays",
    min: 0,
    max: 366,
  }))
  leaveRequests.fields.add(new RelationField({
    name: "assignedBy",
    maxSelect: 1,
    collectionId: users.id,
    cascadeDelete: false,
  }))
  leaveRequests.fields.add(new FileField({
    name: "attachment",
    maxSelect: 1,
    maxSize: 10485760,
    protected: true,
    mimeTypes: [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  }))
  leaveRequests.indexes.push(
    "CREATE INDEX idx_leave_requests_type ON leave_requests (organization, leaveType, startDate)",
  )
  app.save(leaveRequests)

  const expenseCategories = new Collection({
    type: "base",
    name: "expense_categories",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization",
    createRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && organization = @request.auth.organization",
    deleteRule:
      "@request.auth.id != '' && @request.auth.role = 'admin' && organization = @request.auth.organization",
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
      { name: "color", type: "text", required: true, min: 4, max: 9 },
      { name: "limitAmount", type: "number", min: 0, max: 1000000 },
      { name: "active", type: "bool" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_expense_categories_name ON expense_categories (organization, name)",
    ],
  })
  app.save(expenseCategories)

  const expenses = new Collection({
    type: "base",
    name: "expenses",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    createRule:
      "@request.auth.id != '' && @request.body.employee = @request.auth.id && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    deleteRule:
      "@request.auth.id != '' && organization = @request.auth.organization && employee = @request.auth.id && status = 'draft'",
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
        name: "employee",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      {
        name: "category",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: expenseCategories.id,
        cascadeDelete: false,
      },
      { name: "merchant", type: "text", required: true, max: 160 },
      { name: "expenseDate", type: "date", required: true },
      { name: "amount", type: "number", required: true, min: 0.01, max: 1000000 },
      { name: "currency", type: "text", required: true, min: 3, max: 3 },
      { name: "description", type: "text", max: 1000 },
      {
        name: "receipt",
        type: "file",
        maxSelect: 1,
        maxSize: 10485760,
        protected: true,
        mimeTypes: ["application/pdf", "image/jpeg", "image/png", "image/webp"],
      },
      {
        name: "status",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["draft", "pending", "changes_requested", "approved", "rejected", "paid"],
      },
      { name: "outOfPolicy", type: "bool" },
      { name: "reviewComment", type: "text", max: 1000 },
      {
        name: "reviewedBy",
        type: "relation",
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "reviewedAt", type: "date" },
      { name: "paidAt", type: "date" },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE INDEX idx_expenses_org_status ON expenses (organization, status, expenseDate)",
      "CREATE INDEX idx_expenses_employee_date ON expenses (employee, expenseDate)",
    ],
  })
  app.save(expenses)

  const employeeDocuments = new Collection({
    type: "base",
    name: "employee_documents",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (visibility = 'company' || employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (visibility = 'company' || employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    createRule:
      "@request.auth.id != '' && @request.body.organization = @request.auth.organization && (@request.body.employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    updateRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    deleteRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin')",
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
        name: "employee",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "title", type: "text", required: true, max: 160 },
      {
        name: "category",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["contract", "payroll", "identity", "medical", "training", "other"],
      },
      {
        name: "visibility",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["employee", "company", "management"],
      },
      {
        name: "file",
        type: "file",
        required: true,
        maxSelect: 1,
        maxSize: 15728640,
        protected: true,
        mimeTypes: [
          "application/pdf",
          "image/jpeg",
          "image/png",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
      },
      { name: "acknowledgementRequired", type: "bool" },
      { name: "acknowledgedAt", type: "date" },
      {
        name: "uploadedBy",
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
      "CREATE INDEX idx_employee_documents_owner ON employee_documents (organization, employee, category)",
    ],
  })
  app.save(employeeDocuments)

  const employeeTasks = new Collection({
    type: "base",
    name: "employee_tasks",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (assignee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (assignee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    createRule:
      "@request.auth.id != '' && (@request.auth.role = 'admin' || @request.auth.role = 'manager') && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (assignee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    deleteRule:
      "@request.auth.id != '' && organization = @request.auth.organization && @request.auth.role = 'admin'",
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
        name: "assignee",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "title", type: "text", required: true, max: 160 },
      { name: "description", type: "text", max: 1000 },
      {
        name: "category",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["onboarding", "training", "administrative", "other"],
      },
      { name: "dueDate", type: "date" },
      { name: "required", type: "bool" },
      {
        name: "status",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["pending", "in_progress", "completed", "cancelled"],
      },
      { name: "completedAt", type: "date" },
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
      "CREATE INDEX idx_employee_tasks_assignee ON employee_tasks (assignee, status, dueDate)",
    ],
  })
  app.save(employeeTasks)

  const goals = new Collection({
    type: "base",
    name: "goals",
    listRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || public = true || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    viewRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || public = true || @request.auth.role = 'admin' || @request.auth.role = 'manager' || @request.auth.role = 'representative')",
    createRule:
      "@request.auth.id != '' && (@request.auth.role = 'admin' || @request.auth.role = 'manager') && @request.body.organization = @request.auth.organization",
    updateRule:
      "@request.auth.id != '' && organization = @request.auth.organization && (employee = @request.auth.id || @request.auth.role = 'admin' || @request.auth.role = 'manager')",
    deleteRule:
      "@request.auth.id != '' && organization = @request.auth.organization && @request.auth.role = 'admin'",
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
        name: "employee",
        type: "relation",
        required: true,
        maxSelect: 1,
        collectionId: users.id,
        cascadeDelete: false,
      },
      { name: "title", type: "text", required: true, max: 180 },
      { name: "description", type: "text", max: 1500 },
      { name: "cycle", type: "text", required: true, max: 80 },
      { name: "dueDate", type: "date" },
      { name: "progress", type: "number", min: 0, max: 100 },
      {
        name: "status",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["draft", "active", "completed", "cancelled"],
      },
      { name: "public", type: "bool" },
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
      "CREATE INDEX idx_goals_employee_status ON goals (employee, status, dueDate)",
    ],
  })
  app.save(goals)
}, (app) => {
  try {
    const leaveRequests = app.findCollectionByNameOrId("leave_requests")
    leaveRequests.fields.removeByName("leaveType")
    leaveRequests.fields.removeByName("requestedDays")
    leaveRequests.fields.removeByName("assignedBy")
    leaveRequests.fields.removeByName("attachment")
    app.save(leaveRequests)
  } catch (_) {
    // Supports partial rollback during local development.
  }

  for (const name of [
    "goals",
    "employee_tasks",
    "employee_documents",
    "expenses",
    "expense_categories",
    "public_holidays",
    "leave_blackout_periods",
    "leave_balances",
    "leave_types",
  ]) {
    try {
      app.delete(app.findCollectionByNameOrId(name))
    } catch (_) {
      // Supports partial rollback during local development.
    }
  }
})
