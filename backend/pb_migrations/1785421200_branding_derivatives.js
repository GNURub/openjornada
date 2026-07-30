migrate(
  (app) => {
    const organizations = app.findCollectionByNameOrId("organizations");
    const icon = organizations.fields.getByName("pwaIcon");
    icon.thumbs = ["16x16", "32x32", "180x180", "192x192"];
    app.save(organizations);
  },
  (app) => {
    const organizations = app.findCollectionByNameOrId("organizations");
    const icon = organizations.fields.getByName("pwaIcon");
    icon.thumbs = [];
    app.save(organizations);
  },
);
