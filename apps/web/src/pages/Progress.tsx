import { useEffect, useState } from 'react';
import { MINIMUM_KINDS, describeMinimum, type Chain, type ChainDay, type DailyMinimum, type Day, type DoneToday, type MomentumStats } from '@loom/core/types';
import { api, useAction, useApi } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { hm } from '../lib/format';
import { Kbd, PageHeader, Section, Select } from '../components/ui';
import { DoneList } from '../components/DoneList';
import { BarChart } from '../components/BarChart';

const dayLabel = (d: string) => String(Number(d.slice(8)));
const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

/** Eight weeks, Monday first. Met days are filled and ticked, so the chain doesn't rely on colour alone. */
function Calendar({ chain, selected, onSelect }: { chain: Chain; selected: string; onSelect: (d: string) => void }) {
  const first = chain.days[0];
  const lead = (new Date(`${first.date}T12:00:00`).getDay() + 6) % 7;
  const cells: (ChainDay | null)[] = [...Array(lead).fill(null), ...chain.days];
  const today = chain.days.at(-1)!.date;
  return (
    <div>
      <div className="grid grid-cols-7 gap-1.5 text-center text-[10px] text-faint">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i}>{d}</div>)}
        {cells.map((c, i) =>
          c ? (
            <button
              key={c.date}
              onClick={() => onSelect(c.date)}
              title={`${longDate(c.date)}: ${c.met ? 'minimum met' : c.date === today ? 'not yet' : 'not met'} · ${c.measure.sessions} sessions, ${c.measure.focusMinutes} min, ${c.measure.steps} steps${c.rating ? ` · rated ${c.rating}/5` : ''}`}
              className={`relative grid aspect-square place-items-center rounded-md text-[11px] tabular-nums ${
                c.met ? 'bg-accent text-accent-ink' : 'border border-line bg-sunken text-faint'
              } ${c.date === selected ? 'ring-2 ring-ink ring-offset-2 ring-offset-bg' : c.date === today ? 'ring-1 ring-accent' : ''}`}
            >
              {c.met ? '✓' : dayLabel(c.date)}
            </button>
          ) : (
            <div key={`x${i}`} />
          ),
        )}
      </div>
      <div className="mt-2 flex gap-4 text-[11px] text-faint">
        <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm bg-accent" /> minimum met</span>
        <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm border border-line bg-sunken" /> not met</span>
      </div>
    </div>
  );
}

function MinimumEditor({ rule }: { rule: DailyMinimum }) {
  const save = useAction((r: DailyMinimum) => api.put('/momentum/minimum', r));
  const presets: Record<string, number[]> = { sessions: [1, 2, 3], focus_minutes: [5, 10, 15, 25, 45, 90], steps: [1, 2, 3, 5] };
  const label = { sessions: 'sessions started', focus_minutes: 'minutes of focus', steps: 'steps (done or defined)' };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
      Minimum:
      <Select value={rule.value} onChange={(e) => save.mutate({ ...rule, value: Number(e.target.value) })}>
        {[...new Set([...presets[rule.kind], rule.value])].sort((a, b) => a - b).map((v) => <option key={v} value={v}>{v}</option>)}
      </Select>
      <Select value={rule.kind} onChange={(e) => save.mutate({ kind: e.target.value as DailyMinimum['kind'], value: presets[e.target.value][0] })}>
        {MINIMUM_KINDS.map((k) => <option key={k} value={k}>{label[k]}</option>)}
      </Select>
      <span className="text-xs text-faint">Keep it low enough for a bad day. Changing it doesn't rewrite past days.</span>
    </div>
  );
}

/** One day: when it started, what got done, and how it went. 1–5 rates it; r writes the line. */
function DayPanel({ date }: { date: string }) {
  const day = useApi<Day>(`/days/${date}`);
  const done = useApi<DoneToday>(`/done?date=${date}`);
  const [note, setNote] = useState('');
  useEffect(() => setNote(day.data?.reflection ?? ''), [day.data?.reflection, date]);
  const rate = useAction((b: { rating: number; note: string }) => api.put(`/days/${date}/rating`, b));
  const d = day.data;
  useHotkeys(
    {
      ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [String(n), () => rate.mutate({ rating: n, note })])),
      r: () => document.getElementById('reflection-input')?.focus(),
    },
    [date, note],
  );
  if (!d) return null;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{longDate(date)}</h2>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        <span>Woke {d.wakeAt ? <b className="text-ink">{hm(d.wakeAt)}</b> : '—'}</span>
        <span>Started work {d.workStartAt ? <b className="text-ink">{hm(d.workStartAt)}</b> : '—'}</span>
        {d.wakeToWorkMinutes !== null && <span>{minutes(d.wakeToWorkMinutes)} between</span>}
        {d.firstThing && <span className="min-w-0 truncate">First thing: {d.firstThing.task.title}</span>}
      </div>
      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">Done</div>
        <DoneList done={done.data} empty="Nothing logged." />
      </div>
      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">How was the day?</div>
        <div className="mb-3 flex gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => rate.mutate({ rating: n, note })}
              className={`size-9 rounded-md border text-sm font-medium tabular-nums ${d.rating === n ? 'border-accent bg-accent text-accent-ink' : 'border-line hover:border-accent'}`}
            >
              {n}
            </button>
          ))}
          <span className="ml-2 self-center text-xs text-faint">1 rough · 5 great · keys <Kbd>1</Kbd>–<Kbd>5</Kbd></span>
        </div>
        <input
          id="reflection-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
            if (e.key === 'Enter' && d.rating) {
              rate.mutate({ rating: d.rating, note });
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder={d.rating ? 'One line about the day (↵ to save)' : 'Rate the day first, then one line (r)'}
          className="h-9 w-full rounded-md border border-line bg-sunken px-3 text-sm focus:border-accent focus:outline-none"
        />
        {d.rating && <p className="mt-2 text-[11px] text-faint">Saved to the day's daily note under Reflection.</p>}
      </div>
    </div>
  );
}

function Stats({ days }: { days: number }) {
  const { data: s } = useApi<MomentumStats>(`/momentum/stats?days=${days}`);
  if (!s) return null;
  const total = s.perDay.reduce((a, d) => a + d.focusMinutes, 0);
  const withFocus = s.perDay.filter((d) => d.focusMinutes > 0).length;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Time in sessions" value={minutes(total)} sub={`${withFocus} of ${s.days} days had some`} />
        <Tile label="Minimum met" value={`${s.daysMet}/${s.days}`} sub="days" />
        <Tile label="Starters that kept going" value={pct(s.starters.keptGoing, s.starters.started)} sub={`${s.starters.keptGoing} of ${s.starters.started} starters became full blocks`} />
        <Tile label="Blocks run to the end" value={pct(s.blocks.completed, s.blocks.started)} sub={`${s.blocks.completed} of ${s.blocks.started} · ${s.blocks.stopped} stopped early`} />
        <Tile
          label="Wake to work (median)"
          value={s.wakeToWork.median === null ? '—' : minutes(s.wakeToWork.median)}
          sub={s.wakeToWork.n ? `n = ${s.wakeToWork.n} days · range ${minutes(s.wakeToWork.min!)}–${minutes(s.wakeToWork.max!)}` : 'log wake times to see this'}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-panel p-4">
          <BarChart
            title="Minutes in sessions per day"
            unit=" min"
            bars={s.perDay.map((d) => ({ key: d.date, label: dayLabel(d.date), value: d.focusMinutes, detail: `${d.sessions} sessions${d.met ? ' · minimum met' : ''}` }))}
          />
        </div>
        <div className="rounded-lg border border-line bg-panel p-4">
          <div className="mb-2 text-sm font-medium">Per week</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-faint uppercase">
                <th className="pb-2 font-medium">Week of</th>
                <th className="pb-2 text-right font-medium">Time in sessions</th>
                <th className="pb-2 text-right font-medium">Days with some</th>
              </tr>
            </thead>
            <tbody>
              {s.perWeek.map((w) => (
                <tr key={w.weekStart} className="border-t border-line">
                  <td className="py-1.5 text-muted">{new Date(`${w.weekStart}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
                  <td className="py-1.5 text-right tabular-nums">{minutes(w.focusMinutes)}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted">{w.daysWithFocus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="mb-1 text-sm font-medium">Day rating by when work started</div>
        <p className="mb-3 text-xs text-faint">
          {s.ratedDays} rated days. A pattern in your own data, not a cause; with only a few days per row, one day moves the average a lot.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-faint uppercase">
              <th className="pb-2 font-medium">First session</th>
              <th className="pb-2 text-right font-medium">Average rating</th>
              <th className="pb-2 text-right font-medium">Days (n)</th>
            </tr>
          </thead>
          <tbody>
            {s.ratingByStart.map((r) => (
              <tr key={r.bucket} className="border-t border-line">
                <td className="py-1.5 text-muted">{r.bucket}</td>
                <td className="py-1.5 text-right tabular-nums">{r.avgRating === null ? '—' : r.avgRating.toFixed(1)}</td>
                <td className="py-1.5 text-right tabular-nums text-muted">{r.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The chain, a day at a time, and patterns over weeks. */
export function ProgressPage() {
  const chain = useApi<Chain>('/momentum/chain?days=56');
  const [selected, setSelected] = useState<string | null>(null);
  const [span, setSpan] = useState(28);
  const c = chain.data;
  const dates = c?.days.map((d) => d.date) ?? [];
  const sel = selected ?? dates.at(-1) ?? null;
  const step = (n: number) => {
    const i = dates.indexOf(sel ?? '');
    const j = Math.max(0, Math.min(dates.length - 1, i + n));
    if (dates[j]) setSelected(dates[j]);
  };
  useHotkeys({ '[': () => step(-1), ']': () => step(1), ArrowLeft: () => step(-1), ArrowRight: () => step(1) }, [sel, dates.length]);
  if (!c || !sel) return null;

  return (
    <div>
      <PageHeader
        title="Progress"
        subtitle={
          c.current
            ? `${c.current} day${c.current === 1 ? '' : 's'} in a row meeting your minimum${c.todayMet ? ', today included' : '; today is still open'}.`
            : c.todayMet
              ? 'Minimum met today.'
              : 'Today is open. The minimum is small on purpose.'
        }
      />
      <div className="mb-10 grid gap-8 lg:grid-cols-[300px_1fr]">
        <div className="space-y-4">
          <Calendar chain={c} selected={sel} onSelect={setSelected} />
          <p className="text-sm text-muted">{describeMinimum(c.minimum)} a day.</p>
          <MinimumEditor rule={c.minimum} />
          <p className="text-xs text-faint"><Kbd>[</Kbd> <Kbd>]</Kbd> previous / next day</p>
        </div>
        <DayPanel date={sel} />
      </div>
      <Section
        title="Patterns"
        actions={
          <Select value={span} onChange={(e) => setSpan(Number(e.target.value))}>
            {[7, 28, 90].map((n) => <option key={n} value={n}>last {n} days</option>)}
          </Select>
        }
      >
        <Stats days={span} />
      </Section>
    </div>
  );
}
