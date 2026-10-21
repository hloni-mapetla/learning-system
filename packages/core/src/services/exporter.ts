import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './context.ts';

const safe = (s: string) =>
  s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'untitled';

function yaml(meta: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (Array.isArray(v)) lines.push(`${k}:`, ...v.map((x) => `  - ${JSON.stringify(String(x))}`));
    else lines.push(`${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/** Full-fidelity JSON dump plus an Obsidian-compatible Markdown vault; and SQLite snapshots. */
export function createExporter(ctx: Ctx) {
  const { db } = ctx;

  function json(): Record<string, unknown> {
    const tables = ['sources', 'notes', 'links', 'tags', 'item_tags', 'cards', 'card_refs', 'review_logs', 'tasks', 'subtasks', 'task_events', 'exams', 'settings'];
    const out: Record<string, unknown> = { format: 'loom-export', version: 3, schema: db.schemaVersion(), exportedAt: new Date().toISOString() };
    for (const t of tables) out[t] = db.all(`SELECT * FROM ${t}${t === 'settings' ? ` WHERE key NOT IN ('owner_password', 'api_tokens')` : ''}`);
    return out;
  }

  /** Write a Markdown vault: one folder per source (plus _notes for standalone), cards as cards.md per folder. */
  function markdownVault(dir: string): { files: number } {
    mkdirSync(dir, { recursive: true });
    let files = 0;
    const tagsOf = (type: string, id: string) =>
      db.all<{ name: string }>(`SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_type = ? AND it.item_id = ?`, [type, id]).map((r) => r.name);
    const linksOf = (id: string) =>
      db.all<{ rel: string; title: string | null; target_title: string | null; rationale: string | null }>(
        `SELECT l.rel, coalesce(n.title, s.title) AS title, l.target_title, l.rationale FROM links l
         LEFT JOIN notes n ON l.to_type = 'note' AND n.id = l.to_id LEFT JOIN sources s ON l.to_type = 'source' AND s.id = l.to_id
         WHERE l.from_id = ? AND l.rel <> 'wikilink'`,
        [id],
      );
    const used = new Set<string>();
    const fileName = (folder: string, title: string) => {
      let name = safe(title);
      let i = 2;
      while (used.has(`${folder}/${name}`.toLowerCase())) name = `${safe(title)} ${i++}`;
      used.add(`${folder}/${name}`.toLowerCase());
      return `${name}.md`;
    };

    const sources = db.all('SELECT * FROM sources');
    const folderOf = new Map<string | null, string>([[null, '_notes']]);
    for (const s of sources) {
      const folder = safe(s.title);
      folderOf.set(s.id, folder);
      mkdirSync(join(dir, folder), { recursive: true });
      writeFileSync(
        join(dir, folder, fileName(folder, s.title)),
        yaml({ type: 'source', id: s.id, kind: s.kind, authors: s.authors, url: s.url, status: s.status, priority: s.priority,
          started: s.started_at, finished: s.finished_at, tags: tagsOf('source', s.id) }) + `# ${s.title}\n\n${s.description}\n`,
      );
      files++;
    }
    mkdirSync(join(dir, '_notes'), { recursive: true });
    for (const n of db.all('SELECT * FROM notes ORDER BY created_at')) {
      const folder = folderOf.get(n.source_id) ?? '_notes';
      const links = linksOf(n.id);
      const src = n.source_id ? sources.find((s) => s.id === n.source_id) : null;
      const body = [
        n.quote ? n.quote.split('\n').map((l: string) => `> ${l}`).join('\n') : '',
        n.body,
        links.length ? '## Links\n\n' + links.map((l) => `- ${l.rel.replace('_', ' ')} [[${l.title ?? l.target_title}]]${l.rationale ? ` — ${l.rationale}` : ''}`).join('\n') : '',
      ].filter(Boolean).join('\n\n');
      writeFileSync(
        join(dir, folder, fileName(folder, n.title)),
        yaml({ type: n.kind, id: n.id, source: src ? `[[${src.title}]]` : null, location: n.location, aliases: JSON.parse(n.aliases),
          tags: tagsOf('note', n.id), author: n.created_by === 'user' ? null : n.created_by, created: n.created_at, updated: n.updated_at }) + `# ${n.title}\n\n${body}\n`,
      );
      files++;
    }
    // Cards, grouped by folder of their first ref.
    const byFolder = new Map<string, string[]>();
    for (const c of db.all('SELECT * FROM cards ORDER BY created_at')) {
      const ref = db.get<{ ref_type: string; ref_id: string }>('SELECT * FROM card_refs WHERE card_id = ? LIMIT 1', [c.id]);
      const srcId = ref?.ref_type === 'source' ? ref.ref_id : ref ? db.get<{ source_id: string | null }>('SELECT source_id FROM notes WHERE id = ?', [ref.ref_id])?.source_id ?? null : null;
      const folder = folderOf.get(srcId) ?? '_notes';
      const entry = [`### ${c.type}${c.suspended ? ' (suspended)' : ''} · ${c.id}`, `**Q:** ${c.front}`, c.back ? `**A:** ${c.back}` : '', c.rubric ? `**Rubric:** ${c.rubric}` : '',
        `_reps ${c.reps}, lapses ${c.lapses}, due ${c.due.slice(0, 10)}_`].filter(Boolean).join('\n\n');
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), entry]);
    }
    for (const [folder, entries] of byFolder) {
      writeFileSync(join(dir, folder, '_cards.md'), `# Cards\n\n${entries.join('\n\n---\n\n')}\n`);
      files++;
    }
    // Tasks as a checklist, with their steps nested under them.
    const tasks = db.all(`SELECT t.*, s.title AS source_title FROM tasks t LEFT JOIN sources s ON s.id = t.source_id
      WHERE t.status <> 'cancelled' ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.priority, t.sort_order`);
    if (tasks.length) {
      const lines = ['# Tasks', ''];
      for (const t of tasks) {
        const meta = [t.kind !== 'todo' && t.kind, t.due_date && `due ${t.due_date}`, `P${t.priority}`, t.source_title && `[[${t.source_title}]]`,
          t.single_step && 'single step', t.created_by !== 'user' && `by ${t.created_by}`].filter(Boolean).join(' · ');
        lines.push(`- [${t.status === 'done' ? 'x' : ' '}] ${t.title} _(${meta})_`);
        for (const st of db.all('SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, created_at', [t.id])) {
          lines.push(`    - [${st.completed_at ? 'x' : ' '}] ${st.title}${st.created_by !== 'user' ? ` _(by ${st.created_by})_` : ''}`);
        }
      }
      writeFileSync(join(dir, '_tasks.md'), lines.join('\n') + '\n');
      files++;
    }
    return { files };
  }

  /** Consistent point-in-time copy of the database (safe while the server is running). */
  function snapshot(path: string): void {
    db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  /** Timestamped snapshot into dir, keeping the newest `keep`. */
  function backup(dir: string, keep = 30): string {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const path = join(dir, `loom-${stamp}.db`);
    snapshot(path);
    const old = readdirSync(dir)
      .filter((f) => /^loom-.*\.db$/.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(keep);
    for (const o of old) rmSync(join(dir, o.f));
    return path;
  }

  return { json, markdownVault, snapshot, backup };
}
export type Exporter = ReturnType<typeof createExporter>;
