import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { STARTER_QUESTION, type Session, type Subtask, type Task } from '@loom/core/types';
import type { Settings } from '@loom/core';
import { api, useAction, useApi } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { clock, useNow, useSessionState, useStartSession } from '../lib/session';
import { Button, Kbd } from '../components/ui';
import { StepInput, StepProgress } from '../components/TaskSteps';

/**
 * The focus view: only the current task, its next action, the timer and the remaining steps.
 * Esc hides it; the session keeps running (the sidebar shows the timer).
 */
export function FocusPage() {
  const navigate = useNavigate();
  const state = useSessionState();
  const now = useNow(1000);
  const run = state.data?.running ?? null;
  const brk = state.data?.onBreak ?? null;
  const shown = run ?? brk?.after ?? null;
  const task = useApi<Task>(shown?.taskId ? `/tasks/${shown.taskId}` : null);
  const start = useStartSession();
  const [parking, setParking] = useState(false);
  const [parked, setParked] = useState<string | null>(null);
  const [ended, setEnded] = useState<Session | null>(null);

  const end = useAction(async (b: { id: string; outcome?: 'abandoned' }) => {
    const r = await api.post<Session>(`/sessions/${b.id}/end`, b.outcome ? { outcome: b.outcome } : {});
    setEnded(r.outcome === 'abandoned' ? null : r);
    return r;
  });
  const keepGoing = useAction((id: string) => api.post(`/sessions/${id}/keep-going`));
  const tick = useAction((s: Subtask) => api.post(`/subtasks/${s.id}/complete`, { undo: s.done }));

  const leave = () => navigate({ to: '/today' });
  const t = task.data;
  // The step in hand: the session's step while it's open, else the task's next action.
  const current = t?.subtasks.find((s) => s.id === run?.subtaskId && !s.done) ?? t?.nextAction ?? null;
  const remaining = t?.subtasks.filter((s) => !s.done && s.id !== current?.id) ?? [];
  const left = run ? Date.parse(run.endsAt) - now : 0;
  const timeUp = !!run && left <= 0;
  const breakLeft = brk ? Date.parse(brk.until) - now : 0;

  useHotkeys(
    {
      Escape: () => (parking ? setParking(false) : leave()),
      p: () => run && setParking(true),
      x: () => current && tick.mutate(current),
      s: () => run && end.mutate({ id: run.id }),
      Enter: () => run && timeUp && run.kind === 'starter' && keepGoing.mutate(run.id),
      f: () => !run && start('focus', { taskId: (shown ?? ended)?.taskId, subtaskId: t?.nextAction?.id }),
      n: () => document.getElementById(`step-input-${t?.id}`)?.focus(),
    },
    [run, current, parking, timeUp, shown, t, ended],
  );

  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center overflow-y-auto bg-bg px-4 py-10">
      <button onClick={leave} className="fixed top-4 right-4 text-xs text-faint hover:text-ink">
        hide <Kbd>esc</Kbd>
      </button>
      <div className="w-full max-w-xl">
        {!shown && ended && <Ended s={ended} onLeave={leave} onNext={() => start('focus', { taskId: ended.taskId })} />}
        {!shown && !ended && <Idle onLeave={leave} />}

        {shown && (
          <>
            <div className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">
              {brk ? 'Break' : run!.kind === 'starter' ? `Just ${run!.plannedMinutes} minutes` : 'Focus block'}
            </div>
            <div className="mb-1 flex items-center gap-3">
              <h1 className="min-w-0 flex-1 truncate text-lg text-muted">{t?.title ?? shown.taskTitle ?? 'Untitled session'}</h1>
              {t && <StepProgress done={t.progress.done} total={t.progress.total} />}
            </div>

            {/* Timer */}
            <div className={`my-8 text-center font-mono text-7xl font-semibold tabular-nums ${timeUp ? 'text-accent' : brk ? 'text-muted' : ''}`}>
              {brk ? clock(breakLeft) : timeUp ? `+${clock(-left)}` : clock(left)}
            </div>

            {run && timeUp && run.kind === 'starter' && (
              <div className="mb-8 rounded-lg border border-accent bg-panel p-4 text-center">
                <div className="mb-3 font-medium">{run.plannedMinutes} minutes done. {STARTER_QUESTION}</div>
                <div className="flex justify-center gap-2">
                  <Button variant="primary" onClick={() => keepGoing.mutate(run.id)}>Keep going <Kbd>↵</Kbd></Button>
                  <Button onClick={() => end.mutate({ id: run.id })}>Stop here, that counts <Kbd>s</Kbd></Button>
                </div>
              </div>
            )}

            {brk && <BreakCard brk={brk.after} over={breakLeft <= 0} onNext={() => start('focus', { taskId: shown.taskId, subtaskId: t?.nextAction?.id })} />}

            {/* The step in hand */}
            {!brk && (
              current ? (
                <div className="mb-6 rounded-lg border border-line bg-panel p-5">
                  <div className="mb-1 text-xs text-faint">Now</div>
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => tick.mutate(current)}
                      aria-label="Complete step"
                      className="mt-1 grid size-5 shrink-0 place-items-center rounded border-2 border-accent hover:bg-accent-soft"
                    />
                    <div className="text-2xl leading-snug font-medium">{current.title}</div>
                  </div>
                  <div className="mt-3 text-xs text-faint"><Kbd>x</Kbd> done, on to the next step</div>
                </div>
              ) : t && t.progress.total > 0 ? (
                <div className="mb-6 rounded-lg border border-accent bg-panel p-5 text-center">All steps done. Complete the task from Today when you're ready.</div>
              ) : t ? (
                <div className="mb-6 rounded-lg border border-dashed border-line p-5 text-sm text-muted">
                  <p className="mb-3">No steps on this task yet. Defining the first physical step is a fine use of this session.</p>
                  <StepInput task={t} first />
                </div>
              ) : null
            )}

            {!brk && remaining.length > 0 && (
              <ol className="mb-8 space-y-1 text-sm text-muted">
                {remaining.map((s) => (
                  <li key={s.id} className="flex gap-2"><span className="text-faint">·</span>{s.title}</li>
                ))}
              </ol>
            )}

            {parked && <div className="mb-3 text-center text-xs text-accent">Parked: “{parked}”. It's in today's daily note.</div>}
            {parking && <ParkBox onClose={() => setParking(false)} onParked={(x) => { setParked(x); setParking(false); }} />}

            {run && (
              <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-faint">
                <span><Kbd>p</Kbd> park a distracting thought</span>
                {!timeUp && <button onClick={() => end.mutate({ id: run.id })} className="hover:text-ink"><Kbd>s</Kbd> stop here (it counts)</button>}
                <button
                  onClick={() => confirm("Discard this session? It won't count.") && end.mutate({ id: run.id, outcome: 'abandoned' })}
                  className="hover:text-danger"
                >
                  discard
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Right after stopping: say it counted, and offer (never push) a focus block. */
function Ended({ s, onLeave, onNext }: { s: Session; onLeave: () => void; onNext: () => void }) {
  const mins = Math.max(1, Math.round(s.actualMinutes ?? 0));
  return (
    <div className="space-y-4 text-center">
      <div className="text-xs font-semibold tracking-wide text-faint uppercase">{s.kind === 'starter' ? 'Starter' : 'Focus block'} logged</div>
      <h1 className="text-2xl font-semibold">{mins} minute{mins === 1 ? '' : 's'}{s.taskTitle ? ` on ${s.taskTitle}` : ''}. That counts.</h1>
      {s.subtasksCompleted.length > 0 && (
        <p className="text-sm text-muted">Done: {s.subtasksCompleted.map((x) => x.title).join(' · ')}</p>
      )}
      <div className="flex justify-center gap-2 pt-2">
        <Button variant="primary" onClick={onLeave}>Back to Today <Kbd>esc</Kbd></Button>
        <Button onClick={onNext}>Start a focus block <Kbd>f</Kbd></Button>
      </div>
    </div>
  );
}

function BreakCard({ brk, over, onNext }: { brk: Session; over: boolean; onNext: () => void }) {
  return (
    <div className="mb-8 rounded-lg border border-line bg-panel p-5 text-center">
      <div className="mb-1 font-medium">{over ? "Break's over." : `Focus block done: ${Math.round(brk.actualMinutes ?? brk.plannedMinutes)} minutes.`}</div>
      <p className="mb-4 text-sm text-muted">
        {over ? 'Another block only if you want one.' : 'A real break: stand up, get water, look out of a window. Not your phone.'}
        {brk.subtasksCompleted.length > 0 && ` You finished ${brk.subtasksCompleted.length} step${brk.subtasksCompleted.length === 1 ? '' : 's'}.`}
      </p>
      <Button variant={over ? 'primary' : 'default'} onClick={onNext}>Start the next block <Kbd>f</Kbd></Button>
    </div>
  );
}

function ParkBox({ onClose, onParked }: { onClose: () => void; onParked: (text: string) => void }) {
  const [text, setText] = useState('');
  const park = useAction((t: string) => api.post('/park', { text: t }));
  return (
    <form
      className="mb-4 rounded-lg border border-accent bg-panel p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        await park.mutateAsync(text.trim());
        onParked(text.trim());
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        placeholder="Park it for later (↵ save, esc cancel): check that email, look up X…"
        className="h-9 w-full bg-transparent text-sm focus:outline-none"
      />
    </form>
  );
}

/** No session running: explain, and let the lengths be changed. */
function Idle({ onLeave }: { onLeave: () => void }) {
  const settings = useApi<Settings>('/settings');
  const save = useAction((b: Partial<Settings>) => api.patch('/settings', b));
  const s = settings.data;
  const field = (key: 'starterMinutes' | 'focusMinutes' | 'breakMinutes', label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-28 text-muted">{label}</span>
      <input
        type="number"
        min={key === 'breakMinutes' ? 0 : 1}
        defaultValue={s?.[key]}
        key={s?.[key]}
        onBlur={(e) => Number(e.target.value) !== s?.[key] && save.mutate({ [key]: Number(e.target.value) })}
        className="h-8 w-20 rounded-md border border-line bg-panel px-2 text-right tabular-nums"
      />
      <span className="text-faint">min</span>
    </label>
  );
  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-2 text-lg font-semibold">Nothing running</h1>
        <p className="text-sm text-muted">
          On Today, select a task or step and press <Kbd>t</Kbd> for “just {s?.starterMinutes ?? 10} minutes”, or <Kbd>f</Kbd> for a focus block.
          Starting is the hard part; stopping after the starter still counts.
        </p>
      </div>
      {s && (
        <div className="space-y-2 rounded-lg border border-line bg-panel p-4">
          {field('starterMinutes', 'Starter')}
          {field('focusMinutes', 'Focus block')}
          {field('breakMinutes', 'Break')}
        </div>
      )}
      <Button onClick={onLeave}>Back to Today <Kbd>esc</Kbd></Button>
    </div>
  );
}
