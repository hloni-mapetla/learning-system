import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { SOURCE_KINDS, SOURCE_STATUSES, type Note, type SourceDetail } from '@loom/core/types';
import { api, useAction, useApi } from '../lib/api';
import { shortDate } from '../lib/format';
import { useHotkeys } from '../lib/hotkeys';
import { Badge, Button, Empty, Input, Section, Select, TagInput, Textarea } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { LinkList } from './NoteDetail';
import { TaskForm } from '../components/TaskForm';
import { TaskRow } from '../components/TaskRow';
import { SimilarPanel } from '../components/SimilarPanel';

export function SourceDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const { data: s } = useApi<SourceDetail>(`/sources/${id}`);
  const patch = useAction((body: Record<string, unknown>) => api.patch(`/sources/${id}`, body));
  const remove = useAction(() => api.del(`/sources/${id}`));
  const [capturing, setCapturing] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const complete = useAction((tid: string) => api.post(`/tasks/${tid}/complete`));
  useHotkeys({ a: () => setCapturing(true) }, []);

  if (!s) return null;
  const highlights = s.notes.filter((n) => n.kind === 'highlight');
  const others = s.notes.filter((n) => n.kind !== 'highlight');

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_280px]">
      <div className="min-w-0">
        <div className="mb-1 text-xs font-semibold tracking-wide text-faint uppercase">{s.kind}</div>
        <input
          key={s.title}
          defaultValue={s.title}
          onBlur={(e) => e.target.value.trim() && e.target.value !== s.title && patch.mutate({ title: e.target.value })}
          className="w-full bg-transparent text-2xl font-semibold tracking-tight outline-none"
        />
        <input
          key={s.authors}
          defaultValue={s.authors}
          placeholder="Author(s)"
          onBlur={(e) => e.target.value !== s.authors && patch.mutate({ authors: e.target.value })}
          className="mt-1 w-full bg-transparent text-muted outline-none placeholder:text-faint"
        />
        {s.url && (
          <a href={s.url} target="_blank" rel="noreferrer" className="mt-1 block truncate text-sm text-accent underline">
            {s.url}
          </a>
        )}
        <Textarea
          key={s.description}
          defaultValue={s.description}
          placeholder="Description / why you're reading this"
          rows={2}
          className="mt-4"
          onBlur={(e) => e.target.value !== s.description && patch.mutate({ description: e.target.value })}
        />

        <div className="mt-8 mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Highlights & notes</h2>
          <div className="flex gap-2">
            <Button onClick={() => setCapturing(true)}>Capture <span className="font-mono text-xs text-faint">a</span></Button>
            <Button
              onClick={async () => {
                const n = await api.post<Note>('/notes', { title: `Notes on ${s.title}`, sourceId: s.id, kind: 'summary' });
                navigate({ to: '/notes/$id', params: { id: n.id }, search: { edit: true } as any });
              }}
            >
              New note
            </Button>
          </div>
        </div>
        {capturing && <CaptureHighlight sourceId={s.id} onDone={() => setCapturing(false)} />}
        {s.notes.length === 0 && !capturing && <Empty>Nothing captured yet. Press <b>a</b> to add a highlight.</Empty>}
        {others.length > 0 && (
          <ul className="mb-6 space-y-2">
            {others.map((n) => (
              <li key={n.id}>
                <Link to="/notes/$id" params={{ id: n.id }} className="block rounded-lg border border-line bg-panel px-4 py-3 hover:border-accent">
                  <div className="flex items-center gap-2">
                    <Badge>{n.kind}</Badge>
                    <span className="font-medium">{n.title}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <ul className="space-y-3">
          {highlights.map((n) => (
            <li key={n.id}>
              <Link to="/notes/$id" params={{ id: n.id }} className="block rounded-lg border border-line bg-panel px-4 py-3 hover:border-accent">
                <blockquote className="font-serif text-[1.02rem] leading-relaxed">{n.quote}</blockquote>
                {n.body && <Markdown text={n.body} className="mt-2 text-sm text-muted" />}
                <div className="mt-2 flex gap-2 text-xs text-faint">
                  {n.location && <span>{n.location}</span>}
                  {n.tags.map((t) => <span key={t}>#{t}</span>)}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <aside className="space-y-1 text-sm">
        <Section title="Status">
          <div className="grid grid-cols-2 gap-2">
            <Select value={s.status} onChange={(e) => patch.mutate({ status: e.target.value })}>
              {SOURCE_STATUSES.map((k) => <option key={k}>{k}</option>)}
            </Select>
            <Select value={s.priority} onChange={(e) => patch.mutate({ priority: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>Priority {p}</option>)}
            </Select>
            <Select value={s.kind} onChange={(e) => patch.mutate({ kind: e.target.value })} className="col-span-2">
              {SOURCE_KINDS.map((k) => <option key={k}>{k}</option>)}
            </Select>
          </div>
          <div className="mt-2 text-xs text-faint">
            {s.startedAt && <>Started {shortDate(s.startedAt)}. </>}
            {s.finishedAt && <>Finished {shortDate(s.finishedAt)}.</>}
          </div>
        </Section>
        <Section title="Tags">
          <TagInput value={s.tags} onChange={(tags) => patch.mutate({ tags })} />
        </Section>
        <Section title="URL">
          <Input key={s.url ?? ''} defaultValue={s.url ?? ''} placeholder="https://…" onBlur={(e) => e.target.value !== (s.url ?? '') && patch.mutate({ url: e.target.value || null })} />
        </Section>
        <Section title="Stats">
          <div className="text-muted">
            {highlights.length} highlights · {others.length} notes · {s.cardCount} cards
          </div>
        </Section>
        <Section title="Tasks" actions={<button className="text-xs text-accent hover:underline" onClick={() => setAddingTask(true)}>+ task</button>}>
          {addingTask && <TaskForm sourceId={s.id} onDone={() => setAddingTask(false)} />}
          <ul className="space-y-1.5">
            {s.tasks.map((t) => (
              <li key={t.id}><TaskRow task={t} onToggle={(x) => { complete.mutate(x.id); if (x.kind === 'read') setCapturing(true); }} /></li>
            ))}
          </ul>
          {!s.tasks.length && !addingTask && <p className="text-xs text-faint">e.g. “Read chapter 4”</p>}
        </Section>
        <LinkList title="Links" links={s.outgoing} dir="out" />
        <LinkList title="Backlinks" links={s.backlinks} dir="in" />
        <SimilarPanel key={s.id} self={{ type: 'source', id: s.id, title: s.title, kind: s.kind }} />
        <div className="pt-4">
          <Button
            variant="danger"
            size="sm"
            onClick={async () => {
              if (!confirm(`Delete "${s.title}"? Its notes are kept (unlinked from the source).`)) return;
              await remove.mutateAsync(undefined);
              navigate({ to: '/sources' });
            }}
          >
            Delete source
          </Button>
        </div>
      </aside>
    </div>
  );
}

export function CaptureHighlight({ sourceId, onDone }: { sourceId: string; onDone: () => void }) {
  const [quote, setQuote] = useState('');
  const [location, setLocation] = useState('');
  const [body, setBody] = useState('');
  const quoteRef = useRef<HTMLTextAreaElement>(null);
  const create = useAction((b: unknown) => api.post('/notes', b));
  const save = async (keepOpen: boolean) => {
    if (!quote.trim() && !body.trim()) return;
    await create.mutateAsync({ sourceId, quote: quote || null, body, location: location || null, kind: quote ? 'highlight' : 'note' });
    setQuote('');
    setBody('');
    if (keepOpen) quoteRef.current?.focus();
    else onDone();
  };
  return (
    <form
      className="mb-4 space-y-2 rounded-lg border border-accent bg-panel p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save(true);
        }
      }}
    >
      <Textarea ref={quoteRef} autoFocus rows={3} placeholder="Quote / highlight" value={quote} onChange={(e) => setQuote(e.target.value)} className="font-serif" />
      <Textarea rows={2} placeholder="Your thoughts (Markdown, [[links]] ok)" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="flex items-center gap-2">
        <Input placeholder="Location (p. 42, ch. 3, loc 1234)" value={location} onChange={(e) => setLocation(e.target.value)} className="max-w-60" />
        <span className="ml-auto text-xs text-faint">⌘↵ save & next · esc close</span>
        <Button type="submit" variant="primary">Save</Button>
      </div>
    </form>
  );
}
