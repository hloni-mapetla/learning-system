export function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  const diff = d - Date.now();
  const abs = Math.abs(diff);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60_000, 'second'],
    [3_600_000, 'minute'],
    [86_400_000, 'hour'],
    [30 * 86_400_000, 'day'],
    [365 * 86_400_000, 'month'],
    [Infinity, 'year'],
  ];
  const div: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000 };
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [limit, unit] of units) if (abs < limit) return rtf.format(Math.round(diff / div[unit]), unit);
  return '';
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso.length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Escape HTML then turn **x** search highlights into <mark>. */
export function snippetHtml(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*(.+?)\*\*/g, '<mark>$1</mark>');
}

/** Local "HH:MM" for a timestamp. */
export function hm(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
