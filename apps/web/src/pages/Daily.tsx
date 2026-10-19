import { useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { Note } from '@loom/core/types';
import { api } from '../lib/api';

/** /daily[?date=YYYY-MM-DD]: open (creating if needed) the daily note for that date. */
export function DailyPage() {
  const navigate = useNavigate();
  const { date } = useSearch({ strict: false }) as { date?: string };
  useEffect(() => {
    api.post<Note>('/notes/daily', date ? { date } : {}).then((n) =>
      navigate({ to: '/notes/$id', params: { id: n.id }, search: { edit: true } as any, replace: true }),
    );
  }, [date]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="text-faint">Opening daily note…</div>;
}

/** Daily notes are titled by their date; returns that date, or null for other notes. */
export function dailyDateOf(n: Pick<Note, 'title' | 'sourceId'>): string | null {
  return !n.sourceId && /^\d{4}-\d{2}-\d{2}$/.test(n.title) ? n.title : null;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
