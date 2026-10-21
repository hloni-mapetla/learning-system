import { useState } from 'react';
import { FIRST_STEP_PROMPT, startabilityHint, type Subtask, type Task } from '@loom/core/types';
import { api, useAction } from '../lib/api';
import { AuthorBadge } from './RecallBox';

/** "3/7" with a slim bar. Renders nothing for tasks without steps. */
export function StepProgress({ done, total, className = '' }: { done: number; total: number; className?: string }) {
  if (!total) return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 ${className}`} title={`${done} of ${total} steps done`}>
      <span className="h-1 w-12 overflow-hidden rounded-full bg-sunken">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${(done / total) * 100}%` }} />
      </span>
      <span className="font-mono text-[11px] text-faint tabular-nums">{done}/{total}</span>
    </span>
  );
}

/** Soft startability nudge under a step input. Never blocks saving. */
function Hint({ text }: { text: string }) {
  const hint = startabilityHint(text);
  return hint ? <p className="mt-1 text-[11px] text-warn">{hint}</p> : null;
}

/** Type a step and press ↵ to add it; focus stays so the next one can follow. */
export function StepInput({ task, first = false, onAdded }: { task: Task; first?: boolean; onAdded?: () => void }) {
  const [text, setText] = useState('');
  const add = useAction((title: string) => api.post(`/tasks/${task.id}/subtasks`, { title }));
  return (
    <div className="min-w-0 flex-1">
      <input
        id={`step-input-${task.id}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
          if (e.key === 'Enter' && text.trim()) {
            e.preventDefault();
            await add.mutateAsync(text.trim());
            setText('');
            onAdded?.();
          }
        }}
        placeholder={first ? `${FIRST_STEP_PROMPT} (↵ to save)` : 'Add a step… (↵ to add, esc to stop)'}
        className="h-8 w-full rounded-md border border-dashed border-line bg-transparent px-2.5 text-sm text-ink placeholder:text-faint focus:border-solid focus:border-accent focus:bg-panel focus:outline-none"
      />
      <Hint text={text} />
    </div>
  );
}

/** A task's steps, in order, with a selection cursor for the keyboard. */
export function TaskSteps({
  task,
  selectedId,
  editingId,
  onEdited,
  rowIndex,
}: {
  task: Task;
  selectedId: string | null;
  editingId: string | null;
  onEdited: () => void;
  /** data-row index of the first step (for scroll-into-view). */
  rowIndex: number;
}) {
  const toggle = useAction((s: Subtask) => api.post(`/subtasks/${s.id}/complete`, { undo: s.done }));
  return (
    <div className="mt-2 ml-8 space-y-0.5">
      {task.subtasks.map((s, i) => (
        <div
          key={s.id}
          data-row={rowIndex + i}
          className={`flex items-start gap-2 rounded-md px-2 py-1 ${s.id === selectedId ? 'bg-accent-soft ring-1 ring-accent' : ''}`}
        >
          <button
            onClick={() => toggle.mutate(s)}
            aria-label={s.done ? 'Mark step not done' : 'Complete step'}
            className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px] ${s.done ? 'border-accent bg-accent text-accent-ink' : 'border-line hover:border-accent'}`}
          >
            {s.done ? '✓' : ''}
          </button>
          {s.id === editingId ? (
            <StepEdit step={s} onDone={onEdited} />
          ) : (
            <span className={`flex-1 text-sm ${s.done ? 'text-faint line-through' : s.id === task.nextAction?.id ? 'font-medium' : ''}`}>
              {s.title} <AuthorBadge by={s.createdBy} />
            </span>
          )}
        </div>
      ))}
      <div className="flex px-2 pt-1">
        <StepInput task={task} />
      </div>
    </div>
  );
}

function StepEdit({ step, onDone }: { step: Subtask; onDone: () => void }) {
  const [text, setText] = useState(step.title);
  const save = useAction((title: string) => api.patch(`/subtasks/${step.id}`, { title }));
  return (
    <div className="flex-1">
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={onDone}
        onKeyDown={async (e) => {
          if (e.key === 'Escape') onDone();
          if (e.key === 'Enter' && text.trim()) {
            e.preventDefault();
            if (text.trim() !== step.title) await save.mutateAsync(text.trim());
            onDone();
          }
        }}
        className="h-7 w-full rounded border border-accent bg-panel px-2 text-sm focus:outline-none"
      />
      <Hint text={text} />
    </div>
  );
}
