import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import type { CompleteResult, Task } from '@loom/core';
import { api, useAction, useApi } from '../lib/api';
import { useListNav } from '../lib/useListNav';
import { Button, Empty, PageHeader, Section } from '../components/ui';
import { TaskForm } from '../components/TaskForm';
import { TaskRow } from '../components/TaskRow';
import { CaptureHighlight } from './SourceDetail';
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
  const flat = [...todayList, ...(upcoming.data ?? []), ...someday];

  const toggle = async (t: Task) => {
    if (t.virtual) return navigate({ to: '/review' });
    if (t.status === 'done') return reopen.mutate(t.id);
    const r = await complete.mutateAsync(t.id);
    if (r.followUp) setCapture(r.followUp);
  };
  const [sel] = useListNav(flat.length, (i) => toggle(flat[i]), {
    a: () => setAdding(true),
    x: () => sel >= 0 && toggle(flat[sel]),
  });

  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  let row = 0;
  const rows = (list: Task[]) => (
    <ul className="space-y-2">
      {list.map((t) => {
        const i = row++;
        return (
          <li key={t.id} data-row={i}>
            <TaskRow task={t} selected={i === sel} onToggle={toggle} />
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        <PageHeader title="Today" subtitle={dateLabel} actions={<Button variant="primary" onClick={() => setAdding(true)}>Add task <span className="font-mono text-xs opacity-70">a</span></Button>} />
        {capture && (
          <div className="mb-6 rounded-lg border border-accent bg-panel p-4">
            <div className="mb-2 font-medium">{capture.message}</div>
            {capture.sourceId ? (
              <CaptureHighlight sourceId={capture.sourceId} onDone={() => setCapture(null)} />
            ) : null}
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  await laterTask.mutateAsync({ title: `Process highlights: ${capture.sourceTitle ?? 'reading'}`, kind: 'process_highlights', sourceId: capture.sourceId, dueDate: tomorrow(), priority: 2 });
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
      <aside>
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
