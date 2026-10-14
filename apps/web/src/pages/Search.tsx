import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { SearchHit } from '@loom/core/types';
import { useApi, qs } from '../lib/api';
import { snippetHtml } from '../lib/format';
import { useListNav } from '../lib/useListNav';
import { Badge, Empty, Input, PageHeader } from '../components/ui';

const MODES = [
  ['hybrid', 'Hybrid'],
  ['text', 'Keyword'],
  ['semantic', 'Semantic'],
] as const;

export function SearchPage() {
  const params = useSearch({ strict: false }) as { q?: string; mode?: string };
  const navigate = useNavigate();
  const [q, setQ] = useState(params.q ?? '');
  const [debounced, setDebounced] = useState(q);
  const [mode, setMode] = useState(params.mode ?? 'hybrid');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    navigate({ to: '/search', search: { q: debounced || undefined, mode: mode === 'hybrid' ? undefined : mode } as any, replace: true });
  }, [debounced, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isFetching } = useApi<SearchHit[]>(debounced.trim() ? `/search${qs({ q: debounced, mode, limit: 40 })}` : null);
  const hits = data ?? [];
  const open = (h: SearchHit) => {
    if (h.type === 'note') navigate({ to: '/notes/$id', params: { id: h.id } });
    else if (h.type === 'source') navigate({ to: '/sources/$id', params: { id: h.id } });
    else navigate({ to: '/cards', search: { card: h.id } as any });
  };
  const [sel] = useListNav(hits.length, (i) => open(hits[i]), { '/': () => input.current?.focus() });

  return (
    <div className="max-w-3xl">
      <PageHeader title="Search" subtitle="Keyword search finds exact terms; semantic search finds ideas phrased differently." />
      <div className="mb-4 flex gap-2">
        <Input
          ref={input}
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => (e.key === 'Escape' || e.key === 'Enter') && (e.target as HTMLInputElement).blur()}
          placeholder="Search notes, highlights, sources and cards…"
          className="h-11 text-base"
        />
        <div className="flex shrink-0 rounded-md border border-line bg-panel p-0.5">
          {MODES.map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded px-3 text-sm ${mode === m ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {debounced && !isFetching && hits.length === 0 && <Empty>No results for “{debounced}”.</Empty>}
      <ul className="space-y-2">
        {hits.map((h, i) => (
          <li key={`${h.type}:${h.id}`} data-row={i}>
            <button
              onClick={() => open(h)}
              className={`block w-full rounded-lg border bg-panel px-4 py-3 text-left hover:border-accent ${i === sel ? 'border-accent' : 'border-line'}`}
            >
              <div className="flex items-center gap-2">
                <Badge tone={h.type === 'source' ? 'accent' : 'default'}>{h.type === 'note' ? h.kind : h.type}</Badge>
                <span className="truncate font-medium">{h.title}</span>
                {h.type === 'note' && h.sourceTitle && <span className="truncate text-xs text-faint">· {h.sourceTitle}</span>}
                <span className="ml-auto shrink-0 text-[10px] text-faint">{h.matchedBy.join(' + ')}</span>
              </div>
              <div className="mt-1 line-clamp-2 text-sm text-muted" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
