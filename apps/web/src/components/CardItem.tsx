import { Link } from '@tanstack/react-router';
import type { CardView } from '@loom/core/types';
import { relTime } from '../lib/format';
import { Badge } from './ui';
import { Markdown } from './Markdown';

export const STATE_TONE = { new: 'accent', learning: 'warn', relearning: 'danger', review: 'default' } as const;

export function CardItem({ card, compact, selected }: { card: CardView; compact?: boolean; selected?: boolean }) {
  return (
    <div className={`rounded-lg border bg-panel px-4 py-3 ${selected ? 'border-accent' : 'border-line'}`}>
      <div className="mb-1 flex items-center gap-2 text-xs text-faint">
        <Badge>{card.type}</Badge>
        <Badge tone={STATE_TONE[card.state]}>{card.state}</Badge>
        {card.suspended && <Badge tone="warn">suspended</Badge>}
        {card.createdBy === 'claude' && <span>by Claude</span>}
        <span className="ml-auto">{card.state === 'new' ? 'new' : `due ${relTime(card.due)}`}</span>
      </div>
      <Markdown text={card.prompt} className="!text-base" />
      {!compact && card.answer && (
        <div className="mt-2 border-t border-line pt-2 text-sm text-muted">
          <Markdown text={card.answer} className="!text-sm" />
        </div>
      )}
      {!compact && card.refs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {card.refs.map((r) => (
            <Link key={`${r.type}:${r.id}`} to={r.type === 'note' ? '/notes/$id' : '/sources/$id'} params={{ id: r.id }} className="text-accent hover:underline">
              {r.title}
              {r.type === 'note' && r.sourceTitle ? <span className="text-faint"> · {r.sourceTitle}</span> : null}
            </Link>
          ))}
        </div>
      )}
      {!compact && card.retrievability !== null && (
        <div className="mt-1 text-[11px] text-faint">
          recall now ≈ {Math.round(card.retrievability * 100)}% · stability {card.stability.toFixed(1)} d · {card.reps} reviews · {card.lapses} lapses
        </div>
      )}
    </div>
  );
}
