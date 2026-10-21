import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { PLAN_STEP_PROMPT, startabilityHint, type Day, type DoneToday, type Task } from '@loom/core/types';
import { api, useAction, useApi } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { hm } from '../lib/format';
import { Button, Input, Kbd } from '../components/ui';
import { DoneList, doneCount } from '../components/DoneList';
import { StepProgress } from '../components/TaskSteps';

type Stage = 'review' | 'task' | 'step' | 'time' | 'shutdown' | 'done';

/**
 * Plan tomorrow, in the evening: look at what got done, pick ONE first task with a concrete first step, optionally a start
 * time, then shut down. With ?for=today it's the same choice made in the morning (no review, no shutdown).
 */
export function PlanPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { for?: string };
  const forToday = search.for === 'today';
  const target = forToday ? 'today' : 'tomorrow';
  const day = useApi<Day>(`/days/${target}`);
  const today = useApi<Day>('/days/today');
  const done = useApi<DoneToday>('/done-today');
  const open = useApi<Task[]>('/tasks?view=all_open');
  const tasks = (open.data ?? []).filter((t) => !t.virtual);

  const [stage, setStage] = useState<Stage>(forToday ? 'task' : 'review');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [stepSel, setStepSel] = useState(0);
  const [newTask, setNewTask] = useState(false);
  const [stepText, setStepText] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  // Start from the existing plan, if there is one.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !day.data || !open.data) return;
    seeded.current = true;
    const ft = day.data.firstThing;
    const i = ft ? tasks.findIndex((t) => t.id === ft.task.id) : -1;
    if (i >= 0) setSel(i);
    if (day.data.targetStart) setTime(day.data.targetStart);
  }, [day.data, open.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const task = tasks.find((t) => t.id === taskId) ?? null;
  const openSteps = task?.subtasks.filter((s) => !s.done) ?? [];
  // Step choices: the task's open steps, then "write a new one".
  const stepRows = openSteps.length + 1;

  const save = useAction((b: { taskId: string; subtaskId?: string | null; stepTitle?: string | null; targetStart?: string | null }) =>
    api.put<{ day: Day; hint: string | null }>(`/days/${target}/plan`, b),
  );
  const createTask = useAction((title: string) => api.post<Task>('/tasks', { title }));
  const shutdown = useAction((b: { note?: string }) => api.post<Day>(`/days/today/shutdown`, b));

  const pickTask = (t: Task) => {
    setTaskId(t.id);
    const planned = day.data?.firstThing?.task.id === t.id ? day.data.firstThing.step?.id : null;
    const open = t.subtasks.filter((s) => !s.done);
    setStepSel(Math.max(0, open.findIndex((s) => s.id === (planned ?? t.nextAction?.id))));
    setStepText('');
    setError(null);
    setStage('step');
  };
  const [choice, setChoice] = useState<{ subtaskId?: string; stepTitle?: string }>({});
  const chooseStep = (c: { subtaskId?: string; stepTitle?: string }) => {
    setChoice(c);
    const title = c.stepTitle ?? openSteps.find((s) => s.id === c.subtaskId)?.title ?? '';
    setHint(title ? startabilityHint(title) : null);
    setStage('time');
  };
  const finishPlan = async (at: string = time) => {
    if (!task) return;
    setError(null);
    setTime(at);
    try {
      const r = await save.mutateAsync({ taskId: task.id, ...choice, targetStart: at || null });
      setHint(r.hint);
      setStage(forToday ? 'done' : 'shutdown');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const back = () => {
    const order: Stage[] = forToday ? ['task', 'step', 'time'] : ['review', 'task', 'step', 'time', 'shutdown'];
    const i = order.indexOf(stage);
    if (i > 0) setStage(order[i - 1]);
  };
  const leave = () => navigate({ to: forToday ? '/morning' : '/today' });

  useHotkeys(
    {
      Escape: leave,
      ArrowLeft: back,
      h: back,
      Enter: () => {
        if (stage === 'review') setStage('task');
        else if (stage === 'task' && tasks[sel]) pickTask(tasks[sel]);
        else if (stage === 'step') {
          if (task?.singleStep && !openSteps.length) chooseStep({});
          else if (stepSel < openSteps.length) chooseStep({ subtaskId: openSteps[stepSel].id });
          else document.getElementById('plan-step-input')?.focus();
        } else if (stage === 'time') finishPlan();
        else if (stage === 'done') leave();
      },
      j: () => (stage === 'task' ? setSel((i) => Math.min(tasks.length - 1, i + 1)) : stage === 'step' && setStepSel((i) => Math.min(stepRows - 1, i + 1))),
      k: () => (stage === 'task' ? setSel((i) => Math.max(0, i - 1)) : stage === 'step' && setStepSel((i) => Math.max(0, i - 1))),
      ArrowDown: () => (stage === 'task' ? setSel((i) => Math.min(tasks.length - 1, i + 1)) : stage === 'step' && setStepSel((i) => Math.min(stepRows - 1, i + 1))),
      ArrowUp: () => (stage === 'task' ? setSel((i) => Math.max(0, i - 1)) : stage === 'step' && setStepSel((i) => Math.max(0, i - 1))),
      n: () => {
        if (stage === 'task') setNewTask(true);
        if (stage === 'step') {
          setStepSel(openSteps.length);
          setTimeout(() => document.getElementById('plan-step-input')?.focus(), 0);
        }
      },
      s: () => stage === 'time' && finishPlan(''),
    },
    [stage, sel, stepSel, tasks, task, openSteps, choice, time],
  );

  useEffect(() => {
    if (stage === 'step' && task && !openSteps.length && !task.singleStep) setTimeout(() => document.getElementById('plan-step-input')?.focus(), 0);
    if (stage === 'time') setTimeout(() => document.getElementById('plan-time')?.focus(), 0);
    if (stage === 'shutdown') setTimeout(() => document.getElementById('plan-note')?.focus(), 0);
  }, [stage, task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const stages: [Stage, string][] = forToday
    ? [['task', 'First task'], ['step', 'First step'], ['time', 'Start time']]
    : [['review', 'Today'], ['task', 'First task'], ['step', 'First step'], ['time', 'Start time'], ['shutdown', 'Shut down']];
  const plannedStep = choice.stepTitle ?? openSteps.find((s) => s.id === choice.subtaskId)?.title ?? null;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{forToday ? 'Pick the first thing for today' : 'Plan tomorrow'}</h1>
        <button onClick={leave} className="text-xs text-faint hover:text-ink">close <Kbd>esc</Kbd></button>
      </div>
      {stage !== 'done' && (
        <ol className="mb-8 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {stages.map(([s, label], i) => (
            <li key={s} className={s === stage ? 'font-semibold text-accent' : stages.findIndex(([x]) => x === stage) > i ? 'text-muted' : 'text-faint'}>
              {i + 1}. {label}
            </li>
          ))}
        </ol>
      )}

      {stage === 'review' && (
        <div className="space-y-4">
          <p className="text-muted">
            {doneCount(done.data) ? "Here's what got done today. All of it counts." : 'Nothing logged today, and that is fine. Tomorrow can start small.'}
          </p>
          <div className="rounded-lg border border-line bg-panel p-4"><DoneList done={done.data} empty="—" /></div>
          {day.data?.firstThing && (
            <p className="text-sm text-muted">Already planned: <b>{day.data.firstThing.task.title}</b>. You can change it.</p>
          )}
          <Button variant="primary" onClick={() => setStage('task')}>Next: pick tomorrow's first task <Kbd>↵</Kbd></Button>
        </div>
      )}

      {stage === 'task' && (
        <div className="space-y-3">
          <p className="text-muted">Pick <b>one</b> task to start {forToday ? 'with now' : 'tomorrow with'}. Just the first one; the rest of the list can wait.</p>
          {newTask && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const title = (new FormData(e.currentTarget).get('title') as string).trim();
                if (!title) return;
                const t = await createTask.mutateAsync(title);
                setNewTask(false);
                await open.refetch();
                pickTask(t);
              }}
            >
              <Input name="title" autoFocus placeholder="New task (↵ to add, esc to cancel)" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setNewTask(false))} />
            </form>
          )}
          <ul className="max-h-[55vh] space-y-1.5 overflow-y-auto">
            {tasks.map((t, i) => (
              <li key={t.id}>
                <button
                  onClick={() => pickTask(t)}
                  onMouseEnter={() => setSel(i)}
                  className={`w-full rounded-lg border px-3 py-2 text-left ${i === sel ? 'border-accent bg-accent-soft' : 'border-line bg-panel'}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.title}</span>
                    <StepProgress done={t.progress.done} total={t.progress.total} />
                    {day.data?.firstThing?.task.id === t.id && <span className="text-[11px] text-accent">planned</span>}
                  </div>
                  {t.nextAction && <div className="truncate text-xs text-muted">→ {t.nextAction.title}</div>}
                  {t.needsFirstStep && <div className="text-xs text-faint">needs a first step</div>}
                </button>
              </li>
            ))}
          </ul>
          {!tasks.length && <p className="text-sm text-faint">No open tasks. Press <Kbd>n</Kbd> to add one.</p>}
          <p className="text-xs text-faint"><Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>↵</Kbd> choose · <Kbd>n</Kbd> new task · <Kbd>←</Kbd> back</p>
        </div>
      )}

      {stage === 'step' && task && (
        <div className="space-y-3">
          <p className="text-muted"><b>{task.title}</b></p>
          {task.singleStep && !openSteps.length ? (
            <>
              <p className="text-sm text-muted">It's a single step; nothing to break down.</p>
              <Button variant="primary" onClick={() => chooseStep({})}>Next <Kbd>↵</Kbd></Button>
            </>
          ) : (
            <>
              <p className="font-medium">{PLAN_STEP_PROMPT}</p>
              {!!openSteps.length && (
                <ul className="space-y-1.5">
                  {openSteps.map((s, i) => (
                    <li key={s.id}>
                      <button
                        onClick={() => chooseStep({ subtaskId: s.id })}
                        onMouseEnter={() => setStepSel(i)}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${i === stepSel ? 'border-accent bg-accent-soft' : 'border-line bg-panel'}`}
                      >
                        {s.title}
                        {i === 0 && <span className="ml-2 text-[11px] text-faint">next action</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className={`rounded-lg border p-2 ${stepSel === openSteps.length ? 'border-accent' : 'border-dashed border-line'}`}>
                <input
                  id="plan-step-input"
                  value={stepText}
                  onFocus={() => setStepSel(openSteps.length)}
                  onChange={(e) => setStepText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Enter' && stepText.trim()) {
                      e.preventDefault();
                      chooseStep({ stepTitle: stepText.trim() });
                    }
                  }}
                  placeholder={openSteps.length ? 'Or write a new first step… (↵)' : 'e.g. "Open draft.docx and reread section 2.3" (↵)'}
                  className="h-8 w-full bg-transparent px-1 text-sm outline-none"
                />
                {startabilityHint(stepText) && stepText && <p className="px-1 text-[11px] text-warn">{startabilityHint(stepText)}</p>}
              </div>
              <p className="text-xs text-faint"><Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>↵</Kbd> choose · <Kbd>n</Kbd> write a new step · <Kbd>←</Kbd> back</p>
            </>
          )}
        </div>
      )}

      {stage === 'time' && task && (
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-panel p-4">
            <div className="text-sm font-medium">{task.title}</div>
            {plannedStep && <div className="text-sm text-muted">→ {plannedStep}</div>}
            {hint && <p className="mt-1 text-[11px] text-warn">{hint}</p>}
          </div>
          <label className="block">
            <span className="mb-1 block text-muted">Start at a set time? <span className="text-faint">(optional)</span></span>
            <input
              id="plan-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  finishPlan();
                }
                // The time box has focus here, so "no set time" is handled in it too.
                if (e.key === 's') {
                  e.preventDefault();
                  finishPlan('');
                }
                if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
              }}
              className="h-9 rounded-md border border-line bg-panel px-2 tabular-nums"
            />
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => finishPlan()}>Save plan <Kbd>↵</Kbd></Button>
            <Button onClick={() => finishPlan('')}>No set time <Kbd>s</Kbd></Button>
          </div>
        </div>
      )}

      {stage === 'shutdown' && (
        <div className="space-y-4">
          <p className="text-muted">Last step: shut down. Where did you leave off? One line for future you; it goes in today's daily note.</p>
          <Input
            id="plan-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
              if (e.key === 'Enter') {
                e.preventDefault();
                await shutdown.mutateAsync({ note });
                setStage('done');
              }
            }}
            placeholder="e.g. Halfway through 2.3; the Smith quote is next (optional, ↵)"
          />
          <Button variant="primary" onClick={async () => { await shutdown.mutateAsync({ note }); setStage('done'); }}>Shutdown complete <Kbd>↵</Kbd></Button>
        </div>
      )}

      {stage === 'done' && (
        <div className="space-y-4 text-center">
          <div className="text-xs font-semibold tracking-wide text-faint uppercase">{forToday ? 'Ready' : 'Shutdown complete'}</div>
          <h2 className="text-xl font-semibold">
            {forToday ? 'First thing' : 'Tomorrow starts with'}: {task?.title}
          </h2>
          {plannedStep && <p className="text-lg text-muted">→ {plannedStep}</p>}
          {time && <p className="text-sm text-muted">at {time}</p>}
          {!forToday && today.data?.shutdownAt && <p className="text-sm text-faint">Day closed at {hm(today.data.shutdownAt)}. Nothing else needs deciding tonight.</p>}
          <Button variant="primary" onClick={leave}>{forToday ? 'Back to the morning' : 'Done'} <Kbd>↵</Kbd></Button>
        </div>
      )}
    </div>
  );
}
