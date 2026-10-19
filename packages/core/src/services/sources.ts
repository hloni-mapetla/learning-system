import type { Ctx } from './context.ts';
import type { Actor, Source, SourceStatus } from '../types.ts';
import type { SourceCreate, SourcePatch } from '../schemas.ts';
import type { Tags } from './tags.ts';
import type { Links } from './links.ts';
import { localDate, newId, nowIso, NotFoundError } from '../util.ts';
import { enqueueEmbedding } from './embeddings.ts';

function toSource(r: any, tags: string[]): Source {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    authors: r.authors,
    url: r.url,
    published: r.published,
    status: r.status,
    priority: r.priority,
    description: r.description,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    method: r.method ?? null,
    createdBy: r.created_by ?? 'user',
    tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface SourceListOpts {
  status?: SourceStatus | SourceStatus[];
  tag?: string;
  q?: string;
  limit?: number;
  offset?: number;
  sort?: 'recent' | 'priority' | 'title';
}

export function createSources(ctx: Ctx, tags: Tags, links: Links) {
  const { db } = ctx;

  function get(id: string): Source {
    const r = db.get('SELECT * FROM sources WHERE id = ?', [id]);
    if (!r) throw new NotFoundError('source', id);
    return toSource(r, tags.get('source', id));
  }

  function create(input: SourceCreate, createdBy: Actor = 'user'): Source {
    const id = newId();
    const now = nowIso();
    const status = input.status ?? 'queued';
    db.tx(() => {
      db.run(
        `INSERT INTO sources (id, kind, title, authors, url, published, status, priority, description,
           started_at, finished_at, method, created_by, created_at, updated_at)
         VALUES (:id, :kind, :title, :authors, :url, :published, :status, :priority, :description,
           :started_at, :finished_at, :method, :created_by, :now, :now)`,
        {
          id,
          kind: input.kind ?? 'book',
          title: input.title.trim(),
          authors: input.authors ?? '',
          url: input.url ?? null,
          published: input.published ?? null,
          status,
          priority: input.priority ?? 3,
          description: input.description ?? '',
          started_at: input.startedAt ?? (status === 'reading' || status === 'done' ? localDate() : null),
          finished_at: input.finishedAt ?? (status === 'done' ? localDate() : null),
          method: input.method ?? null,
          created_by: createdBy,
          now,
        },
      );
      if (input.tags) tags.set('source', id, input.tags);
      links.resolveDangling('source', id, [input.title]);
      enqueueEmbedding(db, 'source', id);
    });
    ctx.onIndexNeeded.forEach((f) => f());
    return get(id);
  }

  function update(id: string, patch: SourcePatch): Source {
    const cur = get(id);
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Source;
    // Status transitions stamp reading dates unless given explicitly.
    if (patch.status && patch.status !== cur.status) {
      if (patch.status === 'reading' && !next.startedAt) next.startedAt = localDate();
      if (patch.status === 'done' && !next.finishedAt) next.finishedAt = localDate();
    }
    db.tx(() => {
      db.run(
        `UPDATE sources SET kind = :kind, title = :title, authors = :authors, url = :url, published = :published,
           status = :status, priority = :priority, description = :description, started_at = :started_at,
           finished_at = :finished_at, method = :method, updated_at = :now WHERE id = :id`,
        {
          id,
          kind: next.kind,
          title: next.title.trim(),
          authors: next.authors,
          url: next.url,
          published: next.published,
          status: next.status,
          priority: next.priority,
          description: next.description,
          started_at: next.startedAt,
          finished_at: next.finishedAt,
          method: patch.method !== undefined ? patch.method : cur.method,
          now: nowIso(),
        },
      );
      if (patch.tags) tags.set('source', id, patch.tags);
      if (patch.title && patch.title !== cur.title) links.resolveDangling('source', id, [patch.title]);
      if (patch.title !== undefined || patch.authors !== undefined || patch.description !== undefined) {
        enqueueEmbedding(db, 'source', id);
      }
    });
    ctx.onIndexNeeded.forEach((f) => f());
    return get(id);
  }

  function remove(id: string): void {
    const r = db.run('DELETE FROM sources WHERE id = ?', [id]);
    if (!r.changes) throw new NotFoundError('source', id);
  }

  function list(opts: SourceListOpts = {}): { items: Source[]; total: number } {
    const where: string[] = [];
    const p: Record<string, unknown> = {};
    if (opts.status) {
      where.push(`s.status IN (SELECT value FROM json_each(:statuses))`);
      p.statuses = JSON.stringify(Array.isArray(opts.status) ? opts.status : [opts.status]);
    }
    if (opts.tag) {
      where.push(`s.id IN (SELECT it.item_id FROM item_tags it JOIN tags t ON t.id = it.tag_id
        WHERE it.item_type = 'source' AND (t.name = :tag OR t.name LIKE :tag || '/%'))`);
      p.tag = opts.tag;
    }
    if (opts.q) {
      where.push(`(s.title LIKE '%' || :q || '%' OR s.authors LIKE '%' || :q || '%')`);
      p.q = opts.q;
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order =
      opts.sort === 'priority'
        ? `ORDER BY CASE s.status WHEN 'reading' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, s.priority, s.created_at`
        : opts.sort === 'title'
          ? 'ORDER BY s.title COLLATE NOCASE'
          : 'ORDER BY s.updated_at DESC';
    const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM sources s ${w}`, p)!.n;
    const rows = db.all(`SELECT s.* FROM sources s ${w} ${order} LIMIT :limit OFFSET :offset`, {
      ...p,
      limit: opts.limit ?? 100,
      offset: opts.offset ?? 0,
    });
    const tagMap = tags.getMany('source', rows.map((r) => r.id));
    return { items: rows.map((r) => toSource(r, tagMap.get(r.id) ?? [])), total };
  }

  function findByTitle(title: string): Source | null {
    const r = db.get('SELECT * FROM sources WHERE title = ? COLLATE NOCASE LIMIT 1', [title.trim()]);
    return r ? toSource(r, tags.get('source', r.id)) : null;
  }

  return { get, create, update, remove, list, findByTitle };
}
export type Sources = ReturnType<typeof createSources>;
