import { Link } from '@tanstack/react-router';
import type { Day } from '@loom/core/types';
import { useStartSession } from '../lib/session';
import { Button, Kbd } from './ui';

/** Start the day's first thing as a "just 10 minutes" starter, on its first step. */
export function useStartFirstThing(day: Day | undefined) {
  const start = useStartSession();
  const ft = day?.firstThing;
  if (!ft || ft.task.status !== 'open') return null;
  return () => start('starter', { taskId: ft.task.id, subtaskId: ft.step?.id ?? null });
}

/** The one task planned to start the day with, and a one-key Start. Shown until work has started. */
export function FirstThingCard({ day, startKey, big = false }: { day: Day; startKey: string; big?: boolean }) {
  const start = useStartFirstThing(day);
  const ft = day.firstThing;
  if (!ft) {
    return (
      <div className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">
        No first thing planned. <Link to="/plan" search={{ for: 'today' } as any} className="text-accent hover:underline">Pick one now</Link>: one task and its first step.
      </div>
    );
  }
  if (ft.task.status !== 'open') {
    return <div className="rounded-lg border border-line bg-panel p-4 text-sm text-muted">First thing done: <b>{ft.task.title}</b>.</div>;
  }
  return (
    <div className={`rounded-lg border border-accent bg-panel ${big ? 'p-6' : 'p-4'}`}>
      <div className="mb-1 flex items-center justify-between text-xs font-semibold tracking-wide text-faint uppercase">
        <span>First thing</span>
        {day.targetStart && <span className="normal-case">at {day.targetStart}</span>}
      </div>
      <div className={`${big ? 'text-2xl' : 'text-lg'} leading-snug font-medium`}>{ft.step?.title ?? ft.task.title}</div>
      {ft.step && <div className="text-sm text-muted">{ft.task.title}</div>}
      <div className="mt-4">
        <Button variant="primary" onClick={() => start?.()}>
          ▶ Start: just 10 minutes <Kbd>{startKey}</Kbd>
        </Button>
      </div>
    </div>
  );
}
