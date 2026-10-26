import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { CardView, RatingName } from '@loom/core/types';
import type { PracticeCard, PracticeSet, Settings } from '@loom/core';
import { api, qs, useAction, useApi } from '../lib/api';
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

/** Pick 2+ topics to mix: j/k move, space/x toggle, ↵ start, esc close. */
function MixPicker({ tags, initial, onStart, onClose }: { tags: string[]; initial: string[]; onStart: (topics: string[]) => void; onClose: () => void }) {
  const [sel, setSel] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set(initial));
  const toggle = (t: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  const start = () => picked.size >= 2 && onStart([...picked]);
  useHotkeys(
    {
      j: () => setSel((i) => Math.min(tags.length - 1, i + 1)),
      k: () => setSel((i) => Math.max(0, i - 1)),
      ArrowDown: () => setSel((i) => Math.min(tags.length - 1, i + 1)),
      ArrowUp: () => setSel((i) => Math.max(0, i - 1)),
      ' ': () => tags[sel] && toggle(tags[sel]),
      x: () => tags[sel] && toggle(tags[sel]),
      Enter: start,
      Escape: onClose,
    },
    [sel, tags, picked],
  );
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-lg font-semibold">Mix topics</h2>
        <p className="mb-4 text-sm text-muted">
          Practise two or more topics shuffled together. It feels harder than one topic at a time; that's what trains you to tell them apart.
        </p>
        <ul className="max-h-[50vh] space-y-1 overflow-y-auto">
          {tags.map((t, i) => (
            <li key={t}>
              <button
                onClick={() => toggle(t)}
                onMouseEnter={() => setSel(i)}
                className={`flex w-full items-center gap-3 rounded-md border px-3 py-1.5 text-left text-sm ${i === sel ? 'border-accent' : 'border-transparent'}`}
              >
                <span className={`grid size-4 place-items-center rounded border text-[10px] ${picked.has(t) ? 'border-accent bg-accent text-accent-ink' : 'border-line'}`}>
                  {picked.has(t) ? '✓' : ''}
                </span>
                #{t}
              </button>
            </li>
          ))}
        </ul>
        {!tags.length && <p className="text-sm text-faint">No tags yet. Tag sources or notes to mix them here.</p>}
        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-faint"><Kbd>space</Kbd> pick · <Kbd>↵</Kbd> start · <Kbd>esc</Kbd> close</span>
          <Button variant="primary" disabled={picked.size < 2} onClick={start}>
            Practise {picked.size >= 2 ? picked.size : ''} topics
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ReviewPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tag, setTag] = useState('');
  // Practice mode: a mixed set across these topics (null = the daily review).
  const [mix, setMix] = useState<string[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [mixInfo, setMixInfo] = useState<PracticeSet['topics'] | null>(null);
  const settings = useApi<Settings>('/settings');
  const saveSettings = useAction((b: Partial<Settings>) => api.patch('/settings', b));
  const [queue, setQueue] = useState<(CardView | PracticeCard)[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [preview, setPreview] = useState<Record<RatingName, string> | null>(null);
  const [done, setDone] = useState<{ id: string; rating: RatingName }[]>([]);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(Date.now());
  const tags = useApi<{ name: string }[]>('/tags');
  const counts = useApi<Counts>(`/review/counts${qs({ tag })}`);

  const load = useCallback(async () => {
    if (mix) {
      const set = await api.get<PracticeSet>(`/practice${qs({ topics: mix.join(','), size: 30 })}`);
      setMixInfo(set.topics);
      setQueue(set.cards);
    } else {
      setMixInfo(null);
      setQueue(await api.get<CardView[]>(`/review/due${qs({ tag, limit: 200 })}`));
    }
    setIdx(0);
    setRevealed(false);
  }, [tag, mix]);
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
      await api.post(`/review/${card.id}`, { rating, durationMs: Date.now() - shownAt.current, context: mix ? 'practice' : 'ui' });
      setDone((d) => [...d, { id: card.id, rating }]);
      setRevealed(false);
      if (idx + 1 < (queue?.length ?? 0)) setIdx(idx + 1);
      else if (mix) setIdx(idx + 1); // a practice set is fixed: finishing it ends the session
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

  // While the Mix picker is open, its keys are the only ones (space and ↵ mustn't reveal or rate the card behind it).
  useHotkeys(
    picking ? {} : {
      ' ': () => setRevealed(true),
      Enter: () => (revealed ? rate('good') : setRevealed(true)),
      '1': () => rate('again'),
      '2': () => rate('hard'),
      '3': () => rate('good'),
      '4': () => rate('easy'),
      u: undo,
      m: () => setPicking(true),
      Escape: () => mix && (setMix(null), setDone([])),
      'mod+z': undo,
      '!': suspend,
      'shift+!': suspend,
      o: () => {
        const ref = card?.refs[0];
        if (ref) navigate({ to: ref.type === 'note' ? '/notes/$id' : '/sources/$id', params: { id: ref.id } });
      },
    },
    [card?.id, revealed, busy, done.length, idx, queue, mix, picking],
  );

  const remaining = queue ? queue.length - idx : 0;
  const pc = card && 'practiceTopic' in card ? (card as PracticeCard) : null;
  const tally = RATING_BTNS.map((b) => [b.label, done.filter((d) => d.rating === b.r).length] as const);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={mix ? 'Mixed practice' : 'Review'}
        subtitle={
          mix ? (
            <>
              {mixInfo?.map((t) => `#${t.topic} ${t.picked}${t.due ? ` (${t.due} due)` : ''}`).join(' · ')}. Not-due cards are early reviews of your weakest.{' '}
              <button onClick={() => (setMix(null), setDone([]))} className="text-accent hover:underline">Back to daily review</button> <Kbd>esc</Kbd>
            </>
          ) : (
            counts.data && (
              <>
                {counts.data.learning} learning · {counts.data.review} review · {counts.data.new} new due today
              </>
            )
          )
        }
        actions={
          <>
            {!mix && (
              <Select value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">All topics</option>
                {tags.data?.map((t) => <option key={t.name} value={t.name}>#{t.name}</option>)}
              </Select>
            )}
            <Button onClick={() => setPicking(true)}>Mix topics <Kbd>m</Kbd></Button>
          </>
        }
      />
      {picking && (
        <MixPicker
          tags={(tags.data ?? []).map((t) => t.name)}
          initial={mix ?? []}
          onClose={() => setPicking(false)}
          onStart={(topics) => {
            setPicking(false);
            setDone([]);
            setMix(topics);
          }}
        />
      )}

      {queue && !card && (
        <Empty>
          <div className="mb-2 text-base text-ink">
            {done.length ? `Session done: ${done.length} reviewed.` : mix ? 'Nothing to practise in these topics yet (cards need one review first).' : 'Nothing due right now.'}
          </div>
          {done.length > 0 && <div className="mb-3">{tally.map(([l, n]) => `${l} ${n}`).join(' · ')}</div>}
          <div>
            {mix ? (
              <>For “which idea applies?” questions between these topics, ask Claude for <b>interleaved practice</b>.</>
            ) : (
              <>Prefer a conversation? Ask Claude for a <b>daily review</b>; it quizzes you on the same queue. Or press <Kbd>m</Kbd> to mix topics.</>
            )}
          </div>
        </Empty>
      )}

      {card && (
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-faint">
            <Badge>{card.type}</Badge>
            <Badge tone={STATE_TONE[card.state]}>{card.state}</Badge>
            {pc && <Badge tone="accent">#{pc.practiceTopic}</Badge>}
            {pc && !pc.isDue && <Badge>early</Badge>}
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
              <span><Kbd>m</Kbd> mix topics</span>
              {!mix && settings.data && (
                <label className="ml-auto flex cursor-pointer items-center gap-1.5" title="Mix the daily review across notes, sources and topics">
                  <input type="checkbox" checked={settings.data.interleave} onChange={async (e) => { await saveSettings.mutateAsync({ interleave: e.target.checked }); load(); }} />
                  mixed order
                </label>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
