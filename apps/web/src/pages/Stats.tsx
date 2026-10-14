import { Link } from '@tanstack/react-router';
import type { MasteryRow, Settings, Stats } from '@loom/core';
import { api, useAction, useApi } from '../lib/api';
import { PageHeader, Section, Select } from '../components/ui';
import { BarChart } from '../components/BarChart';

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const dayLabel = (d: string) => String(Number(d.slice(8)));

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

function MasteryTable({ rows, link }: { rows: MasteryRow[]; link?: boolean }) {
  if (!rows.length) return <p className="text-sm text-faint">No cards yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] text-faint uppercase">
          <th className="pb-2 font-medium">Name</th>
          <th className="pb-2 font-medium">Mastery</th>
          <th className="pb-2 pl-3 text-right font-medium whitespace-nowrap">Ret. 90d</th>
          <th className="pb-2 pl-3 text-right font-medium whitespace-nowrap">Cards</th>
          <th className="pb-2 pl-3 text-right font-medium whitespace-nowrap">Due</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id ?? r.name} className="border-t border-line">
            <td className="py-2 pr-2">
              {link && r.id ? <Link to="/sources/$id" params={{ id: r.id }} className="hover:text-accent">{r.name}</Link> : `#${r.name}`}
            </td>
            <td className="w-40 py-2">
              <div className="flex items-center gap-2" title={`Mean probability of recall now: ${pct(r.mastery)}`}>
                <div className="h-1.5 flex-1 rounded-full bg-sunken">
                  <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.round(r.mastery * 100)}%` }} />
                </div>
                <span className="w-9 text-right text-xs tabular-nums text-muted">{pct(r.mastery)}</span>
              </div>
            </td>
            <td className="py-2 pl-3 text-right tabular-nums text-muted">{pct(r.retention)}</td>
            <td className="py-2 pl-3 text-right tabular-nums text-muted">{r.cards}</td>
            <td className="py-2 pl-3 text-right tabular-nums text-muted">{r.due}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StatsPage() {
  const { data: s } = useApi<Stats>('/stats');
  const settings = useApi<Settings>('/settings');
  const save = useAction((b: Partial<Settings>) => api.patch('/settings', b));
  if (!s) return null;
  const r30 = s.retention.find((r) => r.days === 30)!;
  const target = settings.data?.desiredRetention ?? 0.9;
  const total = Object.values(s.totals.cards).reduce((a, b) => a + b, 0);

  return (
    <div>
      <PageHeader title="Stats" subtitle="Retention counts review-phase answers (not learning steps) that weren't rated Again." />
      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Retention · 30 days" value={pct(r30.rate)} sub={`${r30.reviews} reviews · target ${pct(target)}`} />
        <Tile label="Retention · 7 days" value={pct(s.retention[0].rate)} sub={`${s.retention[0].reviews} reviews`} />
        <Tile label="Streak" value={`${s.streak} d`} sub={`${s.reviewedToday} reviewed today`} />
        <Tile label="Cards" value={String(total)} sub={`${s.totals.cards.review ?? 0} in review · ${s.totals.cards.new ?? 0} new`} />
        <Tile label="Due next 7 days" value={String(s.forecast.slice(0, 7).reduce((a, d) => a + d.count, 0))} sub={`${s.forecast[0]?.count ?? 0} today`} />
      </div>
      <div className="mb-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-panel p-4">
          <BarChart title="Reviews per day · last 30 days" bars={s.daily.map((d) => ({ key: d.date, label: dayLabel(d.date), value: d.reviews, detail: `${d.again} again · ${d.minutes} min` }))} />
        </div>
        <div className="rounded-lg border border-line bg-panel p-4">
          <BarChart title="Due forecast · next 30 days" bars={s.forecast.map((d) => ({ key: d.date, label: dayLabel(d.date), value: d.count }))} />
        </div>
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Weakest topics">
          <MasteryTable rows={s.topics.slice(0, 15)} />
        </Section>
        <Section title="Mastery by source">
          <MasteryTable rows={s.sources} link />
        </Section>
      </div>
      {settings.data && (
        <Section title="Scheduling">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2 text-muted">
              Target retention
              <Select value={settings.data.desiredRetention} onChange={(e) => save.mutate({ desiredRetention: Number(e.target.value) })}>
                {[0.8, 0.85, 0.88, 0.9, 0.92, 0.95, 0.97].map((v) => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}
              </Select>
            </label>
            <label className="flex items-center gap-2 text-muted">
              New cards per day
              <Select value={settings.data.newCardsPerDay} onChange={(e) => save.mutate({ newCardsPerDay: Number(e.target.value) })}>
                {[0, 5, 10, 15, 20, 30, 50, 100].map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </label>
            <span className="text-xs text-faint">Higher retention means more reviews. 90% is a good default.</span>
          </div>
        </Section>
      )}
    </div>
  );
}
