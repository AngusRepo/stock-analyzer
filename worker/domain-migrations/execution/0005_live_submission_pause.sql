-- One-way submission stop. Do not change broker orders, positions or Paper books.
CREATE TABLE IF NOT EXISTS live_submission_pause (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    request_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    paused_at TEXT NOT NULL
);
