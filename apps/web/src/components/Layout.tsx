import { useState } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { api, useApi } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { CommandPalette, type Command } from './CommandPalette';
import { Kbd } from './ui';
import { ShortcutHelp } from './ShortcutHelp';

export const NAV: { to: string; label: string; key: string }[] = [
  { to: '/review', label: 'Review', key: 'r' },
  { to: '/sources', label: 'Sources', key: 's' },
  { to: '/notes', label: 'Notes', key: 'n' },
  { to: '/cards', label: 'Cards', key: 'c' },
  { to: '/search', label: 'Search', key: '/' },
];

interface Status {
  pendingEmbeddings: number;
  semantic: boolean;
}

export function Layout() {
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const navigate = useNavigate();
  const status = useApi<Status>('/status', { refetchInterval: 10_000 });

  const newNote = async () => {
    const n = await api.post<{ id: string }>('/notes', { title: 'Untitled note' });
    navigate({ to: '/notes/$id', params: { id: n.id }, search: { edit: true, focusTitle: true } as any });
  };

  const commands: Command[] = [
    { id: 'new-note', label: 'New note', hint: 'c', run: newNote },
    { id: 'new-source', label: 'New source', hint: 'g s, a', run: () => navigate({ to: '/sources', search: { add: true } as any }) },
    ...NAV.map((n) => ({ id: `go-${n.to}`, label: `Go to ${n.label}`, hint: n.key === '/' ? '/' : `g ${n.key}`, run: () => navigate({ to: n.to }) })),
    { id: 'help', label: 'Keyboard shortcuts', hint: '?', run: () => setHelp(true) },
  ];

  useHotkeys(
    {
      'mod+k': () => setPalette((p) => !p),
      'shift+?': () => setHelp((h) => !h),
      '/': () => navigate({ to: '/search' }),
      c: newNote,
      ...Object.fromEntries(NAV.filter((n) => n.key !== '/').map((n) => [`g ${n.key}`, () => navigate({ to: n.to })])),
    },
    [],
  );

  return (
    <div className="flex h-full">
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-56 shrink-0 flex-col border-r border-line bg-panel md:static md:flex ${navOpen ? 'flex' : 'hidden'}`}
      >
        <div className="flex h-14 items-center gap-2 px-5">
          <div className="grid size-7 place-items-center rounded-md bg-accent text-sm font-bold text-accent-ink">L</div>
          <span className="font-semibold tracking-tight">Loom</span>
        </div>
        <button
          onClick={() => setPalette(true)}
          className="mx-3 mb-3 flex h-8 items-center justify-between rounded-md border border-line bg-sunken px-2.5 text-xs text-faint hover:text-muted"
        >
          Search… <Kbd>⌘K</Kbd>
        </button>
        <nav className="flex flex-col gap-0.5 px-3" onClick={() => setNavOpen(false)}>
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="flex h-8 items-center justify-between rounded-md px-2.5 text-sm text-muted hover:bg-sunken hover:text-ink"
              activeProps={{ className: '!bg-accent-soft !text-accent font-medium' }}
            >
              {n.label}
              <span className="font-mono text-[10px] text-faint">{n.key === '/' ? '/' : `g ${n.key}`}</span>
            </Link>
          ))}
        </nav>
        <div className="mt-auto space-y-1 px-5 py-4 text-[11px] text-faint">
          {status.data && !status.data.semantic && <div>Semantic search off</div>}
          {!!status.data?.pendingEmbeddings && <div>Indexing {status.data.pendingEmbeddings}…</div>}
          <button onClick={() => setHelp(true)} className="hover:text-muted">
            <Kbd>?</Kbd> shortcuts
          </button>
        </div>
      </aside>
      {navOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setNavOpen(false)} />}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-line bg-bg/90 px-4 backdrop-blur md:hidden">
          <button onClick={() => setNavOpen(true)} className="text-sm text-muted" aria-label="Menu">
            ☰
          </button>
          <span className="font-semibold">Loom</span>
          <button onClick={() => setPalette(true)} className="ml-auto text-sm text-muted">
            Search
          </button>
        </div>
        <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </div>
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </div>
  );
}
