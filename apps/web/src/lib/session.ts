import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { Session, SessionState } from '@loom/core/types';
import { api, queryClient, useApi } from './api';

export function useSessionState() {
  return useApi<SessionState>('/sessions/state', { refetchInterval: 15_000 });
}

/** Re-render every `ms` (for countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.round(Math.abs(ms) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Ask for notification permission (must run from a click or key press). */
export function askToNotify(): void {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

/** A system notification when permitted, plus an in-page signal: a short chime and a flashing tab title. */
export function signal(title: string, body: string): void {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(title, { body, tag: 'loom-session' });
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }
  try {
    const ctx = new AudioContext();
    for (const [i, f] of [660, 880].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.25);
      g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + i * 0.25 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.25 + 0.4);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.25);
      o.stop(ctx.currentTime + i * 0.25 + 0.45);
    }
  } catch {
    /* audio blocked until the page has had a user gesture */
  }
  const original = document.title;
  let n = 0;
  const t = setInterval(() => {
    document.title = n++ % 2 ? original : `● ${title}`;
    if (n > 10 || document.hasFocus()) {
      clearInterval(t);
      document.title = original;
    }
  }, 1000);
}

/** Start a starter session or focus block and open the focus view. */
export function useStartSession() {
  const navigate = useNavigate();
  return async (kind: 'starter' | 'focus', target: { taskId?: string | null; subtaskId?: string | null } = {}) => {
    askToNotify();
    try {
      await api.post<Session>('/sessions', { kind, ...target });
    } catch (e) {
      // Already running: just show it.
      if (!/already running/.test((e as Error).message)) throw e;
    }
    await queryClient.invalidateQueries();
    navigate({ to: '/focus' });
  };
}

/**
 * Watches the timer from any page: when a focus block runs out it's recorded as completed (starting the break),
 * and starters, blocks and breaks that end are announced once.
 */
export function useSessionAlarms(state: SessionState | undefined, now: number): void {
  const announced = useRef(new Set<string>());
  const run = state?.running;
  const brk = state?.onBreak;
  useEffect(() => {
    if (run && now >= Date.parse(run.endsAt) && !announced.current.has(run.id)) {
      announced.current.add(run.id);
      if (run.kind === 'focus') {
        api.post(`/sessions/${run.id}/end`).catch(() => {}).finally(() => queryClient.invalidateQueries());
        signal('Focus block done', `Take your ${run.breakMinutes}-minute break. Stand up, look away from the screen.`);
      } else {
        signal(`${run.plannedMinutes} minutes done`, 'Keep going? Stopping here counts.');
      }
    }
    if (brk && now >= Date.parse(brk.until) && !announced.current.has(`break:${brk.after.id}`)) {
      announced.current.add(`break:${brk.after.id}`);
      signal('Break over', 'Start another block when you are ready.');
      queryClient.invalidateQueries();
    }
  }, [run, brk, now]);
}
