migrate(
  (app) => {
    const organizations = app.findCollectionByNameOrId("organizations")
    for (const field of [
      new TextField({ name: "addressLine1", max: 200 }),
      new TextField({ name: "addressLine2", max: 200 }),
      new TextField({
        name: "postalCode",
        max: 5,
        pattern: "^[0-9]{5}$",
      }),
      new SelectField({ name: "countryCode", maxSelect: 1, values: ["ES"] }),
      new TextField({ name: "autonomousCommunityCode", max: 3 }),
      new TextField({ name: "autonomousCommunitySlug", max: 80 }),
      new TextField({ name: "autonomousCommunityName", max: 120 }),
      new TextField({ name: "provinceCode", max: 4 }),
      new TextField({ name: "provinceSlug", max: 80 }),
      new TextField({ name: "provinceName", max: 120 }),
      new TextField({ name: "municipalityIne", max: 5, pattern: "^[0-9]{5}$" }),
      new TextField({ name: "municipalitySlug", max: 100 }),
      new TextField({ name: "municipalityName", max: 160 }),
      new DateField({ name: "locationUpdatedAt" }),
    ]) {
      organizations.fields.add(field)
    }
    app.save(organizations)

    const holidays = app.findCollectionByNameOrId("public_holidays")
    holidays.fields.add(
      new SelectField({
        name: "scope",
        maxSelect: 1,
        values: ["nacional", "autonomico", "provincial", "local", "manual"],
      }),
    )
    holidays.fields.add(new TextField({ name: "source", max: 200 }))
    holidays.fields.add(new TextField({ name: "sourceUrl", max: 500 }))
    holidays.fields.add(
      new SelectField({
        name: "importProvider",
        maxSelect: 1,
        values: ["calendariosnacionales"],
      }),
    )
    holidays.fields.add(new DateField({ name: "importedAt" }))
    app.save(holidays)
  },
  (app) => {
    const holidays = app.findCollectionByNameOrId("public_holidays")
    for (const name of ["scope", "source", "sourceUrl", "importProvider", "importedAt"]) {
      holidays.fields.removeByName(name)
    }
    app.save(holidays)

    const organizations = app.findCollectionByNameOrId("organizations")
    for (const name of [
      "addressLine1",
      "addressLine2",
      "postalCode",
      "countryCode",
      "autonomousCommunityCode",
      "autonomousCommunitySlug",
      "autonomousCommunityName",
      "provinceCode",
      "provinceSlug",
      "provinceName",
      "municipalityIne",
      "municipalitySlug",
      "municipalityName",
      "locationUpdatedAt",
    ]) {
      organizations.fields.removeByName(name)
    }
    app.save(organizations)
  },
)
