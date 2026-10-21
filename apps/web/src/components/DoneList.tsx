import type { DoneToday } from '@loom/core/types';

export function doneCount(d: DoneToday | undefined): number {
  return d ? d.tasks.length + d.subtasks.length + d.stepsDefined.length + d.sessions.length : 0;
}

/** What got done today: steps defined, steps ticked, sessions, tasks completed. */
export function DoneList({ done, empty = 'Nothing yet. Writing down a first step counts.' }: { done: DoneToday | undefined; empty?: string }) {
  if (!done || !doneCount(done)) return <p className="text-sm text-faint">{empty}</p>;
  return (
    <ul className="space-y-1 text-sm">
      {done.stepsDefined.map((d) => (
        <li key={`d${d.taskId}`} className="flex gap-2"><span className="text-accent">✎</span><span className="min-w-0 truncate">Defined next steps: <span className="text-muted">{d.taskTitle}</span></span></li>
      ))}
      {done.subtasks.map((d) => (
        <li key={`s${d.id}`} className="flex gap-2"><span className="text-accent">✓</span><span className="min-w-0 truncate">{d.title} <span className="text-faint">· {d.taskTitle}</span></span></li>
      ))}
      {done.sessions.map((d) => (
        <li key={`f${d.id}`} className="flex gap-2">
          <span className="text-accent">▶</span>
          <span className="min-w-0 truncate">
            {d.kind === 'starter' ? 'Started' : 'Focus block'} · {Math.max(1, Math.round(d.minutes))} min
            {d.outcome === 'continued' && ', kept going'}
            {d.taskTitle && <span className="text-faint"> · {d.taskTitle}</span>}
          </span>
        </li>
      ))}
      {done.tasks.map((d) => (
        <li key={`t${d.id}`} className="flex gap-2"><span className="text-accent">✔</span><span className="min-w-0 truncate font-medium">{d.title}</span></li>
      ))}
    </ul>
  );
}
