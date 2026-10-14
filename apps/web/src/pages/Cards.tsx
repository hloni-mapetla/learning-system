import { useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { CARD_STATES, CARD_TYPES, type CardView } from '@loom/core/types';
import { api, qs, useAction, useApi } from '../lib/api';
import { useListNav } from '../lib/useListNav';
import { Button, Empty, PageHeader, Select } from '../components/ui';
import { CardItem } from '../components/CardItem';
import { CardForm } from '../components/CardForm';

export function CardsPage() {
  const params = useSearch({ strict: false }) as { card?: string };
  const [type, setType] = useState('');
  const [state, setState] = useState('');
  const [tag, setTag] = useState('');
  const [adding, setAdding] = useState(false);
  const tags = useApi<{ name: string }[]>('/tags');
  const single = useApi<CardView>(params.card ? `/cards/${params.card}` : null);
  const { data } = useApi<{ items: CardView[]; total: number }>(`/cards${qs({ type, state, tag, sort: 'created', limit: 300 })}`);
  const items = params.card && single.data ? [single.data] : (data?.items ?? []);
  const update = useAction(({ id, body }: { id: string; body: unknown }) => api.patch(`/cards/${id}`, body));
  const remove = useAction((id: string) => api.del(`/cards/${id}`));
  const [sel] = useListNav(items.length, () => {}, {
    a: () => setAdding(true),
    '!': () => sel >= 0 && update.mutate({ id: items[sel].id, body: { suspended: !items[sel].suspended } }),
    'shift+!': () => sel >= 0 && update.mutate({ id: items[sel].id, body: { suspended: !items[sel].suspended } }),
  });

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Cards"
        subtitle={`${data?.total ?? 0} cards`}
        actions={<Button variant="primary" onClick={() => setAdding(true)}>New card</Button>}
      />
      {adding && <div className="mb-4"><CardForm onDone={() => setAdding(false)} /></div>}
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {CARD_TYPES.map((t) => <option key={t}>{t}</option>)}
        </Select>
        <Select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {CARD_STATES.map((t) => <option key={t}>{t}</option>)}
        </Select>
        <Select value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All topics</option>
          {tags.data?.map((t) => <option key={t.name} value={t.name}>#{t.name}</option>)}
        </Select>
      </div>
      {items.length === 0 ? (
        <Empty>No cards. Add <code>{'{{c1::…}}'}</code> to a note, press <b>a</b>, or ask Claude to propose cards from your notes.</Empty>
      ) : (
        <ul className="space-y-3">
          {items.map((c, i) => (
            <li key={c.id} data-row={i} className="group relative">
              <CardItem card={c} selected={i === sel} />
              <div className="absolute top-2 right-2 hidden gap-1 group-hover:flex">
                <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: c.id, body: { suspended: !c.suspended } })}>
                  {c.suspended ? 'Unsuspend' : 'Suspend'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => confirm('Delete this card and its review history?') && remove.mutate(c.id)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
