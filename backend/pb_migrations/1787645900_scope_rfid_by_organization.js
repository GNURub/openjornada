migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.indexes = users.indexes.filter(
      (index) => !index.includes("idx_users_rfid_uid"),
    );
    users.indexes.push(
      "CREATE UNIQUE INDEX idx_users_rfid_uid_org ON users (organization, rfidUidFingerprint) WHERE rfidUidFingerprint != ''",
    );
    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.indexes = users.indexes.filter(
      (index) => !index.includes("idx_users_rfid_uid_org"),
    );
    users.indexes.push(
      "CREATE UNIQUE INDEX idx_users_rfid_uid ON users (rfidUidFingerprint) WHERE rfidUidFingerprint != ''",
    );
    app.save(users);
  },
);
