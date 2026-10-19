import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ImportReport, Source } from '@loom/core';
import { api, useAction, useApi } from '../lib/api';
import { Button, Input, PageHeader, Section, Select, Textarea } from '../components/ui';

type Result = (ImportReport & { dir?: string }) | null;

function Report({ r }: { r: Result }) {
  if (!r) return null;
  return (
    <div className="mt-3 rounded-md bg-accent-soft px-4 py-3 text-sm">
      Imported <b>{r.created}</b> {r.created === 1 ? 'note' : 'notes'}
      {r.skipped ? `, skipped ${r.skipped} already present` : ''}.
      {r.sources?.length > 0 && (
        <ul className="mt-1">
          {r.sources.map((s) => (
            <li key={s.id}>
              <Link to="/sources/$id" params={{ id: s.id }} className="text-accent underline">{s.title}</Link>
              {s.created ? ' (new source)' : ''} · {s.highlights} highlights
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 text-xs text-muted">
        Next: <b>recall first</b>. Open each source and write what you remember before reading the highlights (they stay hidden until
        you do). Then draft your own notes, or ask Claude to “process reading” to compare your recall with the highlights and critique your drafts.
      </div>
    </div>
  );
}

export function ImportPage() {
  const [kindleText, setKindleText] = useState<string | null>(null);
  const [books, setBooks] = useState<{ title: string; author: string; highlights: number; notes: number }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [kr, setKr] = useState<Result>(null);
  const [mr, setMr] = useState<Result>(null);
  const [pr, setPr] = useState<Result>(null);
  const [paste, setPaste] = useState('');
  const [srcId, setSrcId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const sources = useApi<{ items: Source[] }>('/sources?sort=title&limit=1000');
  const importKindle = useAction((b: unknown) => api.post<ImportReport>('/import/kindle', b));
  const importMd = useAction((b: unknown) => api.post<ImportReport>('/import/markdown', b));
  const importPaste = useAction((b: unknown) => api.post<ImportReport>('/import/paste', b));

  const onKindle = async (f: File) => {
    const text = await f.text();
    setKindleText(text);
    const prev = await api.post<typeof books>('/import/kindle/preview', { text });
    setBooks(prev);
    setPicked(new Set(prev.map((b) => b.title)));
    setKr(null);
  };
  const onMarkdown = async (files: FileList) => {
    const list = await Promise.all([...files].filter((f) => f.name.endsWith('.md')).map(async (f) => ({ name: f.name, content: await f.text() })));
    setMr(await importMd.mutateAsync({ files: list }));
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title="Import & export" subtitle="Bring highlights in; take everything out as Markdown + JSON." />

      <Section title="Kindle · My Clippings.txt">
        <p className="mb-2 text-sm text-muted">Connect your Kindle by USB and pick <code>documents/My Clippings.txt</code>. Re-importing the same file only adds what's new.</p>
        <input type="file" accept=".txt" onChange={(e) => e.target.files?.[0] && onKindle(e.target.files[0])} className="text-sm" />
        {books.length > 0 && kindleText && (
          <div className="mt-3 rounded-lg border border-line bg-panel p-3">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span>{books.length} books found</span>
              <button className="text-xs text-accent" onClick={() => setPicked(picked.size === books.length ? new Set() : new Set(books.map((b) => b.title)))}>
                {picked.size === books.length ? 'select none' : 'select all'}
              </button>
            </div>
            <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
              {books.map((b) => (
                <li key={b.title}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={picked.has(b.title)} onChange={() => { const n = new Set(picked); n.has(b.title) ? n.delete(b.title) : n.add(b.title); setPicked(n); }} />
                    <span className="truncate">{b.title}</span>
                    <span className="ml-auto shrink-0 text-xs text-faint">{b.highlights} hl · {b.notes} notes</span>
                  </label>
                </li>
              ))}
            </ul>
            <Button className="mt-3" variant="primary" disabled={!picked.size || importKindle.isPending} onClick={async () => setKr(await importKindle.mutateAsync({ text: kindleText, books: [...picked] }))}>
              Import {picked.size} {picked.size === 1 ? 'book' : 'books'}
            </Button>
          </div>
        )}
        <Report r={kr} />
      </Section>

      <Section title="Markdown files">
        <p className="mb-2 text-sm text-muted">One note per file. Frontmatter is used if present: <code>title, kind, source, author, tags, aliases, location</code>. [[Wikilinks]] are kept.</p>
        <input type="file" accept=".md" multiple onChange={(e) => e.target.files && onMarkdown(e.target.files)} className="text-sm" />
        <Report r={mr} />
      </Section>

      <Section title="Paste highlights">
        <div className="mb-2 flex gap-2">
          <Select value={srcId} onChange={(e) => setSrcId(e.target.value)} className="max-w-xs">
            <option value="">New source…</option>
            {sources.data?.items.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </Select>
          {!srcId && <Input placeholder="Title of the book/article" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />}
        </div>
        <Textarea rows={8} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'One highlight per paragraph. End with (p. 12) or loc 340 to record a location.\n\nNote: lines starting with "Note:" attach to the highlight above.'} className="font-serif" />
        <Button
          className="mt-2"
          variant="primary"
          disabled={!paste.trim() || (!srcId && !newTitle.trim())}
          onClick={async () => {
            setPr(await importPaste.mutateAsync({ text: paste, sourceId: srcId || null, sourceTitle: srcId ? null : newTitle }));
            setPaste('');
          }}
        >
          Import highlights
        </Button>
        <Report r={pr} />
      </Section>

      <Section title="Export & backup">
        <div className="flex flex-wrap gap-2">
          <a href="/api/export/json" className="inline-flex h-9 items-center rounded-md border border-line bg-panel px-3 text-sm hover:bg-sunken">Download JSON (everything)</a>
          <Button onClick={async () => { const r = await api.post<{ dir: string; files: number }>('/export/markdown'); setExportMsg(`Wrote ${r.files} Markdown files to ${r.dir}`); }}>Export Markdown vault</Button>
          <Button onClick={async () => { const r = await api.post<{ path: string }>('/backup'); setExportMsg(`Database snapshot saved to ${r.path}`); }}>Back up database now</Button>
        </div>
        {exportMsg && <p className="mt-2 text-sm text-muted">{exportMsg}</p>}
        <p className="mt-2 text-xs text-faint">The Markdown vault opens in Obsidian. For nightly backups see the README.</p>
      </Section>
    </div>
  );
}
