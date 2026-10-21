-- Schema v5: momentum, phase 2. Starter sessions ("just 10 minutes") and focus blocks.
-- Additive only: a new table; nothing existing is rebuilt.

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('starter','focus')),
  task_id         TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  subtask_id      TEXT REFERENCES subtasks (id) ON DELETE SET NULL,
  -- Titles at start time, so the log still reads well after a task is renamed or deleted.
  task_title      TEXT,
  subtask_title   TEXT,
  planned_minutes REAL NOT NULL CHECK (planned_minutes > 0),
  break_minutes   REAL NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  -- NULL while running. completed: ran its planned length; stopped: ended early ("stop here, that counts");
  -- continued: a starter that rolled into a focus block; abandoned: discarded, or left running and never closed.
  outcome         TEXT CHECK (outcome IN ('completed','stopped','continued','abandoned')),
  continued_from  TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  created_by      TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','claude','system')),
  CHECK ((ended_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX sessions_started ON sessions (started_at);
CREATE INDEX sessions_task ON sessions (task_id) WHERE task_id IS NOT NULL;
-- At most one running session.
CREATE UNIQUE INDEX sessions_one_running ON sessions ((1)) WHERE ended_at IS NULL;
CREATE INDEX task_events_session ON task_events (session_id) WHERE session_id IS NOT NULL;
