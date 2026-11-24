PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;

CREATE TABLE failure_dedup (
  fingerprint TEXT PRIMARY KEY,
  failure_kind TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  claim_token TEXT,
  claimed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_eligible_at TEXT,
  last_outcome TEXT,
  last_repair_task_id TEXT,
  budget_consumed_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_failure_dedup_eligible ON failure_dedup(status, next_eligible_at);
