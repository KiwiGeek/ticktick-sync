CREATE TABLE IF NOT EXISTS oauth_tokens (
    provider TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS synced_items (
    source TEXT NOT NULL,
    source_repo TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    source_item_number INTEGER,
    source_url TEXT NOT NULL,
    ticktick_project_id TEXT NOT NULL,
    ticktick_task_id TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, source_repo, source_item_id)
);

CREATE TABLE IF NOT EXISTS github_deliveries (
    delivery_id TEXT PRIMARY KEY,
    event TEXT NOT NULL,
    action TEXT,
    status TEXT NOT NULL,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
