# SQLite for Run State persistence

The orchestrator persists Run State in a local SQLite database rather than a JSON file. We chose SQLite over a flat file because it supports querying across runs (e.g., "show all failed tasks"), handles concurrent access safely, and is more robust for large task graphs. The trade-off is an added dependency, but SQLite is embedded (no server) and well-supported in Node.js. A JSON file would be simpler but would require custom querying logic and is fragile under concurrent writes.
