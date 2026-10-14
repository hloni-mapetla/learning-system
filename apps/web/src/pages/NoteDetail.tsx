import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { NOTE_KINDS, type Link as LinkT, type NoteDetail, type Source } from '@loom/core/types';
import { api, useAction, useApi } from '../lib/api';
import { relTime } from '../lib/format';
import { useHotkeys } from '../lib/hotkeys';
import { Badge, Button, Input, Section, Select, TagInput, Textarea } from '../components/ui';
import { Editor } from '../components/Editor';
import { Markdown } from '../components/Markdown';

const REL_LABEL: Record<string, [string, string]> = {
  wikilink: ['links to', 'linked from'],
  supports: ['supports', 'supported by'],
  contradicts: ['contradicts', 'contradicted by'],
  example_of: ['example of', 'has example'],
  prerequisite_of: ['prerequisite of', 'requires'],
  related: ['related', 'related'],
};

export function LinkList({ title, links, dir, onRemove }: { title: string; links: LinkT[]; dir: 'out' | 'in'; onRemove?: (id: string) => void }) {
  if (!links.length) return null;
  return (
    <Section title={`${title} (${links.length})`}>
      <ul className="space-y-1.5">
        {links.map((l) => {
          const other = dir === 'out' ? l.to : l.from;
          const label = REL_LABEL[l.rel]?.[dir === 'out' ? 0 : 1] ?? l.rel;
          return (
            <li key={l.id} className="group text-sm">
              <div className="flex items-start gap-1.5">
                <span className="mt-0.5 shrink-0 text-[10px] font-medium tracking-wide text-faint uppercase">{label}</span>
                {other ? (
                  <Link
                    to={other.type === 'note' ? '/notes/$id' : '/sources/$id'}
                    params={{ id: other.id }}
                    className="min-w-0 text-ink hover:text-accent"
                  >
                    {other.title}
                    {other.type === 'note' && other.sourceTitle && <span className="text-xs text-faint"> · {other.sourceTitle}</span>}
                  </Link>
                ) : (
                  <span className="text-warn" title="No note with this title yet">{l.targetTitle}</span>
                )}
                {onRemove && l.rel !== 'wikilink' && (
                  <button onClick={() => onRemove(l.id)} className="ml-auto hidden text-xs text-faint group-hover:inline hover:text-danger">
                    ✕
                  </button>
                )}
              </div>
              {l.rationale && <div className="ml-1 text-xs text-muted">{l.rationale}</div>}
              {l.createdBy === 'claude' && <div className="ml-1 text-[10px] text-faint">added by Claude</div>}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

export function NoteDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const search = useSearch({ strict: false }) as { edit?: boolean; focusTitle?: boolean };
  const navigate = useNavigate();
  const { data: n } = useApi<NoteDetail>(`/notes/${id}`);
  const sources = useApi<{ items: Source[] }>('/sources?sort=title&limit=1000');
  const patch = useAction((body: Record<string, unknown>) => api.patch(`/notes/${id}`, body));
  const remove = useAction(() => api.del(`/notes/${id}`));
  const removeLink = useAction((linkId: string) => api.del(`/links/${linkId}`));
  const [editing, setEditing] = useState(!!search.edit);
  const [draft, setDraft] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditing(!!search.edit);
    setDraft(null);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (search.focusTitle && n) titleRef.current?.select();
  }, [search.focusTitle, n?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (draft !== null && n && draft !== n.body) patch.mutate({ body: draft });
  };
  const onChange = (v: string) => {
    setDraft(v);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => patch.mutate({ body: v }), 800);
  };
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useHotkeys({ e: () => setEditing(true) }, []);

  const dangling = useMemo(
    () => new Set((n?.outgoing ?? []).filter((l) => !l.to && l.targetTitle).map((l) => l.targetTitle!.toLowerCase())),
    [n?.outgoing],
  );

  if (!n) return null;
  const body = draft ?? n.body;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_280px]">
      <article className="min-w-0">
        <div className="mb-1 flex items-center gap-2 text-xs text-faint">
          <Badge tone={n.kind === 'concept' || n.kind === 'claim' ? 'accent' : 'default'}>{n.kind}</Badge>
          {n.sourceId && (
            <Link to="/sources/$id" params={{ id: n.sourceId }} className="hover:text-accent">
              {n.sourceTitle}
            </Link>
          )}
          {n.location && <span>· {n.location}</span>}
          <span className="ml-auto">edited {relTime(n.updatedAt)}</span>
        </div>
        <input
          ref={titleRef}
          key={n.title}
          defaultValue={n.title}
          onBlur={(e) => e.target.value.trim() && e.target.value !== n.title && patch.mutate({ title: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              (e.target as HTMLInputElement).blur();
              setEditing(true);
            }
          }}
          className="mb-4 w-full bg-transparent text-2xl font-semibold tracking-tight outline-none"
        />
        {(n.kind === 'highlight' || n.quote) && (
          <Textarea
            key={n.quote ?? ''}
            defaultValue={n.quote ?? ''}
            rows={3}
            placeholder="Quote"
            onBlur={(e) => e.target.value !== (n.quote ?? '') && patch.mutate({ quote: e.target.value || null })}
            className="mb-4 border-l-4 border-l-accent font-serif text-base italic"
          />
        )}
        {editing ? (
          <div className="rounded-lg border border-line bg-panel px-4">
            <Editor
              value={body}
              onChange={onChange}
              autoFocus={!search.focusTitle}
              onBlur={flush}
              onEscape={() => {
                flush();
                setEditing(false);
              }}
            />
          </div>
        ) : (
          <div onDoubleClick={() => setEditing(true)} className="min-h-[30vh] cursor-text">
            {body.trim() ? (
              <Markdown text={body} dangling={dangling} />
            ) : (
              <p className="text-faint">Empty. Press <b>e</b> or double-click to write.</p>
            )}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          {editing ? (
            <Button size="sm" variant="ghost" onClick={() => { flush(); setEditing(false); }}>Done <span className="font-mono text-faint">esc</span></Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit <span className="font-mono text-faint">e</span></Button>
          )}
        </div>
      </article>

      <aside className="text-sm">
        <Section title="Properties">
          <div className="space-y-2">
            <Select value={n.kind} onChange={(e) => patch.mutate({ kind: e.target.value })} className="w-full">
              {NOTE_KINDS.map((k) => <option key={k}>{k}</option>)}
            </Select>
            <Select value={n.sourceId ?? ''} onChange={(e) => patch.mutate({ sourceId: e.target.value || null })} className="w-full">
              <option value="">No source (standalone)</option>
              {sources.data?.items.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </Select>
            <Input key={n.location ?? ''} defaultValue={n.location ?? ''} placeholder="Location (page, chapter)" onBlur={(e) => e.target.value !== (n.location ?? '') && patch.mutate({ location: e.target.value || null })} />
            <TagInput value={n.tags} onChange={(tags) => patch.mutate({ tags })} />
            <Input
              key={n.aliases.join(',')}
              defaultValue={n.aliases.join(', ')}
              placeholder="aliases, comma separated"
              onBlur={(e) => {
                const aliases = e.target.value.split(',').map((a) => a.trim()).filter(Boolean);
                if (aliases.join(',') !== n.aliases.join(',')) patch.mutate({ aliases });
              }}
            />
          </div>
        </Section>
        <LinkList title="Links" links={n.outgoing} dir="out" onRemove={(lid) => removeLink.mutate(lid)} />
        <LinkList title="Backlinks" links={n.backlinks} dir="in" onRemove={(lid) => removeLink.mutate(lid)} />
        <div className="pt-4">
          <Button
            variant="danger"
            size="sm"
            onClick={async () => {
              if (!confirm(`Delete "${n.title}"? Cards made from it are deleted too.`)) return;
              await remove.mutateAsync(undefined);
              navigate({ to: '/notes' });
            }}
          >
            Delete note
          </Button>
        </div>
      </aside>
    </div>
  );
}
