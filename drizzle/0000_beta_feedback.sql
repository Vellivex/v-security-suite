CREATE TABLE feedback (
 id TEXT PRIMARY KEY NOT NULL,
 created_at TEXT NOT NULL,
 product TEXT NOT NULL,
 kind TEXT NOT NULL,
 os TEXT NOT NULL,
 message TEXT NOT NULL,
 rate_key TEXT NOT NULL,
 is_test INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX feedback_rate_idx ON feedback(rate_key, created_at);
--> statement-breakpoint
CREATE INDEX feedback_created_idx ON feedback(created_at);
