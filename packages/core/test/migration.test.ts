import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { createLoom } from '../src/index.ts';
import { fakeEmbedder } from './helpers.ts';
import { readdirSync } from 'node:fs';

const LATEST = Math.max(...readdirSync(join(import.meta.dirname, '../src/migrations')).map((f) => parseInt(f, 10)).filter((n) => n > 0));

// Columns that existed in v2; the v3 upgrade must leave every one of them untouched.
const CARD_COLS = 'id,type,origin,front,back,rubric,note_id,cloze_index,suspended,created_by,due,stability,difficulty,elapsed_days,scheduled_days,learning_steps,reps,lapses,state,last_review,created_at,updated_at';
const LOG_COLS = 'id,card_id,rating,state,due,stability,difficulty,elapsed_days,last_elapsed_days,scheduled_days,learning_steps,reviewed_at,duration_ms,grader,notes,prev_card';
const TABLES = ['sources', 'notes', 'cards', 'card_refs', 'review_logs', 'links', 'tags', 'item_tags', 'tasks', 'notes_fts'];

/** A schema-v2 database with real-looking content: imported highlights, a Claude-extracted concept, cloze cards with review history. */
function buildV2(path: string) {
  const db = new Db(path, { migrateTo: 2, backupDir: null });
  const t = '2026-09-01T10:00:00.000Z';
  db.exec(`
    INSERT INTO sources (id, kind, title, authors, status, created_at, updated_at) VALUES
      ('S1', 'book', 'Thinking, Fast and Slow', 'Kahneman', 'reading', '${t}', '${t}'),
      ('S2', 'book', 'Unread book', '', 'queued', '${t}', '${t}');
    INSERT INTO notes (id, kind, title, body, quote, location, source_id, dedupe_key, created_at, updated_at) VALUES
      ('N1', 'highlight', 'Fluency feels like truth', '', 'Fluency feels like truth', 'loc 120', 'S1', 'kindle:abc', '${t}', '${t}'),
      ('N2', 'concept', 'Cognitive ease', 'Ease breeds {{c1::belief}} and {{c2::liking}}.', NULL, NULL, 'S1', NULL, '${t}', '${t}'),
      ('N3', 'note', 'My own musing', 'Something I wrote.', NULL, NULL, NULL, NULL, '${t}', '${t}');
    INSERT INTO links (id, from_type, from_id, to_type, to_id, rel, rationale, created_by, created_at) VALUES
      ('L1', 'note', 'N2', 'note', 'N1', 'related', 'extracted from', 'claude', '${t}'),
      ('L2', 'note', 'N3', 'note', 'N2', 'supports', 'mine', 'user', '${t}');
    INSERT INTO tags (id, name) VALUES (1, 'psychology');
    INSERT INTO item_tags (tag_id, item_type, item_id) VALUES (1, 'source', 'S1'), (1, 'note', 'N2');
    INSERT INTO cards (id, type, origin, front, back, note_id, cloze_index, created_by, due, stability, difficulty, elapsed_days,
        scheduled_days, learning_steps, reps, lapses, state, last_review, created_at, updated_at) VALUES
      ('C1', 'cloze', 'note_cloze', 'Ease breeds {{c1::belief}} and {{c2::liking}}.', '', 'N2', 1, 'user', '2026-10-20T08:00:00.000Z',
        12.34567, 5.4321, 3, 12, 0, 4, 1, 2, '2026-10-08T08:00:00.000Z', '${t}', '${t}'),
      ('C2', 'cloze', 'note_cloze', 'Ease breeds {{c1::belief}} and {{c2::liking}}.', '', 'N2', 2, 'user', '2026-10-25T08:00:00.000Z',
        20.5, 4.9, 5, 20, 0, 3, 0, 2, '2026-10-05T08:00:00.000Z', '${t}', '${t}'),
      ('C3', 'open', 'manual', 'Why does fluency mislead?', 'Ease is mistaken for truth', NULL, NULL, 'claude', '2026-10-30T08:00:00.000Z',
        8.1, 6.2, 1, 8, 0, 2, 0, 2, '2026-10-10T08:00:00.000Z', '${t}', '${t}');
    INSERT INTO card_refs (card_id, ref_type, ref_id) VALUES ('C1', 'note', 'N2'), ('C2', 'note', 'N2'), ('C3', 'note', 'N1');
    INSERT INTO tasks (id, title, kind, source_id, note_id, created_at, updated_at) VALUES
      ('T1', 'Read ch. 5', 'read', 'S1', 'N2', '${t}', '${t}');
  `);
  const prev = JSON.stringify(db.get('SELECT * FROM cards WHERE id = ?', ['C1']));
  for (const [i, [rating, state]] of [[3, 0], [1, 2], [3, 3], [3, 2]].entries()) {
    db.run(
      `INSERT INTO review_logs (id, card_id, rating, state, due, stability, difficulty, elapsed_days, last_elapsed_days, scheduled_days,
         learning_steps, reviewed_at, duration_ms, grader, notes, prev_card)
       VALUES (?, 'C1', ?, ?, ?, ?, 5.4, 1, 0, 3, 0, ?, 4000, ?, ?, ?)`,
      [`R${i}`, rating, state, `2026-09-0${i + 2}T08:00:00.000Z`, 1.5 + i, `2026-09-0${i + 2}T08:00:00.000Z`, i % 2 ? 'claude' : 'self', i % 2 ? 'mixed up ease and priming' : null, prev],
    );
  }
  const snapshot = {
    cards: db.all(`SELECT ${CARD_COLS} FROM cards ORDER BY id`),
    logs: db.all(`SELECT ${LOG_COLS} FROM review_logs ORDER BY id`),
    counts: Object.fromEntries(TABLES.map((x) => [x, db.get<{ n: number }>(`SELECT count(*) AS n FROM ${x}`)!.n])),
  };
  db.close();
  return snapshot;
}

describe('schema v3 migration', () => {
  it('keeps FSRS state, review history and links intact, and backfills authorship and method', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-mig-'));
    const path = join(dir, 'loom.db');
    const before = buildV2(path);

    const loom = createLoom({ dbPath: path, embedder: fakeEmbedder(), db: { backupDir: join(dir, 'backups') } });
    const { db } = loom;
    expect(db.schemaVersion()).toBe(LATEST);
    expect(db.migrationBackup).toMatch(new RegExp(`pre-migration-v2-to-v${LATEST}-.*\\.db$`));
    expect(existsSync(db.migrationBackup!)).toBe(true);
    expect(new Db(db.migrationBackup!, { migrateTo: 2, backupDir: null }).schemaVersion()).toBe(2);

    // Nothing lost or rewritten.
    expect(Object.fromEntries(TABLES.map((x) => [x, db.get<{ n: number }>(`SELECT count(*) AS n FROM ${x}`)!.n]))).toEqual(before.counts);
    expect(db.all(`SELECT ${CARD_COLS} FROM cards ORDER BY id`)).toEqual(before.cards);
    expect(db.all(`SELECT ${LOG_COLS} FROM review_logs ORDER BY id`)).toEqual(before.logs);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys).toBe(1);

    // New columns: authorship backfill, method backfill, defaults on cards/logs.
    expect(Object.fromEntries(db.all<{ id: string; created_by: string }>('SELECT id, created_by FROM notes').map((r) => [r.id, r.created_by]))).toEqual({
      N1: 'system',
      N2: 'claude',
      N3: 'user',
    });
    expect(loom.sources.get('S1').method).toBe('highlights_first');
    expect(loom.sources.get('S2').method).toBeNull();
    expect(loom.cards.get('C3')).toMatchObject({ createdBy: 'claude', stability: 8.1, reps: 2 });
    expect(db.get('SELECT confidence, attempt, context FROM review_logs LIMIT 1')).toEqual({ confidence: null, attempt: null, context: null });

    // Everything still works on the migrated data.
    expect(loom.search.fullText('cognitive ease').map((h) => h.id)).toContain('N2');
    expect(loom.noteDetail('N2').backlinks.map((l) => l.from.id)).toEqual(['N3']);
    expect(loom.cards.list({ noteId: 'N2' }).total).toBe(2); // clozes not regenerated
    loom.notes.update('N2', { body: 'Ease breeds {{c1::belief}} and {{c2::liking}}. Edited.' });
    expect(loom.cards.get('C1')).toMatchObject({ stability: 12.34567, lapses: 1 }); // scheduling survives a note edit
    expect(loom.review.undo('C1')).toMatchObject({ id: 'C1' }); // undo across the migration uses the old snapshot
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM review_logs')!.n).toBe(3);

    // Triggers were recreated: FTS follows edits and deleting a note cleans up its links and cascades its cards.
    expect(loom.search.fullText('edited').map((h) => h.id)).toContain('N2');
    loom.notes.remove('N2');
    expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM cards WHERE note_id = 'N2'`)!.n).toBe(0);
    expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM links WHERE from_id = 'N2' OR to_id = 'N2'`)!.n).toBe(0);
    expect(loom.search.fullText('cognitive ease').map((h) => h.id)).not.toContain('N2');
    loom.close();

    // Reopening an up-to-date database neither migrates nor backs up again.
    const again = createLoom({ dbPath: path, embedder: null, db: { backupDir: join(dir, 'backups') } });
    expect(again.db.migrationBackup).toBeNull();
    again.close();
  });

  it('v3 → v4 adds steps without touching existing tasks, cards or review history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-mig4-'));
    const path = join(dir, 'loom.db');
    const before = buildV2(path);
    const v3 = new Db(path, { migrateTo: 3, backupDir: null });
    const tasksBefore = v3.all('SELECT * FROM tasks ORDER BY id');
    v3.close();

    const loom = createLoom({ dbPath: path, embedder: null, db: { backupDir: join(dir, 'backups') } });
    expect(loom.db.migrationBackup).toMatch(new RegExp(`pre-migration-v3-to-v${LATEST}-.*\\.db$`));
    expect(loom.db.all(`SELECT ${CARD_COLS} FROM cards ORDER BY id`)).toEqual(before.cards);
    expect(loom.db.all(`SELECT ${LOG_COLS} FROM review_logs ORDER BY id`)).toEqual(before.logs);
    const after = loom.db.all<Record<string, unknown>>('SELECT * FROM tasks ORDER BY id');
    expect(after.map(({ single_step, created_by, ...rest }) => rest)).toEqual(tasksBefore);
    expect(after.map((t) => [t.single_step, t.created_by])).toEqual([[0, 'user']]);
    expect(loom.db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(loom.tasks.get('T1')).toMatchObject({ kind: 'read', subtasks: [], needsFirstStep: false });
    loom.subtasks.add('T1', ['Reread the chapter summary page']);
    expect(loom.tasks.get('T1').progress).toEqual({ done: 0, total: 1 });
    loom.close();
  });

  it('v4 → v5 adds sessions without touching tasks, steps or their events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-mig5-'));
    const path = join(dir, 'loom.db');
    buildV2(path);
    const v4 = new Db(path, { migrateTo: 4, backupDir: null });
    v4.exec(`INSERT INTO subtasks (id, task_id, title, sort_order, completed_at, created_at, updated_at)
               VALUES ('ST1', 'T1', 'Reread the summary page', 0, '2026-10-20T09:00:00.000Z', 'x', 'x');
             INSERT INTO task_events (id, task_id, subtask_id, type, at) VALUES ('E1', 'T1', 'ST1', 'subtask_done', '2026-10-20T09:00:00.000Z');`);
    const snap = ['tasks', 'subtasks', 'task_events'].map((t) => v4.all(`SELECT * FROM ${t} ORDER BY id`));
    v4.close();
    const loom = createLoom({ dbPath: path, embedder: null, db: { backupDir: join(dir, 'backups') } });
    expect(loom.db.migrationBackup).toMatch(new RegExp(`pre-migration-v4-to-v${LATEST}-`));
    expect(['tasks', 'subtasks', 'task_events'].map((t) => loom.db.all(`SELECT * FROM ${t} ORDER BY id`))).toEqual(snap);
    expect(loom.db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(loom.sessions.start({ kind: 'starter', subtaskId: 'ST1' }).taskId).toBe('T1');
    loom.close();
  });

  it('v5 → v6 adds days and the routine without touching tasks, steps, events or sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-mig6-'));
    const path = join(dir, 'loom.db');
    const before = buildV2(path);
    const v5 = new Db(path, { migrateTo: 5, backupDir: null });
    v5.exec(`INSERT INTO subtasks (id, task_id, title, sort_order, created_at, updated_at) VALUES ('ST1', 'T1', 'Reread the summary page', 0, 'x', 'x');
             INSERT INTO sessions (id, kind, task_id, subtask_id, planned_minutes, started_at, ended_at, outcome)
               VALUES ('S1', 'starter', 'T1', 'ST1', 10, '2026-10-20T09:00:00.000Z', '2026-10-20T09:10:00.000Z', 'completed');`);
    const tables = ['tasks', 'subtasks', 'task_events', 'sessions'];
    const snap = tables.map((t) => v5.all(`SELECT * FROM ${t} ORDER BY id`));
    v5.close();
    const loom = createLoom({ dbPath: path, embedder: null, db: { backupDir: join(dir, 'backups') } });
    expect(loom.db.migrationBackup).toMatch(new RegExp(`pre-migration-v5-to-v${LATEST}-`));
    expect(tables.map((t) => loom.db.all(`SELECT * FROM ${t} ORDER BY id`))).toEqual(snap);
    expect(loom.db.all(`SELECT ${CARD_COLS} FROM cards ORDER BY id`)).toEqual(before.cards);
    expect(loom.db.all(`SELECT ${LOG_COLS} FROM review_logs ORDER BY id`)).toEqual(before.logs);
    expect(loom.db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(loom.days.plan('tomorrow', { taskId: 'T1' }).day.firstThing!.step!.id).toBe('ST1');
    loom.close();
  });

  it('v6 → v7 adds the minimum snapshot and rating time to days without touching them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-mig7-'));
    const path = join(dir, 'loom.db');
    buildV2(path);
    const v6 = new Db(path, { migrateTo: 6, backupDir: null });
    v6.exec(`INSERT INTO days (date, wake_at, first_task_id, target_start, rating, created_at, updated_at)
               VALUES ('2026-10-21', '2026-10-21T06:10:00.000Z', 'T1', '08:30', 4, 'x', 'x');`);
    const before = v6.all('SELECT * FROM days');
    const tasks = v6.all('SELECT * FROM tasks ORDER BY id');
    v6.close();
    const loom = createLoom({ dbPath: path, embedder: null, db: { backupDir: join(dir, 'backups') } });
    const after = loom.db.all<Record<string, unknown>>('SELECT * FROM days');
    expect(after.map(({ minimum_met, minimum_rule, rated_at, ...rest }) => rest)).toEqual(before);
    expect(after[0]).toMatchObject({ minimum_met: null, minimum_rule: null, rated_at: null });
    expect(loom.db.all('SELECT * FROM tasks ORDER BY id')).toEqual(tasks);
    expect(loom.db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(loom.days.get('2026-10-21')).toMatchObject({ rating: 4, targetStart: '08:30' });
    loom.close();
  });

  it('does not back up a brand-new database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loom-new-'));
    const loom = createLoom({ dbPath: join(dir, 'loom.db'), embedder: null, db: { backupDir: join(dir, 'backups') } });
    expect(loom.db.schemaVersion()).toBe(LATEST);
    expect(loom.db.migrationBackup).toBeNull();
    loom.close();
  });
});
