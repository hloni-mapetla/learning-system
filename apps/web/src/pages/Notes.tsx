import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { NOTE_KINDS, type Note } from '@loom/core/types';
import { qs, useApi } from '../lib/api';
import { relTime } from '../lib/format';
import { useListNav } from '../lib/useListNav';
import { AuthorBadge } from '../components/RecallBox';
import { Badge, Empty, PageHeader, Select } from '../components/ui';

export function NotesPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState('');
  const [tag, setTag] = useState('');
  const tags = useApi<{ name: string; notes: number }[]>('/tags');
  const { data } = useApi<{ items: Note[]; total: number }>(`/notes${qs({ kind, tag, limit: 300 })}`);
  const items = data?.items ?? [];
  const [sel] = useListNav(items.length, (i) => navigate({ to: '/notes/$id', params: { id: items[i].id } }));

  return (
    <div>
      <PageHeader
        title="Notes"
        subtitle={`${data?.total ?? 0} notes, highlights, concepts and claims`}
        actions={
          <>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All kinds</option>
              {NOTE_KINDS.map((k) => <option key={k}>{k}</option>)}
            </Select>
            <Select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">All tags</option>
              {tags.data?.filter((t) => t.notes > 0).map((t) => <option key={t.name} value={t.name}>#{t.name} ({t.notes})</option>)}
            </Select>
          </>
        }
      />
      {items.length === 0 ? (
        <Empty>No notes yet. Press <b>c</b> to create one.</Empty>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          {items.map((n, i) => (
            <li key={n.id} data-row={i} className={i === sel ? 'bg-accent-soft' : ''}>
              <Link to="/notes/$id" params={{ id: n.id }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-sunken">
                <Badge tone={n.kind === 'concept' || n.kind === 'claim' ? 'accent' : 'default'}>{n.kind}</Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate">{n.title}</div>
                  {(n.sourceTitle || n.tags.length > 0) && (
                    <div className="truncate text-xs text-faint">
                      {[n.sourceTitle, n.tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
                <AuthorBadge by={n.createdBy} />
                <span className="shrink-0 text-xs text-faint">{relTime(n.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
