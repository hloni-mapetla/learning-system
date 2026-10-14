import { useEffect, useState } from 'react';
import { TYPED_LINK_RELS, type ItemRef, type ItemType } from '@loom/core/types';
import { api, useAction } from '../lib/api';
import { Button, Input, Select } from './ui';

const REL_TEXT: Record<string, string> = {
  supports: 'supports',
  contradicts: 'contradicts',
  example_of: 'is an example of',
  prerequisite_of: 'is a prerequisite of',
  related: 'is related to',
};

/** Create a typed link from `from` to a target picked by title. */
export function LinkForm({ from, initialTarget, onDone }: { from: { type: ItemType; id: string }; initialTarget?: ItemRef; onDone: () => void }) {
  const [rel, setRel] = useState<string>('supports');
  const [q, setQ] = useState(initialTarget?.title ?? '');
  const [target, setTarget] = useState<{ type: ItemType; id: string; title: string } | null>(initialTarget ?? null);
  const [opts, setOpts] = useState<{ type: ItemType; id: string; title: string; kind: string }[]>([]);
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useAction((b: unknown) => api.post('/links', b));

  useEffect(() => {
    if (!q || target?.title === q) return setOpts([]);
    const t = setTimeout(() => api.get<typeof opts>(`/titles?prefix=${encodeURIComponent(q)}&limit=8`).then(setOpts), 120);
    return () => clearTimeout(t);
  }, [q, target]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return setError('Pick a target from the list');
    try {
      await create.mutateAsync({ from, to: { type: target.type, id: target.id }, rel, rationale: rationale || null });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onDone()} className="space-y-2 rounded-lg border border-accent bg-panel p-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted">This</span>
        <Select value={rel} onChange={(e) => setRel(e.target.value)}>
          {TYPED_LINK_RELS.map((r) => <option key={r} value={r}>{REL_TEXT[r]}</option>)}
        </Select>
      </div>
      <div className="relative">
        <Input autoFocus={!initialTarget} placeholder="Target note or source…" value={q} onChange={(e) => { setQ(e.target.value); setTarget(null); }} />
        {opts.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-line bg-panel shadow-lg">
            {opts.map((o) => (
              <li key={o.id}>
                <button type="button" className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent-soft" onClick={() => { setTarget(o); setQ(o.title); setOpts([]); }}>
                  {o.title} <span className="text-xs text-faint">{o.type === 'source' ? 'source' : o.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Input placeholder="Why? (one sentence, optional)" value={rationale} onChange={(e) => setRationale(e.target.value)} autoFocus={!!initialTarget} />
      {error && <div className="text-sm text-danger">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" size="sm" variant="primary" disabled={!target}>Link</Button>
      </div>
    </form>
  );
}
