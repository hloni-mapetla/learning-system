import { Link } from '@tanstack/react-router';
import type { Task } from '@loom/core/types';
import { shortDate, today } from '../lib/format';
import { Badge } from './ui';
import { KIND_LABEL } from './TaskForm';

export function TaskRow({ task, selected, onToggle }: { task: Task; selected?: boolean; onToggle: (t: Task) => void }) {
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
  return (
    <div className={`flex items-center gap-3 rounded-lg border bg-panel px-4 py-2.5 ${selected ? 'border-accent' : 'border-line'}`}>
      <button
        onClick={() => onToggle(task)}
        aria-label={done ? 'Mark open' : 'Complete'}
        className={`grid size-5 shrink-0 place-items-center rounded-full border-2 text-[11px] ${done ? 'border-accent bg-accent text-accent-ink' : 'border-line hover:border-accent'}`}
      >
        {done ? '✓' : ''}
      </button>
      <div className="min-w-0 flex-1">
        <div className={`truncate ${done ? 'text-faint line-through' : ''}`}>{task.title}</div>
        <div className="flex gap-2 text-xs text-faint">
          {task.kind !== 'todo' && <span>{KIND_LABEL[task.kind]}</span>}
          {task.sourceId && (
            <Link to="/sources/$id" params={{ id: task.sourceId }} className="truncate hover:text-accent">
              {task.sourceTitle}
            </Link>
          )}
        </div>
      </div>
      {task.priority <= 2 && <Badge tone={task.priority === 1 ? 'danger' : 'warn'}>P{task.priority}</Badge>}
      {task.dueDate && <span className={`shrink-0 text-xs ${overdue ? 'text-danger' : 'text-faint'}`}>{task.dueDate === today() ? 'today' : shortDate(task.dueDate)}</span>}
    </div>
  );
}
