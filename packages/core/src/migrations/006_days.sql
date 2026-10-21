-- Schema v6: momentum, phase 3. One row per day (evening plan, wake and work start), and the morning routine.
-- Additive only: new tables; nothing existing is rebuilt.

-- ---- days: keyed by the momentum date (the day rolls over at 4am) ----
CREATE TABLE days (
  date               TEXT PRIMARY KEY CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- When the user got up (logged with one key, editable).
  wake_at            TEXT,
  -- When work started: filled in by the first session of the day, or typed in.
  work_start_at      TEXT,
  work_start_session TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  -- The plan made the evening before: one first task and its concrete first step.
  first_task_id      TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  first_subtask_id   TEXT REFERENCES subtasks (id) ON DELETE SET NULL,
  target_start       TEXT CHECK (target_start IS NULL OR target_start GLOB '[0-2][0-9]:[0-5][0-9]'),
  planned_at         TEXT,
  planned_by         TEXT CHECK (planned_by IS NULL OR planned_by IN ('user','claude','system')),
  -- The evening shutdown step for this day.
  shutdown_at        TEXT,
  -- End-of-day reflection (phase 4).
  rating             INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  reflection         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- ---- routines: an editable checklist template (the morning routine), ticked off per day ----
CREATE TABLE routines (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL UNIQUE CHECK (kind IN ('morning')),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE routine_items (
  id         TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  optional   INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0, 1)),
  -- wake: ticking it logs the wake time; start_first_task: ticked when the first session of the day starts.
  action     TEXT CHECK (action IS NULL OR action IN ('wake','start_first_task')),
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX routine_items_routine ON routine_items (routine_id, sort_order);
CREATE TABLE routine_checks (
  date       TEXT NOT NULL,
  item_id    TEXT NOT NULL REFERENCES routine_items (id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (date, item_id)
);
