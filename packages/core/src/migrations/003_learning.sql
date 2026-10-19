-- Schema v3: generation-first learning (see docs/learning-audit.md §3).
-- Runs with foreign keys OFF (see db.ts migrate), so rebuilding `notes` can't cascade into cards/review_logs.
-- `cards` and `review_logs` only gain columns: FSRS state and review history are never rewritten.

-- ---- notes: new kinds (recall, explanation) + authorship. CHECK changes need a rebuild. ----
CREATE TABLE notes_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'note'
             CHECK (kind IN ('note','highlight','concept','claim','summary','recall','explanation')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  quote      TEXT,
  location   TEXT,
  source_id  TEXT REFERENCES sources (id) ON DELETE SET NULL,
  aliases    TEXT NOT NULL DEFAULT '[]',
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','claude','system'))
);
INSERT INTO notes_new (id, kind, title, body, quote, location, source_id, aliases, dedupe_key, created_at, updated_at, created_by)
  SELECT id, kind, title, body, quote, location, source_id, aliases, dedupe_key, created_at, updated_at,
    CASE
      WHEN dedupe_key LIKE 'kindle:%' OR dedupe_key LIKE 'paste:%' THEN 'system' -- imported quotes; Markdown files stay 'user'
      WHEN id IN (SELECT from_id FROM links WHERE from_type = 'note' AND created_by = 'claude' AND rationale = 'extracted from') THEN 'claude'
      ELSE 'user'
    END
  FROM notes;
DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;

CREATE INDEX notes_source ON notes (source_id);
CREATE INDEX notes_title ON notes (title COLLATE NOCASE);
CREATE INDEX notes_kind ON notes (kind);
CREATE UNIQUE INDEX notes_dedupe ON notes (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Triggers on notes were dropped with the old table; notes_fts itself (and its rows) is untouched.
CREATE TRIGGER notes_fts_i AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (id, title, body, quote) VALUES (new.id, new.title, new.body, coalesce(new.quote, ''));
END;
CREATE TRIGGER notes_fts_u AFTER UPDATE OF title, body, quote ON notes BEGIN
  DELETE FROM notes_fts WHERE id = old.id;
  INSERT INTO notes_fts (id, title, body, quote) VALUES (new.id, new.title, new.body, coalesce(new.quote, ''));
END;
CREATE TRIGGER notes_fts_d AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE id = old.id;
END;
CREATE TRIGGER notes_cleanup AFTER DELETE ON notes BEGIN
  DELETE FROM links WHERE from_type = 'note' AND from_id = old.id;
  UPDATE links SET to_id = NULL, target_title = old.title WHERE to_type = 'note' AND to_id = old.id AND rel = 'wikilink';
  DELETE FROM links WHERE to_type = 'note' AND to_id = old.id;
  DELETE FROM item_tags WHERE item_type = 'note' AND item_id = old.id;
  DELETE FROM chunks WHERE owner_type = 'note' AND owner_id = old.id;
  DELETE FROM embed_queue WHERE owner_type = 'note' AND owner_id = old.id;
  DELETE FROM card_refs WHERE ref_type = 'note' AND ref_id = old.id;
END;

-- ---- sources: how each was processed (the recall-first experiment) + authorship ----
ALTER TABLE sources ADD COLUMN method TEXT CHECK (method IN ('recall_first','highlights_first'));
ALTER TABLE sources ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','claude','system'));
-- Sources that already have notes were processed the old way.
UPDATE sources SET method = 'highlights_first' WHERE id IN (SELECT DISTINCT source_id FROM notes WHERE source_id IS NOT NULL);

-- ---- cards: what the prompt asks for (why/how/connect/discriminate are graded on mechanism or relationship) ----
ALTER TABLE cards ADD COLUMN prompt_kind TEXT NOT NULL DEFAULT 'recall'
  CHECK (prompt_kind IN ('recall','why','how','connect','discriminate'));

-- ---- review_logs: calibration and context. Existing rows keep NULL (= unknown). ----
ALTER TABLE review_logs ADD COLUMN confidence INTEGER CHECK (confidence BETWEEN 1 AND 4);
ALTER TABLE review_logs ADD COLUMN attempt TEXT;
ALTER TABLE review_logs ADD COLUMN context TEXT CHECK (context IN ('ui','daily','practice','exam','explain'));

-- ---- exams: spaced exam plans; their sessions are tasks ----
CREATE TABLE exams (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  exam_date        TEXT NOT NULL, -- YYYY-MM-DD, local
  scope            TEXT NOT NULL DEFAULT '{}', -- JSON: { tags, sourceIds, topics }
  session_minutes  INTEGER NOT NULL DEFAULT 25,
  target_retention REAL NOT NULL DEFAULT 0.9,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','cancelled')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
ALTER TABLE tasks ADD COLUMN exam_id TEXT REFERENCES exams (id) ON DELETE SET NULL;
CREATE INDEX tasks_exam ON tasks (exam_id) WHERE exam_id IS NOT NULL;
