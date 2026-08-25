migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId("work_events");
    collection.indexes = collection.indexes.filter(
      (index) => !index.includes("idx_work_events_request"),
    );
    collection.indexes.push(
      "CREATE UNIQUE INDEX idx_work_events_request_org ON work_events (organization, clientRequestId)",
    );
    app.save(collection);
  },
  (app) => {
    const collection = app.findCollectionByNameOrId("work_events");
    collection.indexes = collection.indexes.filter(
      (index) => !index.includes("idx_work_events_request_org"),
    );
    collection.indexes.push(
      "CREATE UNIQUE INDEX idx_work_events_request ON work_events (clientRequestId)",
    );
    app.save(collection);
  },
);
