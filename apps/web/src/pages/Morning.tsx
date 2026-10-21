import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Day, RoutineItem } from '@loom/core/types';
import { api, useAction, useApi } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { hm } from '../lib/format';
import { Button, Kbd } from '../components/ui';
import { FirstThingCard, useStartFirstThing } from '../components/FirstThing';

/** A time shown as text; click (or its key) to edit it in place. */
function TimeField({ value, onSave, editing, setEditing }: { value: string | null; onSave: (hhmm: string | null) => void; editing: boolean; setEditing: (b: boolean) => void }) {
  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} className="font-mono tabular-nums underline decoration-line decoration-dotted underline-offset-4 hover:text-accent">
        {hm(value)}
      </button>
    );
  }
  return (
    <input
      type="time"
      autoFocus
      defaultValue={hm(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onSave((e.target as HTMLInputElement).value || null);
          setEditing(false);
        }
        if (e.key === 'Escape') setEditing(false);
      }}
      onBlur={() => setEditing(false)}
      className="h-8 rounded-md border border-accent bg-panel px-2 font-mono tabular-nums"
    />
  );
}

/**
 * The morning: log the wake time, walk the routine, and start the first thing planned last night with one key.
 * The first-thing card stays up until work has started.
 */
export function MorningPage() {
  const navigate = useNavigate();
  const day = useApi<Day>('/days/today');
  const d = day.data;
  const routine = d?.routine ?? [];
  const [sel, setSel] = useState(0);
  const [editMode, setEditMode] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editWake, setEditWake] = useState(false);
  const [editStart, setEditStart] = useState(false);

  const logWake = useAction(() => api.post('/days/today/wake'));
  const patchDay = useAction((b: Record<string, string | null>) => api.patch('/days/today', b));
  const check = useAction(({ id, checked }: { id: string; checked: boolean }) => api.post(`/days/today/routine/${id}`, { checked }));
  const addItem = useAction((b: { title: string; position: number }) => api.post('/routine', b));
  const updateItem = useAction(({ id, ...b }: { id: string; title?: string; optional?: boolean }) => api.patch(`/routine/${id}`, b));
  const moveItem = useAction(({ id, delta }: { id: string; delta: number }) => api.post(`/routine/${id}/move`, { delta }));
  const removeItem = useAction((id: string) => api.del(`/routine/${id}`));
  const startFirst = useStartFirstThing(d);

  useEffect(() => setSel((i) => Math.min(i, Math.max(0, routine.length - 1))), [routine.length]);
  const cur: (RoutineItem & { checkedAt: string | null }) | undefined = routine[sel];
  const started = !!d?.workStartAt;

  const toggle = (it: RoutineItem & { checkedAt: string | null }) => {
    // Ticking "Start first task" starts it.
    if (it.action === 'start_first_task' && !it.checkedAt && !started && startFirst) return startFirst();
    check.mutate({ id: it.id, checked: !it.checkedAt });
  };
  const move = (delta: number) => {
    if (!cur) return;
    moveItem.mutate({ id: cur.id, delta });
    setSel((i) => Math.max(0, Math.min(routine.length - 1, i + delta)));
  };

  useHotkeys(
    {
      j: () => setSel((i) => Math.min(routine.length - 1, i + 1)),
      k: () => setSel((i) => Math.max(0, i - 1)),
      ArrowDown: () => setSel((i) => Math.min(routine.length - 1, i + 1)),
      ArrowUp: () => setSel((i) => Math.max(0, i - 1)),
      x: () => !editMode && cur && toggle(cur),
      ' ': () => !editMode && cur && toggle(cur),
      w: () => (d?.wakeAt ? setEditWake(true) : logWake.mutate(undefined)),
      W: () => setEditStart(true),
      s: () => !started && startFirst?.(),
      p: () => navigate({ to: '/plan', search: { for: 'today' } as any }),
      e: () => setEditMode((m) => !m),
      Escape: () => (editMode ? setEditMode(false) : navigate({ to: '/today' })),
      Enter: () => (editMode ? cur && setRenaming(cur.id) : !started && startFirst?.()),
      n: () => editMode && setAdding(true),
      o: () => editMode && cur && updateItem.mutate({ id: cur.id, optional: !cur.optional }),
      K: () => editMode && move(-1),
      J: () => editMode && move(1),
      'alt+ArrowUp': () => editMode && move(-1),
      'alt+ArrowDown': () => editMode && move(1),
      Backspace: () => editMode && cur && confirm(`Remove “${cur.title}” from the routine?`) && removeItem.mutate(cur.id),
    },
    [routine, sel, cur, editMode, d, started, startFirst],
  );

  if (!d) return null;
  const doneN = routine.filter((i) => i.checkedAt).length;
  const dateLabel = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Morning</h1>
        <div className="mt-1 text-sm text-muted">{dateLabel}</div>
      </div>

      {/* Wake and work start */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted">Woke at</span>
          {d.wakeAt || editWake ? (
            <TimeField value={d.wakeAt} editing={editWake} setEditing={setEditWake} onSave={(v) => patchDay.mutate({ wakeAt: v })} />
          ) : (
            <Button size="sm" onClick={() => logWake.mutate(undefined)}>I'm up <Kbd>w</Kbd></Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted">Started work</span>
          {d.workStartAt || editStart ? (
            <TimeField value={d.workStartAt} editing={editStart} setEditing={setEditStart} onSave={(v) => patchDay.mutate({ workStartAt: v })} />
          ) : (
            <span className="text-faint">when the first session starts</span>
          )}
          {d.wakeToWorkMinutes !== null && <span className="text-faint">· {d.wakeToWorkMinutes} min after waking</span>}
        </div>
      </div>

      {started ? (
        <div className="rounded-lg border border-line bg-panel p-4 text-sm text-muted">
          Work started at <b className="text-ink">{hm(d.workStartAt)}</b>. The hard part is done.
        </div>
      ) : (
        <FirstThingCard day={d} startKey="↵" big />
      )}

      {/* Routine */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold tracking-wide text-faint uppercase">
            Routine · {doneN}/{routine.length}
          </h2>
          <button onClick={() => setEditMode((m) => !m)} className="text-xs text-faint hover:text-ink">
            {editMode ? 'done editing' : 'edit'} <Kbd>e</Kbd>
          </button>
        </div>
        <ul className="space-y-1">
          {routine.map((it, i) => (
            <li
              key={it.id}
              onMouseEnter={() => setSel(i)}
              className={`flex items-center gap-3 rounded-md border px-3 py-2 ${i === sel ? 'border-accent' : 'border-transparent'} ${it.checkedAt ? 'text-faint' : ''}`}
            >
              <button
                onClick={() => (editMode ? null : toggle(it))}
                aria-label={it.checkedAt ? 'Untick' : 'Tick'}
                className={`grid size-5 shrink-0 place-items-center rounded border-2 text-[11px] ${it.checkedAt ? 'border-accent bg-accent text-accent-ink' : 'border-line'}`}
              >
                {it.checkedAt ? '✓' : ''}
              </button>
              {renaming === it.id ? (
                <input
                  autoFocus
                  defaultValue={it.title}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const v = (e.target as HTMLInputElement).value.trim();
                      if (v && v !== it.title) updateItem.mutate({ id: it.id, title: v });
                      setRenaming(null);
                    }
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                  className="h-7 min-w-0 flex-1 rounded border border-accent bg-panel px-2 text-sm text-ink"
                />
              ) : (
                <span className={`min-w-0 flex-1 truncate ${it.checkedAt ? 'line-through' : ''}`} onDoubleClick={() => setRenaming(it.id)}>
                  {it.title}
                </span>
              )}
              {it.optional && <span className="text-[11px] text-faint">optional</span>}
              {it.checkedAt && <span className="font-mono text-[11px] text-faint tabular-nums">{hm(it.checkedAt)}</span>}
            </li>
          ))}
        </ul>
        {adding && (
          <input
            autoFocus
            placeholder="New routine item (↵ to add, esc to stop)"
            onKeyDown={async (e) => {
              const el = e.target as HTMLInputElement;
              if (e.key === 'Enter' && el.value.trim()) {
                await addItem.mutateAsync({ title: el.value.trim(), position: sel + 1 });
                el.value = '';
                setSel((i) => i + 1);
              }
              if (e.key === 'Escape') setAdding(false);
            }}
            onBlur={() => setAdding(false)}
            className="mt-2 h-8 w-full rounded-md border border-dashed border-line bg-transparent px-2.5 text-sm focus:border-solid focus:border-accent focus:outline-none"
          />
        )}
        <p className="mt-3 text-xs text-faint">
          {editMode ? (
            <><Kbd>↵</Kbd> rename · <Kbd>n</Kbd> add below · <Kbd>o</Kbd> optional · <Kbd>K</Kbd>/<Kbd>J</Kbd> move · <Kbd>⌫</Kbd> remove · <Kbd>esc</Kbd> done</>
          ) : (
            <><Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>x</Kbd> tick · <Kbd>w</Kbd> woke (edit) · <Kbd>↵</Kbd> start first thing · <Kbd>p</Kbd> pick a different one · <Kbd>e</Kbd> edit routine</>
          )}
        </p>
      </section>
    </div>
  );
}
