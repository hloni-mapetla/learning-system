-- Schema v4: momentum, phase 1. Subtasks (ordered next actions) and a per-task event log.
-- Additive only: no table is rebuilt, and existing tasks, cards and review history are untouched.

-- ---- subtasks: one level of ordered steps under a task ----
CREATE TABLE subtasks (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  sort_order   REAL NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_by   TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','claude','system')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX subtasks_task ON subtasks (task_id, sort_order);
CREATE INDEX subtasks_completed ON subtasks (completed_at) WHERE completed_at IS NOT NULL;

-- A task small enough to need no steps (it won't be flagged "needs a first step").
ALTER TABLE tasks ADD COLUMN single_step INTEGER NOT NULL DEFAULT 0 CHECK (single_step IN (0, 1));
-- Existing tasks were all created from the UI or before attribution existed; they count as the user's.
ALTER TABLE tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','claude','system'));

-- ---- task_events: what happened to a task and when (progress, done list, "keeps getting moved") ----
-- session_id is filled in from phase 2 (focus/starter sessions); no FK until that table exists.
CREATE TABLE task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  subtask_id  TEXT REFERENCES subtasks (id) ON DELETE SET NULL,
  session_id  TEXT,
  type        TEXT NOT NULL CHECK (type IN ('steps_defined','subtask_done','subtask_undone','task_done','task_reopened','rescheduled')),
  detail      TEXT, -- JSON, e.g. {"from":"2026-10-20","to":"2026-10-22"} for rescheduled
  created_by  TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','claude','system')),
  at          TEXT NOT NULL
);
CREATE INDEX task_events_task ON task_events (task_id, at);
CREATE INDEX task_events_at ON task_events (at, type);
