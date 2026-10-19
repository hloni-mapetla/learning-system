import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { ItemRef, ItemType, SimilarItem } from '@loom/core';
import { useApi } from '../lib/api';
import { Section } from './ui';
import { LinkForm } from './LinkForm';
import { CardForm } from './CardForm';

/** Semantically similar, not-yet-linked items, with one-click typed link or synthesis card. */
export function SimilarPanel({ self }: { self: ItemRef & { type: ItemType } }) {
  const [crossOnly, setCrossOnly] = useState(true);
  const { data, isLoading } = useApi<SimilarItem[]>(`/similar/${self.type}/${self.id}?limit=6&crossSource=${crossOnly}`);
  const [linking, setLinking] = useState<SimilarItem | null>(null);
  const [synth, setSynth] = useState<SimilarItem | null>(null);

  return (
    <Section
      title="Possible connections"
      actions={
        <button className="text-[11px] text-faint hover:text-muted" onClick={() => setCrossOnly(!crossOnly)}>
          {crossOnly ? 'other sources' : 'all sources'}
        </button>
      }
    >
      {linking && <div className="mb-2"><LinkForm from={self} initialTarget={{ ...linking, sourceTitle: linking.sourceTitle }} onDone={() => setLinking(null)} /></div>}
      {synth && (
        <div className="mb-2">
          <CardForm initial={{ type: 'synthesis' }} refs={[self, { type: synth.type, id: synth.id, title: synth.title, kind: synth.kind }]} onDone={() => setSynth(null)} />
        </div>
      )}
      {isLoading && <p className="text-xs text-faint">Looking…</p>}
      {data && !data.length && <p className="text-xs text-faint">Nothing similar yet.</p>}
      <ul className="space-y-2">
        {data?.map((s) => (
          <li key={s.id} className="text-sm">
            <Link to={s.type === 'note' ? '/notes/$id' : '/sources/$id'} params={{ id: s.id }} className="hover:text-accent">
              {s.title}
            </Link>
            <div className="text-xs text-faint">
              {s.sourceTitle && s.type === 'note' ? `${s.sourceTitle} · ` : ''}
              {s.score <= 1 ? `${Math.round(s.score * 100)}% similar` : 'keyword match'}
            </div>
            <div className="mt-0.5 flex gap-3 text-xs">
              <button className="text-accent hover:underline" onClick={() => setLinking(s)}>link…</button>
              {!s.sameSource && <button className="text-accent hover:underline" onClick={() => setSynth(s)}>synthesis card…</button>}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-faint">Ask Claude to “connect” this note for a judged list of links and synthesis questions.</p>
    </Section>
  );
}
