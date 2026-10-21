import { Link } from '@tanstack/react-router';
import type { Task } from '@loom/core/types';
import { shortDate, today } from '../lib/format';
import { api, useAction } from '../lib/api';
import { Badge } from './ui';
import { KIND_LABEL } from './TaskForm';
import { StepInput, StepProgress } from './TaskSteps';
import { AuthorBadge } from './RecallBox';

/**
 * A task: its next action (the concrete step) shown under the title, progress, and on Today an inline
 * "first physical step" input for tasks that don't have one. `children` is the expanded steps panel.
 */
export function TaskRow({
  task,
  selected,
  onToggle,
  onExpand,
  expanded,
  showFirstStep,
  children,
}: {
  task: Task;
  selected?: boolean;
  onToggle: (t: Task) => void;
  onExpand?: (t: Task) => void;
  expanded?: boolean;
  /** Show the "What's the very first physical step?" input on undefined tasks (Today). */
  showFirstStep?: boolean;
  children?: React.ReactNode;
}) {
  const single = useAction(() => api.patch(`/tasks/${task.id}`, { singleStep: true }));
  const overdue = task.dueDate && task.dueDate < today() && task.status === 'open';
  if (task.virtual) {
    return (
      <Link to="/review" className={`flex items-center gap-3 rounded-lg border bg-accent-soft px-4 py-3 ${selected ? 'border-accent' : 'border-transparent'}`}>
        <span className="grid size-5 place-items-center rounded-full border-2 border-accent text-[10px] text-accent">↻</span>
        <div className="flex-1">
          <div className="font-medium text-accent">{task.title}</div>
          <div className="text-xs text-muted">{task.details} · or ask Claude for a daily review</div>
        </div>
        <span className="text-xs text-accent">Start →</span>
      </Link>
    );
  }
  const done = task.status === 'done';
  const { progress, nextAction } = task;
  const allDone = !done && progress.total > 0 && progress.done === progress.total;
  return (
    <div className={`rounded-lg border bg-panel px-4 py-2.5 ${selected ? 'border-accent' : 'border-line'}`}>
    <div className="flex items-center gap-3">
      <button
        onClick={() => onToggle(task)}
        aria-label={done ? 'Mark open' : 'Complete'}
        className={`grid size-5 shrink-0 place-items-center rounded-full border-2 text-[11px] ${done ? 'border-accent bg-accent text-accent-ink' : 'border-line hover:border-accent'}`}
      >
        {done ? '✓' : ''}
      </button>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onExpand?.(task)}
          className={`block max-w-full truncate text-left ${done ? 'text-faint line-through' : nextAction ? 'text-sm text-muted' : ''} ${onExpand ? 'cursor-pointer hover:text-accent' : 'cursor-default'}`}
          aria-expanded={onExpand ? !!expanded : undefined}
        >
          {task.title}
        </button>
        {!done && nextAction && !expanded && (
          <div className="truncate font-medium text-ink" title="Next action">
            <span className="mr-1 text-accent">→</span>
            {nextAction.title}
          </div>
        )}
        <div className="flex gap-2 text-xs text-faint">
          {task.kind !== 'todo' && <span>{KIND_LABEL[task.kind]}</span>}
          {task.sourceId && (
            <Link to="/sources/$id" params={{ id: task.sourceId }} className="truncate hover:text-accent">
              {task.sourceTitle}
            </Link>
          )}
        </div>
      </div>
      <AuthorBadge by={task.createdBy} />
      <StepProgress done={progress.done} total={progress.total} />
      {task.priority <= 2 && <Badge tone={task.priority === 1 ? 'danger' : 'warn'}>P{task.priority}</Badge>}
      {task.dueDate && <span className={`shrink-0 text-xs ${overdue ? 'text-danger' : 'text-faint'}`}>{task.dueDate === today() ? 'today' : shortDate(task.dueDate)}</span>}
    </div>
    {showFirstStep && task.needsFirstStep && (
      <div className="mt-2 ml-8 flex items-start gap-2">
        <StepInput task={task} first />
        <button onClick={() => single.mutate()} className="h-8 shrink-0 px-1 text-xs text-faint hover:text-accent" title="It's a single step (S)">
          it's one step
        </button>
      </div>
    )}
    {allDone && (
      <div className="mt-2 ml-8 flex items-center gap-2 text-sm">
        <span className="text-muted">All steps done. Complete the task?</span>
        <button onClick={() => onToggle(task)} className="rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-ink">Complete{selected ? ' (x)' : ''}</button>
      </div>
    )}
    {children}
    </div>
  );
}
