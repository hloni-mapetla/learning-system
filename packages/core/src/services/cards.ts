import { fsrs, type Card as FsrsCard } from 'ts-fsrs';
import type { Ctx } from './context.ts';
import type { Actor, CardStateName, CardType, CardView, ItemType } from '../types.ts';
import { CARD_STATES } from '../types.ts';
import type { CardCreate, CardPatch, ItemRefInput } from '../schemas.ts';
import type { Tags } from './tags.ts';
import { describeItems, itemExists, provenanceKey } from './items.ts';
import { clozeAnswer, clozeContext, clozeHidden, clozeIndices, clozePrompt } from './cloze.ts';
import { newId, nowIso, NotFoundError, ValidationError } from '../util.ts';

export interface CardRow {
  id: string;
  type: CardType;
  origin: 'manual' | 'note_cloze';
  front: string;
  back: string;
  rubric: string | null;
  note_id: string | null;
  cloze_index: number | null;
  suspended: number;
  created_by: Actor;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToFsrs(r: CardRow): FsrsCard {
  return {
    due: new Date(r.due),
    stability: r.stability,
    difficulty: r.difficulty,
    elapsed_days: r.elapsed_days,
    scheduled_days: r.scheduled_days,
    learning_steps: r.learning_steps,
    reps: r.reps,
    lapses: r.lapses,
    state: r.state,
    last_review: r.last_review ? new Date(r.last_review) : undefined,
  };
}

const retrievabilityCalc = fsrs();

export function retrievability(r: CardRow, now = new Date()): number | null {
  if (r.state === 0 || !r.last_review) return null;
  return retrievabilityCalc.get_retrievability(rowToFsrs(r), now, false);
}

/** Which cards relate to an item: refs to it, plus (for sources) refs to its notes. */
export const CARDS_FOR_ITEM_SQL = `
  SELECT card_id FROM card_refs WHERE ref_type = :type AND ref_id = :id
  UNION
  SELECT cr.card_id FROM card_refs cr JOIN notes n ON cr.ref_type = 'note' AND n.id = cr.ref_id
   WHERE :type = 'source' AND n.source_id = :id`;

/** Cards whose own tags, refs' tags, or refs' source's tags match :topic (a tag or tag prefix). */
export const CARDS_FOR_TAG_SQL = `
  SELECT it.item_id AS card_id FROM item_tags it JOIN tags t ON t.id = it.tag_id
   WHERE it.item_type = 'card' AND (t.name = :topic OR t.name LIKE :topic || '/%')
  UNION
  SELECT cr.card_id FROM card_refs cr
   JOIN item_tags it ON it.item_type = cr.ref_type AND it.item_id = cr.ref_id JOIN tags t ON t.id = it.tag_id
   WHERE (t.name = :topic OR t.name LIKE :topic || '/%')
  UNION
  SELECT cr.card_id FROM card_refs cr JOIN notes n ON cr.ref_type = 'note' AND n.id = cr.ref_id
   JOIN item_tags it ON it.item_type = 'source' AND it.item_id = n.source_id JOIN tags t ON t.id = it.tag_id
   WHERE (t.name = :topic OR t.name LIKE :topic || '/%')`;

export interface CardListOpts {
  ids?: string[];
  noteId?: string;
  sourceId?: string;
  tag?: string;
  type?: CardType;
  state?: CardStateName;
  suspended?: boolean;
  sort?: 'due' | 'created' | 'weakest';
  limit?: number;
  offset?: number;
}

export function createCards(ctx: Ctx, tags: Tags) {
  const { db } = ctx;

  function hydrate(rows: CardRow[], now = new Date()): CardView[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const refRows = db.all<{ card_id: string; ref_type: ItemType; ref_id: string }>(
      'SELECT * FROM card_refs WHERE card_id IN (SELECT value FROM json_each(?)) ORDER BY rowid',
      [JSON.stringify(ids)],
    );
    const refs = describeItems(db, refRows.map((r) => ({ type: r.ref_type, id: r.ref_id })));
    const tagMap = tags.getMany('card', ids);
    return rows.map((r) => {
      const isCloze = r.type === 'cloze' && r.cloze_index != null;
      const n = r.cloze_index ?? 1;
      return {
        id: r.id,
        type: r.type,
        prompt: isCloze ? clozePrompt(r.front, n) : r.front,
        answer: isCloze ? [clozeAnswer(r.front, n), r.back].filter(Boolean).join('\n\n') : r.back,
        hidden: isCloze ? clozeHidden(r.front, n) : undefined,
        rubric: r.rubric,
        front: r.front,
        back: r.back,
        noteId: r.note_id,
        clozeIndex: r.cloze_index,
        origin: r.origin,
        suspended: !!r.suspended,
        createdBy: r.created_by,
        refs: refRows.filter((x) => x.card_id === r.id).map((x) => refs.get(`${x.ref_type}:${x.ref_id}`)!).filter(Boolean),
        tags: tagMap.get(r.id) ?? [],
        state: CARD_STATES[r.state],
        due: r.due,
        stability: r.stability,
        difficulty: r.difficulty,
        reps: r.reps,
        lapses: r.lapses,
        lastReview: r.last_review,
        retrievability: retrievability(r, now),
        createdAt: r.created_at,
      };
    });
  }

  function row(id: string): CardRow {
    const r = db.get<CardRow>('SELECT * FROM cards WHERE id = ?', [id]);
    if (!r) throw new NotFoundError('card', id);
    return r;
  }

  function get(id: string): CardView {
    return hydrate([row(id)])[0];
  }

  function validateRefs(type: CardType, refs: ItemRefInput[]): void {
    for (const r of refs) if (!itemExists(db, r.type, r.id)) throw new NotFoundError(r.type, r.id);
    if (type === 'synthesis') {
      const distinct = new Set(refs.map((r) => provenanceKey(db, r.type, r.id)));
      if (distinct.size < 2) {
        throw new ValidationError('A synthesis card must reference items from at least two different sources');
      }
    }
  }

  function insert(fields: {
    type: CardType;
    origin?: 'manual' | 'note_cloze';
    front: string;
    back?: string;
    rubric?: string | null;
    noteId?: string | null;
    clozeIndex?: number | null;
    createdBy: Actor;
    refs: ItemRefInput[];
    tags?: string[];
  }): string {
    const id = newId();
    const now = nowIso();
    db.run(
      `INSERT INTO cards (id, type, origin, front, back, rubric, note_id, cloze_index, created_by, due, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, fields.type, fields.origin ?? 'manual', fields.front, fields.back ?? '', fields.rubric ?? null, fields.noteId ?? null,
        fields.clozeIndex ?? null, fields.createdBy, now, now, now],
    );
    for (const r of fields.refs) db.run('INSERT OR IGNORE INTO card_refs (card_id, ref_type, ref_id) VALUES (?, ?, ?)', [id, r.type, r.id]);
    if (fields.tags?.length) tags.set('card', id, fields.tags);
    return id;
  }

  /** Create a card. A cloze text with several deletions (c1, c2…) creates one card per deletion. */
  function create(input: CardCreate, createdBy: Actor = 'user'): CardView[] {
    const refs = input.refs ?? [];
    validateRefs(input.type, refs);
    if ((input.type === 'basic') && !input.back?.trim()) throw new ValidationError('A basic card needs a back (answer)');
    const ids = db.tx(() => {
      if (input.type === 'cloze') {
        const idxs = clozeIndices(input.front);
        if (!idxs.length) throw new ValidationError('A cloze card needs at least one {{c1::deletion}} in the front');
        return idxs.map((n) => insert({ ...input, clozeIndex: n, createdBy, refs }));
      }
      return [insert({ ...input, createdBy, refs })];
    });
    return hydrate(db.all<CardRow>('SELECT * FROM cards WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid', [JSON.stringify(ids)]));
  }

  function update(id: string, patch: CardPatch): CardView {
    const cur = row(id);
    if (cur.origin === 'note_cloze' && patch.front !== undefined) {
      throw new ValidationError('This cloze card is generated from its note; edit the note instead');
    }
    if (patch.refs) validateRefs(cur.type, patch.refs);
    if (cur.type === 'cloze' && patch.front !== undefined && !clozeIndices(patch.front).includes(cur.cloze_index ?? 1)) {
      throw new ValidationError(`Cloze text must still contain c${cur.cloze_index}`);
    }
    db.tx(() => {
      db.run('UPDATE cards SET front = ?, back = ?, rubric = ?, suspended = ?, updated_at = ? WHERE id = ?', [
        patch.front ?? cur.front,
        patch.back ?? cur.back,
        patch.rubric !== undefined ? patch.rubric : cur.rubric,
        patch.suspended !== undefined ? patch.suspended : cur.suspended,
        nowIso(),
        id,
      ]);
      if (patch.tags) tags.set('card', id, patch.tags);
      if (patch.refs) {
        db.run('DELETE FROM card_refs WHERE card_id = ?', [id]);
        for (const r of patch.refs) db.run('INSERT OR IGNORE INTO card_refs (card_id, ref_type, ref_id) VALUES (?, ?, ?)', [id, r.type, r.id]);
      }
    });
    return get(id);
  }

  function remove(id: string): void {
    const r = db.run('DELETE FROM cards WHERE id = ?', [id]);
    if (!r.changes) throw new NotFoundError('card', id);
  }

  function list(opts: CardListOpts = {}): { items: CardView[]; total: number } {
    const where: string[] = [];
    const p: Record<string, unknown> = {};
    if (opts.ids) {
      where.push('c.id IN (SELECT value FROM json_each(:ids))');
      p.ids = JSON.stringify(opts.ids);
    }
    if (opts.noteId) {
      where.push(`c.id IN (${CARDS_FOR_ITEM_SQL.replaceAll(':type', `'note'`).replaceAll(':id', ':noteId')})`);
      p.noteId = opts.noteId;
    }
    if (opts.sourceId) {
      where.push(`c.id IN (${CARDS_FOR_ITEM_SQL.replaceAll(':type', `'source'`).replaceAll(':id', ':sourceId')})`);
      p.sourceId = opts.sourceId;
    }
    if (opts.tag) {
      where.push(`c.id IN (${CARDS_FOR_TAG_SQL})`);
      p.topic = opts.tag;
    }
    if (opts.type) {
      where.push('c.type = :type');
      p.type = opts.type;
    }
    if (opts.state) {
      where.push('c.state = :state');
      p.state = CARD_STATES.indexOf(opts.state);
    }
    if (opts.suspended !== undefined) {
      where.push('c.suspended = :susp');
      p.susp = opts.suspended ? 1 : 0;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order =
      opts.sort === 'created'
        ? 'ORDER BY c.created_at DESC, c.rowid DESC'
        : opts.sort === 'weakest'
          ? 'ORDER BY c.state = 0, c.lapses DESC, c.stability ASC'
          : 'ORDER BY c.due, c.rowid';
    const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM cards c ${w}`, p)!.n;
    const rows = db.all<CardRow>(`SELECT c.* FROM cards c ${w} ${order} LIMIT :limit OFFSET :offset`, {
      ...p,
      limit: opts.limit ?? 200,
      offset: opts.offset ?? 0,
    });
    return { items: hydrate(rows), total };
  }

  /** Keep cloze cards in sync with {{cN::…}} markup in a note body. Scheduling survives text edits. */
  function syncNoteClozes(noteId: string): void {
    const note = db.get<{ body: string }>('SELECT body FROM notes WHERE id = ?', [noteId]);
    if (!note) return;
    const idxs = clozeIndices(note.body);
    const existing = db.all<CardRow>(`SELECT * FROM cards WHERE origin = 'note_cloze' AND note_id = ?`, [noteId]);
    for (const c of existing) {
      if (!idxs.includes(c.cloze_index!)) db.run('DELETE FROM cards WHERE id = ?', [c.id]);
    }
    for (const n of idxs) {
      const front = clozeContext(note.body, n);
      const cur = existing.find((c) => c.cloze_index === n);
      if (cur) {
        if (cur.front !== front) db.run('UPDATE cards SET front = ?, updated_at = ? WHERE id = ?', [front, nowIso(), cur.id]);
      } else {
        insert({ type: 'cloze', origin: 'note_cloze', front, noteId, clozeIndex: n, createdBy: 'user', refs: [{ type: 'note', id: noteId }] });
      }
    }
  }
  ctx.onNoteSaved.push(syncNoteClozes);

  /** Backfill: sync clozes for notes containing cloze markup but no generated cards (e.g. after an import). */
  function syncMissingClozes(): number {
    const ids = db.all<{ id: string }>(
      `SELECT id FROM notes WHERE body LIKE '%{{c%::%' AND id NOT IN (SELECT note_id FROM cards WHERE origin = 'note_cloze')`,
    );
    db.tx(() => ids.forEach((r) => syncNoteClozes(r.id)));
    return ids.length;
  }

  function countForItem(type: ItemType, id: string): number {
    return db.get<{ n: number }>(`SELECT count(*) AS n FROM (${CARDS_FOR_ITEM_SQL})`, { type, id })!.n;
  }

  return { get, row, create, update, remove, list, hydrate, syncNoteClozes, syncMissingClozes, countForItem };
}
export type Cards = ReturnType<typeof createCards>;
