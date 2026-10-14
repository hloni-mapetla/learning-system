import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { CardView, RatingName } from '@loom/core/types';
import { api, qs, useApi } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { Badge, Button, Empty, Kbd, PageHeader, Select } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { STATE_TONE } from '../components/CardItem';

const RATING_BTNS: { r: RatingName; key: string; label: string; cls: string }[] = [
  { r: 'again', key: '1', label: 'Again', cls: 'text-again' },
  { r: 'hard', key: '2', label: 'Hard', cls: 'text-hard' },
  { r: 'good', key: '3', label: 'Good', cls: 'text-good' },
  { r: 'easy', key: '4', label: 'Easy', cls: 'text-easy' },
];

interface Counts {
  learning: number;
  review: number;
  new: number;
  total: number;
}

export function ReviewPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tag, setTag] = useState('');
  const [queue, setQueue] = useState<CardView[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [preview, setPreview] = useState<Record<RatingName, string> | null>(null);
  const [done, setDone] = useState<{ id: string; rating: RatingName }[]>([]);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(Date.now());
  const tags = useApi<{ name: string }[]>('/tags');
  const counts = useApi<Counts>(`/review/counts${qs({ tag })}`);

  const load = useCallback(async () => {
    const due = await api.get<CardView[]>(`/review/due${qs({ tag, limit: 200 })}`);
    setQueue(due);
    setIdx(0);
    setRevealed(false);
  }, [tag]);
  useEffect(() => {
    load();
  }, [load]);

  const card = queue?.[idx];
  useEffect(() => {
    setPreview(null);
    shownAt.current = Date.now();
    if (card) api.get<Record<RatingName, string>>(`/review/preview/${card.id}`).then(setPreview);
  }, [card?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rate = async (rating: RatingName) => {
    if (!card || !revealed || busy) return;
    setBusy(true);
    try {
      await api.post(`/review/${card.id}`, { rating, durationMs: Date.now() - shownAt.current });
      setDone((d) => [...d, { id: card.id, rating }]);
      setRevealed(false);
      if (idx + 1 < (queue?.length ?? 0)) setIdx(idx + 1);
      else await load(); // pick up learning steps that came due during the session
      qc.invalidateQueries();
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!done.length || busy) return;
    const last = done[done.length - 1];
    const restored = await api.post<CardView>('/review/undo', { cardId: last.id });
    setDone((d) => d.slice(0, -1));
    setQueue((q) => {
      const rest = (q ?? []).filter((c, i) => i >= idx && c.id !== restored.id);
      return [restored, ...rest];
    });
    setIdx(0);
    setRevealed(true);
    qc.invalidateQueries();
  };

  const suspend = async () => {
    if (!card) return;
    await api.patch(`/cards/${card.id}`, { suspended: true });
    setQueue((q) => (q ?? []).filter((c) => c.id !== card.id));
    setRevealed(false);
  };

  useHotkeys(
    {
      ' ': () => setRevealed(true),
      Enter: () => (revealed ? rate('good') : setRevealed(true)),
      '1': () => rate('again'),
      '2': () => rate('hard'),
      '3': () => rate('good'),
      '4': () => rate('easy'),
      u: undo,
      'mod+z': undo,
      '!': suspend,
      'shift+!': suspend,
      o: () => {
        const ref = card?.refs[0];
        if (ref) navigate({ to: ref.type === 'note' ? '/notes/$id' : '/sources/$id', params: { id: ref.id } });
      },
    },
    [card?.id, revealed, busy, done.length, idx, queue],
  );

  const remaining = queue ? queue.length - idx : 0;
  const tally = RATING_BTNS.map((b) => [b.label, done.filter((d) => d.rating === b.r).length] as const);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Review"
        subtitle={
          counts.data && (
            <>
              {counts.data.learning} learning · {counts.data.review} review · {counts.data.new} new due today
            </>
          )
        }
        actions={
          <Select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All topics</option>
            {tags.data?.map((t) => <option key={t.name} value={t.name}>#{t.name}</option>)}
          </Select>
        }
      />

      {queue && !card && (
        <Empty>
          <div className="mb-2 text-base text-ink">{done.length ? `Session done — ${done.length} reviewed.` : 'Nothing due right now.'}</div>
          {done.length > 0 && <div className="mb-3">{tally.map(([l, n]) => `${l} ${n}`).join(' · ')}</div>}
          <div>
            Prefer a conversation? Ask Claude for a <b>daily review</b> — it quizzes you on the same queue.
          </div>
        </Empty>
      )}

      {card && (
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-faint">
            <Badge>{card.type}</Badge>
            <Badge tone={STATE_TONE[card.state]}>{card.state}</Badge>
            <span className="ml-auto">{remaining} left · {done.length} done</span>
          </div>
          <div
            className="min-h-64 cursor-pointer rounded-xl border border-line bg-panel px-8 py-10"
            onClick={() => setRevealed(true)}
          >
            <Markdown text={card.prompt} className="text-xl" />
            {(card.type === 'open' || card.type === 'synthesis') && !revealed && (
              <p className="mt-6 text-sm text-faint">Answer out loud or on paper, then reveal and compare with the rubric.</p>
            )}
            {revealed && (
              <div className="mt-8 border-t border-line pt-6">
                {card.answer ? <Markdown text={card.answer} /> : <p className="text-faint">No model answer.</p>}
                {card.rubric && (
                  <div className="mt-4 rounded-md bg-sunken px-4 py-3 text-sm">
                    <div className="mb-1 text-xs font-semibold tracking-wide text-faint uppercase">Rubric</div>
                    <Markdown text={card.rubric} className="!text-sm" />
                  </div>
                )}
                {card.refs.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-x-3 text-xs">
                    {card.refs.map((r) => (
                      <Link key={r.id} to={r.type === 'note' ? '/notes/$id' : '/sources/$id'} params={{ id: r.id }} className="text-accent hover:underline">
                        {r.title}{r.type === 'note' && r.sourceTitle ? ` · ${r.sourceTitle}` : ''}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="mt-4">
            {!revealed ? (
              <Button variant="primary" className="h-12 w-full text-base" onClick={() => setRevealed(true)}>
                Show answer <Kbd>space</Kbd>
              </Button>
            ) : (
              <div className="grid grid-cols-4 gap-2">
                {RATING_BTNS.map((b) => (
                  <button
                    key={b.r}
                    disabled={busy}
                    onClick={() => rate(b.r)}
                    className="flex h-14 flex-col items-center justify-center rounded-lg border border-line bg-panel hover:bg-sunken disabled:opacity-50"
                  >
                    <span className={`font-semibold ${b.cls}`}>{b.label}</span>
                    <span className="text-[11px] text-faint">
                      {preview?.[b.r] ?? '…'} · <span className="font-mono">{b.key}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-faint">
              <span><Kbd>u</Kbd> undo</span>
              <span><Kbd>!</Kbd> suspend</span>
              <span><Kbd>o</Kbd> open source note</span>
              <span><Kbd>↵</Kbd> reveal / good</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
