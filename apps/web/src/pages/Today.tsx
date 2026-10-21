import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { CompleteResult, DoneToday, Subtask, Task } from '@loom/core';
import { api, useAction, useApi } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { useStartSession } from '../lib/session';
import { Button, Empty, PageHeader, Section } from '../components/ui';
import { TaskForm } from '../components/TaskForm';
import { TaskRow } from '../components/TaskRow';
import { TaskSteps } from '../components/TaskSteps';
import { RecallBox } from '../components/RecallBox';
import { Priority } from './Sources';

interface QueueItem {
  id: string;
  title: string;
  authors: string;
  status: string;
  priority: number;
  notes: number;
  openTasks: Task[];
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function TodayPage() {
  const navigate = useNavigate();
  const todayTasks = useApi<Task[]>('/tasks?view=today');
  const upcoming = useApi<Task[]>('/tasks?view=upcoming');
  const others = useApi<Task[]>('/tasks?view=all_open');
  const queue = useApi<QueueItem[]>('/reading-queue');
  const [adding, setAdding] = useState(false);
  const [capture, setCapture] = useState<CompleteResult['followUp']>(null);
  const complete = useAction((id: string) => api.post<CompleteResult>(`/tasks/${id}/complete`));
  const reopen = useAction((id: string) => api.patch(`/tasks/${id}`, { status: 'open' }));
  const laterTask = useAction((b: unknown) => api.post('/tasks', b));

  const todayList = todayTasks.data ?? [];
  const todayIds = new Set(todayList.map((t) => t.id));
  const upcomingIds = new Set((upcoming.data ?? []).map((t) => t.id));
  const someday = (others.data ?? []).filter((t) => !todayIds.has(t.id) && !upcomingIds.has(t.id) && !t.virtual);
  const done = useApi<DoneToday>('/done-today');
  const tasks = [...todayList, ...(upcoming.data ?? []), ...someday];

  // Keyboard model: j/k walk tasks and, inside an expanded task, its steps. Selection is kept by id so it survives refetches.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selKey, setSelKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  type Row = { key: string; task: Task; step?: Subtask };
  const flat: Row[] = tasks.flatMap((t) => [
    { key: `t:${t.id}`, task: t },
    ...(expanded.has(t.id) ? t.subtasks.map((st) => ({ key: `s:${st.id}`, task: t, step: st })) : []),
  ]);
  const sel = flat.findIndex((r) => r.key === selKey);
  const cur = sel >= 0 ? flat[sel] : null;
  useEffect(() => {
    if (sel >= 0) document.querySelector(`[data-row="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const toggleStep = useAction((st: Subtask) => api.post(`/subtasks/${st.id}/complete`, { undo: st.done }));
  const moveStep = useAction(({ id, delta }: { id: string; delta: number }) => api.post(`/subtasks/${id}/move`, { delta }));
  const removeStep = useAction((id: string) => api.del(`/subtasks/${id}`));
  const setSingle = useAction((t: Task) => api.patch(`/tasks/${t.id}`, { singleStep: !t.singleStep }));

  const startSession = useStartSession();
  /** t = "just 10 minutes", f = focus block, on the selected step or the task's next action. */
  const startOn = (kind: 'starter' | 'focus') => {
    if (!cur || cur.task.virtual || cur.task.status === 'done') return;
    startSession(kind, { taskId: cur.task.id, subtaskId: cur.step && !cur.step.done ? cur.step.id : (cur.task.nextAction?.id ?? null) });
  };

  const toggle = async (t: Task) => {
    if (t.virtual) return navigate({ to: '/review' });
    if (t.status === 'done') return reopen.mutate(t.id);
    const r = await complete.mutateAsync(t.id);
    if (r.followUp) setCapture(r.followUp);
  };
  const expand = (t: Task, open = !expanded.has(t.id)) => {
    if (t.virtual) return;
    setExpanded((e) => {
      const n = new Set(e);
      if (open) n.add(t.id);
      else n.delete(t.id);
      return n;
    });
    if (!open) setSelKey(`t:${t.id}`);
  };
  const focusStepInput = (t: Task) => {
    if (t.virtual) return;
    if (!t.needsFirstStep) expand(t, true);
    setTimeout(() => document.getElementById(`step-input-${t.id}`)?.focus(), 0);
  };
  const go = (d: number) => {
    const i = Math.max(0, Math.min(flat.length - 1, (sel < 0 && d > 0 ? -1 : sel) + d));
    if (flat[i]) setSelKey(flat[i].key);
  };
  const move = (d: number) => cur?.step && moveStep.mutate({ id: cur.step.id, delta: d });

  useHotkeys(
    {
      j: () => go(1),
      k: () => go(-1),
      ArrowDown: () => go(1),
      ArrowUp: () => go(-1),
      a: () => setAdding(true),
      Enter: () => cur && expand(cur.task, cur.step ? false : undefined),
      x: () => cur && (cur.step ? toggleStep.mutate(cur.step) : toggle(cur.task)),
      ' ': () => cur && (cur.step ? toggleStep.mutate(cur.step) : expand(cur.task)),
      n: () => cur && focusStepInput(cur.task),
      e: () => cur?.step && setEditing(cur.step.id),
      'alt+ArrowUp': () => move(-1),
      'alt+ArrowDown': () => move(1),
      K: () => move(-1),
      J: () => move(1),
      S: () => cur && !cur.task.virtual && setSingle.mutate(cur.task),
      t: () => startOn('starter'),
      f: () => startOn('focus'),
      Backspace: () => {
        if (!cur?.step || !confirm(`Delete step “${cur.step.title}”?`)) return;
        go(-1);
        removeStep.mutate(cur.step.id);
      },
    },
    [flat, sel, cur, expanded],
  );

  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const rows = (list: Task[]) => (
    <ul className="space-y-2">
      {list.map((t) => {
        const i = flat.findIndex((r) => r.key === `t:${t.id}`);
        const open = expanded.has(t.id);
        return (
          <li key={t.id} data-row={i}>
            <TaskRow
              task={t}
              selected={i === sel}
              onToggle={toggle}
              onExpand={(x) => expand(x)}
              expanded={open}
              showFirstStep={!open}
              onStart={(x) => startSession('starter', { taskId: x.id, subtaskId: x.nextAction?.id ?? null })}
            >
              {open && (
                <TaskSteps task={t} rowIndex={i + 1} selectedId={cur?.step?.id ?? null} editingId={editing} onEdited={() => setEditing(null)} />
              )}
            </TaskRow>
          </li>
        );
      })}
    </ul>
  );
  const doneCount =
    (done.data?.tasks.length ?? 0) + (done.data?.subtasks.length ?? 0) + (done.data?.stepsDefined.length ?? 0) + (done.data?.sessions.length ?? 0);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        <PageHeader title="Today" subtitle={dateLabel} actions={<Button variant="primary" onClick={() => setAdding(true)}>Add task <span className="font-mono text-xs opacity-70">a</span></Button>} />
        {capture && (
          <div className="mb-6 rounded-lg border border-accent bg-panel p-4">
            <div className="mb-2 font-medium">{capture.message}</div>
            {capture.sourceId ? (
              <RecallBox sourceId={capture.sourceId} sourceTitle={capture.sourceTitle} onSaved={() => setCapture(null)} />
            ) : (
              <p className="text-sm text-muted">Write it down anywhere (press <b>c</b> for a new note), then look at your highlights.</p>
            )}
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  await laterTask.mutateAsync({ title: `Recall & process: ${capture.sourceTitle ?? 'reading'}`, kind: 'process_highlights', sourceId: capture.sourceId, dueDate: tomorrow(), priority: 2 });
                  setCapture(null);
                }}
              >
                Remind me tomorrow
              </Button>
              {capture.sourceId && (
                <Link to="/sources/$id" params={{ id: capture.sourceId }} className="inline-flex h-7 items-center px-2 text-xs text-accent">Open source</Link>
              )}
              <Button size="sm" variant="ghost" onClick={() => setCapture(null)}>Dismiss</Button>
            </div>
          </div>
        )}
        {adding && <TaskForm onDone={() => setAdding(false)} />}
        {todayList.length ? rows(todayList) : <Empty>Nothing due today. Press <b>a</b> to add a task.</Empty>}
        {!!upcoming.data?.length && <div className="mt-8"><Section title="Upcoming">{rows(upcoming.data)}</Section></div>}
        {!!someday.length && <div className="mt-8"><Section title="Someday">{rows(someday)}</Section></div>}
      </div>
      <aside className="space-y-8">
        <Section title={`Done today${doneCount ? ` · ${doneCount}` : ''}`}>
          {doneCount ? (
            <ul className="space-y-1 text-sm">
              {done.data!.stepsDefined.map((d) => (
                <li key={`d${d.taskId}`} className="flex gap-2"><span className="text-accent">✎</span><span className="min-w-0 truncate">Defined next steps: <span className="text-muted">{d.taskTitle}</span></span></li>
              ))}
              {done.data!.subtasks.map((d) => (
                <li key={`s${d.id}`} className="flex gap-2"><span className="text-accent">✓</span><span className="min-w-0 truncate">{d.title} <span className="text-faint">· {d.taskTitle}</span></span></li>
              ))}
              {done.data!.sessions.map((d) => (
                <li key={`f${d.id}`} className="flex gap-2">
                  <span className="text-accent">▶</span>
                  <span className="min-w-0 truncate">
                    {d.kind === 'starter' ? 'Started' : 'Focus block'} · {Math.max(1, Math.round(d.minutes))} min
                    {d.outcome === 'continued' && ', kept going'}
                    {d.taskTitle && <span className="text-faint"> · {d.taskTitle}</span>}
                  </span>
                </li>
              ))}
              {done.data!.tasks.map((d) => (
                <li key={`t${d.id}`} className="flex gap-2"><span className="text-accent">✔</span><span className="min-w-0 truncate font-medium">{d.title}</span></li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-faint">Nothing yet. Writing down a first step counts.</p>
          )}
        </Section>
        <Section title="Reading queue" actions={<Link to="/sources" className="text-xs text-accent">all sources</Link>}>
          {queue.data?.length ? (
            <ul className="space-y-2">
              {queue.data.map((s) => (
                <li key={s.id}>
                  <Link to="/sources/$id" params={{ id: s.id }} className="block rounded-lg border border-line bg-panel px-3 py-2 hover:border-accent">
                    <div className="flex items-center gap-2">
                      <Priority p={s.priority} />
                      <span className="truncate text-sm font-medium">{s.title}</span>
                    </div>
                    <div className="text-xs text-faint">
                      {s.status === 'reading' ? 'reading' : 'queued'} · {s.notes} notes{s.openTasks.length ? ` · ${s.openTasks.length} tasks` : ''}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-faint">Queue is empty.</p>
          )}
        </Section>
      </aside>
    </div>
  );
}
