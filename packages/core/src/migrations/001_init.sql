-- Loom schema v1. All timestamps are ISO-8601 UTC strings; ids are ULIDs.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('chunks_version', '0');

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON
);

CREATE TABLE sources (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'book'
              CHECK (kind IN ('book','article','paper','video','lecture','podcast','other')),
  title       TEXT NOT NULL,
  authors     TEXT NOT NULL DEFAULT '',
  url         TEXT,
  published   TEXT,
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','reading','done','abandoned')),
  priority    INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  description TEXT NOT NULL DEFAULT '',
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX sources_status ON sources (status, priority);
CREATE INDEX sources_title ON sources (title COLLATE NOCASE);

CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'note'
             CHECK (kind IN ('note','highlight','concept','claim','summary')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  quote      TEXT,
  location   TEXT,
  source_id  TEXT REFERENCES sources (id) ON DELETE SET NULL,
  aliases    TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  dedupe_key TEXT,                       -- importers use this to skip re-imports
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX notes_source ON notes (source_id);
CREATE INDEX notes_title ON notes (title COLLATE NOCASE);
CREATE INDEX notes_kind ON notes (kind);
CREATE UNIQUE INDEX notes_dedupe ON notes (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Typed, directed links between notes and/or sources.
-- Unresolved wikilinks have to_id NULL and keep target_title until a matching note appears.
CREATE TABLE links (
  id           TEXT PRIMARY KEY,
  from_type    TEXT NOT NULL CHECK (from_type IN ('note','source')),
  from_id      TEXT NOT NULL,
  to_type      TEXT NOT NULL CHECK (to_type IN ('note','source')),
  to_id        TEXT,
  target_title TEXT,
  rel          TEXT NOT NULL
               CHECK (rel IN ('wikilink','supports','contradicts','example_of','prerequisite_of','related')),
  rationale    TEXT,
  created_by   TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','claude','system')),
  created_at   TEXT NOT NULL
);
CREATE INDEX links_from ON links (from_type, from_id);
CREATE INDEX links_to ON links (to_type, to_id);
CREATE INDEX links_dangling ON links (target_title COLLATE NOCASE) WHERE to_id IS NULL;
CREATE UNIQUE INDEX links_unique_typed ON links (from_type, from_id, to_type, to_id, rel)
  WHERE to_id IS NOT NULL AND rel <> 'wikilink';

CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE item_tags (
  tag_id    INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK (item_type IN ('note','source','card')),
  item_id   TEXT NOT NULL,
  PRIMARY KEY (tag_id, item_type, item_id)
);
CREATE INDEX item_tags_item ON item_tags (item_type, item_id);

-- Spaced-repetition cards. FSRS state columns mirror ts-fsrs's Card.
CREATE TABLE cards (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('basic','cloze','open','synthesis')),
  origin         TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','note_cloze')),
  front          TEXT NOT NULL,
  back           TEXT NOT NULL DEFAULT '',
  rubric         TEXT,
  note_id        TEXT REFERENCES notes (id) ON DELETE CASCADE, -- set for note-synced clozes
  cloze_index    INTEGER,
  suspended      INTEGER NOT NULL DEFAULT 0,
  created_by     TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','claude','system')),
  due            TEXT NOT NULL,
  stability      REAL NOT NULL DEFAULT 0,
  difficulty     REAL NOT NULL DEFAULT 0,
  elapsed_days   INTEGER NOT NULL DEFAULT 0,
  scheduled_days INTEGER NOT NULL DEFAULT 0,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  reps           INTEGER NOT NULL DEFAULT 0,
  lapses         INTEGER NOT NULL DEFAULT 0,
  state          INTEGER NOT NULL DEFAULT 0, -- 0 New, 1 Learning, 2 Review, 3 Relearning
  last_review    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX cards_due ON cards (suspended, due);
CREATE UNIQUE INDEX cards_note_cloze ON cards (note_id, cloze_index) WHERE origin = 'note_cloze';

-- Where a card came from. Synthesis cards reference 2+ items from different sources.
CREATE TABLE card_refs (
  card_id  TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('note','source')),
  ref_id   TEXT NOT NULL,
  PRIMARY KEY (card_id, ref_type, ref_id)
);
CREATE INDEX card_refs_ref ON card_refs (ref_type, ref_id);

CREATE TABLE review_logs (
  id                TEXT PRIMARY KEY,
  card_id           TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
  rating            INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  state             INTEGER NOT NULL,  -- state before the review
  due               TEXT NOT NULL,     -- due before the review
  stability         REAL NOT NULL,     -- after
  difficulty        REAL NOT NULL,     -- after
  elapsed_days      INTEGER NOT NULL,
  last_elapsed_days INTEGER NOT NULL,
  scheduled_days    INTEGER NOT NULL,
  learning_steps    INTEGER NOT NULL,
  reviewed_at       TEXT NOT NULL,
  duration_ms       INTEGER,
  grader            TEXT NOT NULL DEFAULT 'self' CHECK (grader IN ('self','claude')),
  notes             TEXT,
  prev_card         TEXT NOT NULL      -- JSON snapshot of the card before review, for undo
);
CREATE INDEX review_logs_card ON review_logs (card_id, reviewed_at);
CREATE INDEX review_logs_time ON review_logs (reviewed_at);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'todo'
               CHECK (kind IN ('todo','read','process_highlights','summarize','write')),
  details      TEXT NOT NULL DEFAULT '',
  source_id    TEXT REFERENCES sources (id) ON DELETE SET NULL,
  note_id      TEXT REFERENCES notes (id) ON DELETE SET NULL,
  due_date     TEXT, -- YYYY-MM-DD, local
  priority     INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  completed_at TEXT,
  sort_order   REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX tasks_status ON tasks (status, due_date);

-- Embedding chunks for semantic search.
CREATE TABLE chunks (
  id         INTEGER PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('note','source')),
  owner_id   TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  text       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  model      TEXT NOT NULL,
  vector     BLOB NOT NULL, -- little-endian float32, L2-normalised
  UNIQUE (owner_type, owner_id, idx)
);
CREATE TABLE embed_queue (
  owner_type TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  queued_at  TEXT NOT NULL,
  PRIMARY KEY (owner_type, owner_id)
);
CREATE TRIGGER chunks_ver_i AFTER INSERT ON chunks BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'chunks_version'; END;
CREATE TRIGGER chunks_ver_u AFTER UPDATE ON chunks BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'chunks_version'; END;
CREATE TRIGGER chunks_ver_d AFTER DELETE ON chunks BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'chunks_version'; END;

-- Full-text search. Plain (non external-content) FTS tables keyed by the text id,
-- kept in sync with triggers, so VACUUM can never desynchronise rowids.
CREATE VIRTUAL TABLE notes_fts USING fts5 (id UNINDEXED, title, body, quote, tokenize = 'porter unicode61');
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

CREATE VIRTUAL TABLE sources_fts USING fts5 (id UNINDEXED, title, authors, description, tokenize = 'porter unicode61');
CREATE TRIGGER sources_fts_i AFTER INSERT ON sources BEGIN
  INSERT INTO sources_fts (id, title, authors, description) VALUES (new.id, new.title, new.authors, new.description);
END;
CREATE TRIGGER sources_fts_u AFTER UPDATE OF title, authors, description ON sources BEGIN
  DELETE FROM sources_fts WHERE id = old.id;
  INSERT INTO sources_fts (id, title, authors, description) VALUES (new.id, new.title, new.authors, new.description);
END;
CREATE TRIGGER sources_fts_d AFTER DELETE ON sources BEGIN
  DELETE FROM sources_fts WHERE id = old.id;
END;

CREATE VIRTUAL TABLE cards_fts USING fts5 (id UNINDEXED, front, back, tokenize = 'porter unicode61');
CREATE TRIGGER cards_fts_i AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts (id, front, back) VALUES (new.id, new.front, new.back);
END;
CREATE TRIGGER cards_fts_u AFTER UPDATE OF front, back ON cards BEGIN
  DELETE FROM cards_fts WHERE id = old.id;
  INSERT INTO cards_fts (id, front, back) VALUES (new.id, new.front, new.back);
END;
CREATE TRIGGER cards_fts_d AFTER DELETE ON cards BEGIN
  DELETE FROM cards_fts WHERE id = old.id;
END;

-- Polymorphic rows (links, tags, chunks, card refs) cleaned up when their owner goes away.
CREATE TRIGGER notes_cleanup AFTER DELETE ON notes BEGIN
  DELETE FROM links WHERE from_type = 'note' AND from_id = old.id;
  UPDATE links SET to_id = NULL, target_title = old.title WHERE to_type = 'note' AND to_id = old.id AND rel = 'wikilink';
  DELETE FROM links WHERE to_type = 'note' AND to_id = old.id;
  DELETE FROM item_tags WHERE item_type = 'note' AND item_id = old.id;
  DELETE FROM chunks WHERE owner_type = 'note' AND owner_id = old.id;
  DELETE FROM embed_queue WHERE owner_type = 'note' AND owner_id = old.id;
  DELETE FROM card_refs WHERE ref_type = 'note' AND ref_id = old.id;
END;
CREATE TRIGGER sources_cleanup AFTER DELETE ON sources BEGIN
  DELETE FROM links WHERE (from_type = 'source' AND from_id = old.id);
  UPDATE links SET to_id = NULL, target_title = old.title WHERE to_type = 'source' AND to_id = old.id AND rel = 'wikilink';
  DELETE FROM links WHERE to_type = 'source' AND to_id = old.id;
  DELETE FROM item_tags WHERE item_type = 'source' AND item_id = old.id;
  DELETE FROM chunks WHERE owner_type = 'source' AND owner_id = old.id;
  DELETE FROM embed_queue WHERE owner_type = 'source' AND owner_id = old.id;
  DELETE FROM card_refs WHERE ref_type = 'source' AND ref_id = old.id;
END;
CREATE TRIGGER cards_cleanup AFTER DELETE ON cards BEGIN
  DELETE FROM item_tags WHERE item_type = 'card' AND item_id = old.id;
END;
