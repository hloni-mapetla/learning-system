import { useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { SOURCE_KINDS, SOURCE_STATUSES, type Source, type SourceStatus } from '@loom/core/types';
import { api, qs, useAction, useApi } from '../lib/api';
import { useListNav } from '../lib/useListNav';
import { Badge, Button, Empty, Input, PageHeader, Select } from '../components/ui';

const TABS: { label: string; status?: SourceStatus[] }[] = [
  { label: 'Reading', status: ['reading'] },
  { label: 'Queue', status: ['queued'] },
  { label: 'Done', status: ['done'] },
  { label: 'All' },
];

export const STATUS_TONE: Record<SourceStatus, 'accent' | 'default' | 'warn'> = {
  reading: 'accent',
  queued: 'default',
  done: 'default',
  abandoned: 'warn',
};

export function Priority({ p }: { p: number }) {
  return (
    <span className="font-mono text-xs text-faint" title={`Priority ${p} (1 = highest)`}>
      P{p}
    </span>
  );
}

export function SourcesPage() {
  const search = useSearch({ strict: false }) as { add?: boolean; tab?: string };
  const navigate = useNavigate();
  const [tab, setTab] = useState(search.tab ?? 'All');
  const [adding, setAdding] = useState(!!search.add);
  const current = TABS.find((t) => t.label === tab) ?? TABS[3];
  const { data } = useApi<{ items: Source[]; total: number }>(
    `/sources${qs({ status: current.status?.join(','), sort: current.label === 'All' ? 'recent' : 'priority' })}`,
  );
  const items = data?.items ?? [];
  const [sel] = useListNav(items.length, (i) => navigate({ to: '/sources/$id', params: { id: items[i].id } }), {
    a: () => setAdding(true),
  });

  return (
    <div>
      <PageHeader
        title="Sources"
        subtitle="Books, articles, papers, videos and lectures — and your reading queue."
        actions={<Button variant="primary" onClick={() => setAdding(true)}>Add source</Button>}
      />
      {adding && <AddSource onDone={() => setAdding(false)} />}
      <div className="mb-4 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.label}
            onClick={() => setTab(t.label)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.label ? 'border-accent font-medium text-ink' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <Empty>No sources here yet. Press <b>a</b> to add one.</Empty>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          {items.map((s, i) => (
            <li key={s.id} data-row={i} className={i === sel ? 'bg-accent-soft' : ''}>
              <Link to="/sources/$id" params={{ id: s.id }} className="flex items-center gap-3 px-4 py-3 hover:bg-sunken">
                <Priority p={s.priority} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.title}</div>
                  <div className="truncate text-xs text-muted">
                    {[s.kind, s.authors, s.tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddSource({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const [f, setF] = useState({ title: '', authors: '', kind: 'book', url: '', status: 'queued', priority: 3, tags: '' });
  const create = useAction((body: unknown) => api.post<Source>('/sources', body));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.title.trim()) return;
    const s = await create.mutateAsync({
      ...f,
      url: f.url || null,
      tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
    });
    onDone();
    navigate({ to: '/sources/$id', params: { id: s.id } });
  };
  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
      className="mb-6 grid gap-3 rounded-lg border border-line bg-panel p-4 sm:grid-cols-6"
    >
      <Input autoFocus placeholder="Title" className="sm:col-span-4" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      <Select className="sm:col-span-2" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
        {SOURCE_KINDS.map((k) => <option key={k}>{k}</option>)}
      </Select>
      <Input placeholder="Author(s)" className="sm:col-span-3" value={f.authors} onChange={(e) => setF({ ...f, authors: e.target.value })} />
      <Input placeholder="URL" className="sm:col-span-3" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
      <Select className="sm:col-span-2" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
        {SOURCE_STATUSES.map((k) => <option key={k}>{k}</option>)}
      </Select>
      <Select className="sm:col-span-1" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })}>
        {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}
      </Select>
      <Input placeholder="tags, comma separated" className="sm:col-span-3" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />
      <div className="flex justify-end gap-2 sm:col-span-6">
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={create.isPending}>Add source</Button>
      </div>
    </form>
  );
}
