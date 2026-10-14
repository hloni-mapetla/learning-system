import { useState } from 'react';

export interface Bar {
  key: string;
  label: string; // axis label (short)
  value: number;
  detail?: string; // tooltip extra line
}

/** Single-series bar chart: one hue, thin bars with rounded tops, recessive axis, hover tooltip, table fallback. */
export function BarChart({ bars, height = 140, unit = '', title }: { bars: Bar[]; height?: number; unit?: string; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...bars.map((b) => b.value));
  const W = 600;
  const pad = { l: 28, r: 4, t: 8, b: 20 };
  const iw = W - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const slot = iw / bars.length;
  const bw = Math.max(2, Math.min(18, slot - 2));
  const ticks = [0, Math.ceil(max / 2), max];
  const labelEvery = Math.ceil(bars.length / 8);

  return (
    <figure className="m-0">
      <div className="mb-2 flex items-baseline justify-between">
        <figcaption className="text-sm font-medium">{title}</figcaption>
        <button className="text-[11px] text-faint hover:text-muted" onClick={() => setTable(!table)}>{table ? 'chart' : 'table'}</button>
      </div>
      {table ? (
        <div className="max-h-48 overflow-y-auto text-xs">
          <table className="w-full">
            <tbody>
              {bars.map((b) => (
                <tr key={b.key} className="border-b border-line">
                  <td className="py-1 text-muted">{b.key}</td>
                  <td className="py-1 text-right tabular-nums">{b.value}{unit}</td>
                  <td className="py-1 pl-3 text-faint">{b.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${height}`} className="block w-full" role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => {
              const y = pad.t + ih - (t / max) * ih;
              return (
                <g key={t}>
                  <line x1={pad.l} x2={W - pad.r} y1={y} y2={y} stroke="var(--line)" strokeWidth={1} />
                  <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize={10} fill="var(--faint)">{t}</text>
                </g>
              );
            })}
            {bars.map((b, i) => {
              const h = (b.value / max) * ih;
              const x = pad.l + i * slot + (slot - bw) / 2;
              const y = pad.t + ih - h;
              const r = Math.min(4, bw / 2, h);
              return (
                <g key={b.key} onMouseEnter={() => setHover(i)}>
                  <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} fill="transparent" />
                  {b.value > 0 && (
                    <path
                      d={`M${x},${pad.t + ih} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${pad.t + ih} Z`}
                      fill="var(--accent)"
                      opacity={hover === null || hover === i ? 1 : 0.45}
                    />
                  )}
                  {i % labelEvery === 0 && (
                    <text x={pad.l + i * slot + slot / 2} y={height - 5} textAnchor="middle" fontSize={10} fill="var(--faint)">{b.label}</text>
                  )}
                </g>
              );
            })}
          </svg>
          {hover !== null && (
            <div
              className={`pointer-events-none absolute top-0 z-10 rounded-md border border-line bg-panel px-2 py-1 text-xs whitespace-nowrap shadow ${
                hover > bars.length * 0.75 ? '-translate-x-full' : hover < bars.length * 0.25 ? '' : '-translate-x-1/2'
              }`}
              style={{ left: `${((pad.l + hover * slot + slot / 2) / W) * 100}%` }}
            >
              <div className="text-muted">{bars[hover].key}</div>
              <div className="font-medium tabular-nums">{bars[hover].value}{unit}</div>
              {bars[hover].detail && <div className="text-faint">{bars[hover].detail}</div>}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
