import type { Ctx } from './context.ts';
import type { ItemType, LinkRel } from '../types.ts';

export interface GraphNode {
  id: string;
  type: ItemType;
  kind: string;
  title: string;
  sourceId: string | null;
  degree: number;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  rel: LinkRel | 'from_source';
}
export interface GraphOpts {
  /** Center a local graph on this note/source id. */
  focus?: string;
  depth?: number;
  /** Include note→source membership edges (clusters notes around their source). */
  includeSourceEdges?: boolean;
  noteKinds?: string[];
  tag?: string;
  /** Drop notes with no links at all (global view). */
  hideIsolated?: boolean;
  limit?: number;
}

export function createGraph(ctx: Ctx) {
  const { db } = ctx;

  function build(opts: GraphOpts = {}): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
    const limit = opts.limit ?? 3000;
    const p: Record<string, unknown> = { kinds: opts.noteKinds ? JSON.stringify(opts.noteKinds) : null, tag: opts.tag ?? null };
    const tagFilter = `(:tag IS NULL OR id IN (SELECT it.item_id FROM item_tags it JOIN tags t ON t.id = it.tag_id
        WHERE t.name = :tag OR t.name LIKE :tag || '/%')
      OR source_id IN (SELECT it.item_id FROM item_tags it JOIN tags t ON t.id = it.tag_id
        WHERE it.item_type = 'source' AND (t.name = :tag OR t.name LIKE :tag || '/%')))`;
    const notes = db.all<{ id: string; kind: string; title: string; source_id: string | null }>(
      `SELECT id, kind, title, source_id FROM notes WHERE (:kinds IS NULL OR kind IN (SELECT value FROM json_each(:kinds))) AND ${tagFilter}`,
      p,
    );
    const sources = db.all<{ id: string; kind: string; title: string }>(
      `SELECT id, kind, title, NULL AS source_id FROM sources WHERE ${tagFilter.replaceAll('source_id IN', 'id IN')}`,
      p,
    );
    const nodes = new Map<string, GraphNode>();
    for (const s of sources) nodes.set(s.id, { id: s.id, type: 'source', kind: s.kind, title: s.title, sourceId: null, degree: 0 });
    for (const n of notes) nodes.set(n.id, { id: n.id, type: 'note', kind: n.kind, title: n.title, sourceId: n.source_id, degree: 0 });

    const edges: GraphEdge[] = [];
    for (const l of db.all<{ id: string; from_id: string; to_id: string; rel: LinkRel }>(
      `SELECT id, from_id, to_id, rel FROM links WHERE to_id IS NOT NULL`,
    )) {
      if (nodes.has(l.from_id) && nodes.has(l.to_id)) edges.push({ id: l.id, source: l.from_id, target: l.to_id, rel: l.rel });
    }
    if (opts.includeSourceEdges !== false) {
      for (const n of notes) {
        if (n.source_id && nodes.has(n.source_id)) edges.push({ id: `m:${n.id}`, source: n.id, target: n.source_id, rel: 'from_source' });
      }
    }
    for (const e of edges) {
      nodes.get(e.source)!.degree++;
      nodes.get(e.target)!.degree++;
    }

    let keep: Set<string>;
    if (opts.focus && nodes.has(opts.focus)) {
      // BFS over edges up to depth.
      const adj = new Map<string, string[]>();
      for (const e of edges) {
        adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
        adj.set(e.target, [...(adj.get(e.target) ?? []), e.source]);
      }
      keep = new Set([opts.focus]);
      let frontier = [opts.focus];
      for (let d = 0; d < (opts.depth ?? 2); d++) {
        const next: string[] = [];
        for (const id of frontier) {
          // Don't expand through a source's membership hub beyond the first hop (it would pull in the whole book).
          const viaHub = nodes.get(id)?.type === 'source' && id !== opts.focus;
          for (const nb of adj.get(id) ?? []) {
            if (viaHub && edges.some((e) => e.rel === 'from_source' && e.source === nb && e.target === id)) continue;
            if (!keep.has(nb)) {
              keep.add(nb);
              next.push(nb);
            }
          }
        }
        frontier = next;
      }
    } else {
      keep = new Set([...nodes.values()].filter((n) => !opts.hideIsolated || n.degree > 0).map((n) => n.id));
    }
    let list = [...nodes.values()].filter((n) => keep.has(n.id));
    const truncated = list.length > limit;
    if (truncated) {
      list = list.sort((a, b) => b.degree - a.degree).slice(0, limit);
      keep = new Set(list.map((n) => n.id));
    }
    return { nodes: list, edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)), truncated };
  }

  return { build };
}
export type Graph = ReturnType<typeof createGraph>;
