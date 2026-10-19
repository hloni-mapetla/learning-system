import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { SOURCE_KINDS, SOURCE_STATUSES, type Note, type SourceDetail } from '@loom/core/types';
import { AuthorBadge, RecallBox } from '../components/RecallBox';
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
  const [recalling, setRecalling] = useState(false);
  const [openRecall, setOpenRecall] = useState<string | null>(null);
  const complete = useAction((tid: string) => api.post(`/tasks/${tid}/complete`));
  const skip = useAction(() => api.post(`/sources/${id}/recall/skip`));
  const draft = async (kind: 'concept' | 'claim') => {
    const n = await api.post<Note>('/notes', { title: kind === 'concept' ? 'New concept' : 'New claim', kind, sourceId: id });
    navigate({ to: '/notes/$id', params: { id: n.id }, search: { edit: true, focusTitle: true } as any });
  };

  const highlights = s?.notes.filter((n) => n.kind === 'highlight') ?? [];
  const recalls = s?.notes.filter((n) => n.kind === 'recall') ?? [];
  const others = s?.notes.filter((n) => n.kind !== 'highlight' && n.kind !== 'recall') ?? [];
  // Highlights stay hidden until a blank-page recall is written (or explicitly skipped).
  const gated = s?.recallState === 'none' && highlights.length > 0;
  const recallDue = s?.recallState === 'none' && (highlights.length > 0 || s.status === 'done');
  const skipRecall = () => {
    if (confirm('Show highlights without recalling first? This source will count as "highlights first" in your recall experiment.')) skip.mutate(undefined);
  };

  useHotkeys(
    {
      a: () => setCapturing(true),
      r: () => (recallDue ? document.querySelector<HTMLTextAreaElement>('#recall-box textarea')?.focus() : setRecalling(true)),
      s: () => gated && skipRecall(),
      n: () => draft('concept'),
      N: () => draft('claim'),
    },
    [recallDue, gated],
  );

  if (!s) return null;

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

        <div className="mt-8">
          {(recallDue || recalling) && (
            <RecallBox
              sourceId={s.id}
              autoFocus={recalling}
              onSaved={() => setRecalling(false)}
              onCancel={recallDue ? undefined : () => setRecalling(false)}
            />
          )}
          {recalls.length > 0 && (
            <Section
              title={`Your recalls (${recalls.length})`}
              actions={!recalling && <button className="text-xs text-accent hover:underline" onClick={() => setRecalling(true)}>+ recall <span className="font-mono text-faint">r</span></button>}
            >
              <ul className="space-y-2">
                {recalls.map((n) => (
                  <li key={n.id} className="rounded-lg border border-line bg-panel px-4 py-2">
                    <button className="flex w-full items-center gap-2 text-left text-sm" onClick={() => setOpenRecall(openRecall === n.id ? null : n.id)}>
                      <Badge tone="accent">recall</Badge>
                      <span className="text-muted">{shortDate(n.createdAt)} · {n.body.length} chars</span>
                      <Link to="/notes/$id" params={{ id: n.id }} className="ml-auto text-xs text-accent" onClick={(e) => e.stopPropagation()}>open</Link>
                    </button>
                    {openRecall === n.id && <div className="mt-2 text-sm whitespace-pre-wrap">{n.body}</div>}
                  </li>
                ))}
              </ul>
              <div className="mt-3 rounded-lg bg-accent-soft px-4 py-3 text-sm">
                <div className="font-medium">Next: draft your own notes</div>
                <div className="mt-1 text-muted">
                  Compare your recall with the highlights below, then write the key ideas in your own words, one per note:{' '}
                  <button className="text-accent hover:underline" onClick={() => draft('concept')}>concept <span className="font-mono text-faint">n</span></button>{' · '}
                  <button className="text-accent hover:underline" onClick={() => draft('claim')}>claim <span className="font-mono text-faint">N</span></button>.
                  {' '}For a critique of what you missed and of your drafts, ask Claude to <b>process reading</b>.
                </div>
              </div>
            </Section>
          )}
        </div>

        <div className="mt-8 mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Highlights & notes</h2>
          <div className="flex gap-2">
            {!recallDue && !recalling && recalls.length === 0 && <Button onClick={() => setRecalling(true)}>Recall <span className="font-mono text-xs text-faint">r</span></Button>}
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
        {highlights.length + others.length === 0 && !capturing && <Empty>Nothing captured yet. Press <b>a</b> to add a highlight.</Empty>}
        {others.length > 0 && (
          <ul className="mb-6 space-y-2">
            {others.map((n) => (
              <li key={n.id}>
                <Link to="/notes/$id" params={{ id: n.id }} className="block rounded-lg border border-line bg-panel px-4 py-3 hover:border-accent">
                  <div className="flex items-center gap-2">
                    <Badge tone={n.kind === 'concept' || n.kind === 'claim' ? 'accent' : 'default'}>{n.kind}</Badge>
                    <span className="font-medium">{n.title}</span>
                    <span className="ml-auto"><AuthorBadge by={n.createdBy} /></span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {gated ? (
          <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
            {highlights.length} highlight{highlights.length === 1 ? '' : 's'} hidden until you've written your recall.
            <div className="mt-2">
              <button className="text-xs text-faint hover:text-muted hover:underline" onClick={skipRecall}>
                Skip recall and show them <span className="font-mono">s</span>
              </button>
            </div>
          </div>
        ) : (
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
        )}
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
            <Select
              value={s.method ?? ''}
              title="How this source was processed, for the recall-first experiment on Stats"
              onChange={(e) => patch.mutate({ method: e.target.value || null })}
              className="col-span-2"
            >
              <option value="">Method: not processed yet</option>
              <option value="recall_first">Method: recall first</option>
              <option value="highlights_first">Method: highlights first</option>
            </Select>
          </div>
          {s.createdBy !== 'user' && <div className="mt-2"><AuthorBadge by={s.createdBy} /></div>}
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
            {[[recalls.length, 'recall'], [highlights.length, 'highlight'], [others.length, 'note'], [s.cardCount, 'card']].map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(' · ')}
          </div>
        </Section>
        <Section title="Tasks" actions={<button className="text-xs text-accent hover:underline" onClick={() => setAddingTask(true)}>+ task</button>}>
          {addingTask && <TaskForm sourceId={s.id} onDone={() => setAddingTask(false)} />}
          <ul className="space-y-1.5">
            {s.tasks.map((t) => (
              <li key={t.id}><TaskRow task={t} onToggle={(x) => { complete.mutate(x.id); if (x.kind === 'read') setRecalling(true); }} /></li>
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
