CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    event TEXT NOT NULL,
    action TEXT,
    status TEXT NOT NULL,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO webhook_deliveries (
    delivery_id, provider, event, action, status, received_at, updated_at
)
SELECT
    delivery_id,
    'github',
    event,
    action,
    status,
    received_at,
    updated_at
FROM github_deliveries;
