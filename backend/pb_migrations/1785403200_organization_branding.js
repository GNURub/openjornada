migrate(
  (app) => {
    const organizations = app.findCollectionByNameOrId("organizations");

    organizations.fields.add(
      new TextField({
        name: "brandPrimaryColor",
        max: 7,
        pattern: "^#[0-9a-fA-F]{6}$",
      }),
    );
    organizations.fields.add(
      new TextField({
        name: "brandSecondaryColor",
        max: 7,
        pattern: "^#[0-9a-fA-F]{6}$",
      }),
    );
    organizations.fields.add(
      new FileField({
        name: "brandLogo",
        maxSelect: 1,
        maxSize: 5242880,
        protected: false,
        mimeTypes: ["image/png", "image/jpeg", "image/webp"],
      }),
    );
    organizations.fields.add(
      new TextField({
        name: "pwaName",
        max: 50,
      }),
    );
    organizations.fields.add(
      new TextField({
        name: "pwaShortName",
        max: 20,
      }),
    );
    organizations.fields.add(
      new FileField({
        name: "pwaIcon",
        maxSelect: 1,
        maxSize: 2097152,
        protected: false,
        mimeTypes: ["image/png"],
      }),
    );

    app.save(organizations);
  },
  (app) => {
    const organizations = app.findCollectionByNameOrId("organizations");
    organizations.fields.removeByName("brandPrimaryColor");
    organizations.fields.removeByName("brandSecondaryColor");
    organizations.fields.removeByName("brandLogo");
    organizations.fields.removeByName("pwaName");
    organizations.fields.removeByName("pwaShortName");
    organizations.fields.removeByName("pwaIcon");
    app.save(organizations);
  },
);
