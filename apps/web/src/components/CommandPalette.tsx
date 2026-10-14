import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { SearchHit } from '@loom/core/types';
import { api } from '../lib/api';
import { snippetHtml } from '../lib/format';
import { Kbd } from './ui';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) {
      setQ('');
      setHits([]);
      setSel(0);
    }
  }, [open]);

  useEffect(() => {
    if (!q.trim()) return setHits([]);
    const ctl = { cancelled: false };
    const t = setTimeout(async () => {
      const res = await api.get<SearchHit[]>(`/search?q=${encodeURIComponent(q)}&limit=12`);
      if (!ctl.cancelled) setHits(res);
    }, 180);
    return () => {
      ctl.cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const matched = useMemo(() => {
    const s = q.toLowerCase().trim();
    return s ? commands.filter((c) => c.label.toLowerCase().includes(s)) : commands;
  }, [q, commands]);

  type Row = { key: string; run: () => void; node: React.ReactNode };
  const rows: Row[] = [
    ...matched.slice(0, q ? 4 : 12).map((c) => ({
      key: c.id,
      run: c.run,
      node: (
        <div className="flex items-center justify-between">
          <span>{c.label}</span>
          {c.hint && <span className="font-mono text-xs text-faint">{c.hint}</span>}
        </div>
      ),
    })),
    ...hits.map((h) => ({
      key: `${h.type}:${h.id}`,
      run: () => {
        if (h.type === 'note') navigate({ to: '/notes/$id', params: { id: h.id } });
        else if (h.type === 'source') navigate({ to: '/sources/$id', params: { id: h.id } });
        else navigate({ to: '/cards', search: { card: h.id } as any });
      },
      node: (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold tracking-wide text-faint uppercase">{h.type === 'note' ? h.kind : h.type}</span>
            <span className="truncate font-medium">{h.title}</span>
            {h.sourceTitle && h.type === 'note' && <span className="truncate text-xs text-faint">· {h.sourceTitle}</span>}
          </div>
          <div className="truncate text-xs text-muted" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />
        </div>
      ),
    })),
  ];

  if (!open) return null;
  const choose = (i: number) => {
    rows[i]?.run();
    onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
              e.preventDefault();
              setSel((s) => Math.min(rows.length - 1, s + 1));
            } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (e.metaKey || e.ctrlKey) {
                navigate({ to: '/search', search: { q } as any });
                onClose();
              } else choose(sel);
            }
          }}
          placeholder="Search everything, or type a command…"
          className="h-12 w-full border-b border-line bg-transparent px-4 text-base outline-none placeholder:text-faint"
        />
        <ul className="max-h-[50vh] overflow-y-auto py-1">
          {rows.map((r, i) => (
            <li
              key={r.key}
              onMouseMove={() => setSel(i)}
              onClick={() => choose(i)}
              className={`cursor-pointer px-4 py-2 text-sm ${i === sel ? 'bg-accent-soft' : ''}`}
            >
              {r.node}
            </li>
          ))}
          {q && !rows.length && <li className="px-4 py-6 text-center text-sm text-muted">No matches</li>}
        </ul>
        <div className="flex gap-3 border-t border-line px-4 py-2 text-[11px] text-faint">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> move</span>
          <span><Kbd>↵</Kbd> open</span>
          <span><Kbd>⌘↵</Kbd> all results</span>
          <span><Kbd>esc</Kbd> close</span>
        </div>
      </div>
    </div>
  );
}
