routerAdd(
  "GET",
  "/api/openjornada/branding/{organization}/manifest.json",
  (e) => {
    let organization;
    try {
      organization = e.app.findRecordById(
        "organizations",
        e.request.pathValue("organization"),
      );
    } catch (_) {
      throw new NotFoundError("No se ha encontrado la empresa.");
    }

    const primary = organization.getString("brandPrimaryColor") || "#ef4d32";
    const secondary =
      organization.getString("brandSecondaryColor") || "#1c1917";
    const name =
      organization.getString("pwaName") ||
      organization.getString("name") ||
      "OpenJornada";
    const shortName =
      organization.getString("pwaShortName") || name.slice(0, 20);
    const customIcon = organization.getString("pwaIcon");
    let icons;
    if (customIcon) {
      const iconURL =
        "/api/files/" +
        organization.collection().id +
        "/" +
        organization.id +
        "/" +
        encodeURIComponent(customIcon);
      icons = [
        {
          src: iconURL + "?thumb=192x192",
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
        {
          src: iconURL,
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ];
    } else {
      icons = [
        {
          src: "/icons/icon-192x192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/icons/icon-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/icons/icon-maskable-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ];
    }

    e.response.header().set("Cache-Control", "no-store");
    return e.json(200, {
      id: "/organizations/" + organization.id,
      name,
      short_name: shortName,
      description: "Gestión laboral y registro de jornada para " + name + ".",
      lang: "es",
      start_url: "/?organization=" + organization.id,
      scope: "/",
      display: "standalone",
      background_color: "#fafaf9",
      theme_color: secondary,
      icons,
    });
  },
);
