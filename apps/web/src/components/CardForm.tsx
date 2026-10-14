import { useState } from 'react';
import type { CardType, CardView, ItemRef } from '@loom/core/types';
import { api, useAction } from '../lib/api';
import { Button, Select, Textarea } from './ui';

const HELP: Record<CardType, string> = {
  basic: 'Question on the front, answer on the back.',
  cloze: 'Wrap hidden text in {{c1::…}}; each c-number becomes its own card. Add a hint with {{c1::answer::hint}}.',
  open: 'An open-ended prompt. Best graded by Claude against the rubric; you can also self-grade.',
  synthesis: 'A question that combines ideas from two or more sources. Needs refs from 2+ sources.',
};

export function CardForm({
  refs = [],
  initial,
  onDone,
}: {
  refs?: ItemRef[];
  initial?: Partial<{ type: CardType; front: string; back: string }>;
  onDone: (cards?: CardView[]) => void;
}) {
  const [type, setType] = useState<CardType>(initial?.type ?? 'basic');
  const [front, setFront] = useState(initial?.front ?? '');
  const [back, setBack] = useState(initial?.back ?? '');
  const [rubric, setRubric] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useAction((b: unknown) => api.post<CardView[]>('/cards', b));

  const submit = async (again: boolean) => {
    setError(null);
    try {
      const cards = await create.mutateAsync({
        type,
        front,
        back,
        rubric: rubric || null,
        refs: refs.map((r) => ({ type: r.type, id: r.id })),
      });
      if (again) {
        setFront('');
        setBack('');
        setRubric('');
      } else onDone(cards);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <form
      className="space-y-2 rounded-lg border border-accent bg-panel p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit(true);
        }
      }}
    >
      <div className="flex items-center gap-2">
        <Select value={type} onChange={(e) => setType(e.target.value as CardType)}>
          <option value="basic">Basic Q/A</option>
          <option value="cloze">Cloze</option>
          <option value="open">Open-ended</option>
          <option value="synthesis" disabled={refs.length < 2}>Synthesis</option>
        </Select>
        {refs.length > 0 && <span className="truncate text-xs text-faint">from {refs.map((r) => r.title).join(', ')}</span>}
      </div>
      <p className="text-xs text-muted">{HELP[type]}</p>
      <Textarea autoFocus rows={type === 'cloze' ? 4 : 2} placeholder={type === 'cloze' ? 'Text with {{c1::deletions}}' : 'Front / question'} value={front} onChange={(e) => setFront(e.target.value)} />
      <Textarea rows={2} placeholder={type === 'basic' ? 'Back / answer' : 'Model answer or extra context (optional)'} value={back} onChange={(e) => setBack(e.target.value)} />
      {(type === 'open' || type === 'synthesis') && (
        <Textarea rows={2} placeholder="Rubric: what a good answer must include" value={rubric} onChange={(e) => setRubric(e.target.value)} />
      )}
      {error && <div className="text-sm text-danger">{error}</div>}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-faint">⌘↵ save & another</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onDone()}>Cancel</Button>
        <Button type="submit" variant="primary" size="sm" disabled={create.isPending}>Create</Button>
      </div>
    </form>
  );
}
