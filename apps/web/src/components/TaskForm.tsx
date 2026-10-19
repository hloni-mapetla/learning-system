import { useState } from 'react';
import { TASK_KINDS, type Source, type TaskKind } from '@loom/core/types';
import { api, useAction, useApi } from '../lib/api';
import { today } from '../lib/format';
import { Button, Input, Select } from './ui';

const KIND_LABEL: Record<TaskKind, string> = {
  todo: 'To-do',
  read: 'Read',
  process_highlights: 'Recall & process',
  summarize: 'Summarize',
  write: 'Write',
};

export function TaskForm({ sourceId, onDone }: { sourceId?: string; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<TaskKind>(sourceId ? 'read' : 'todo');
  const [due, setDue] = useState(today());
  const [priority, setPriority] = useState(3);
  const [src, setSrc] = useState(sourceId ?? '');
  const sources = useApi<{ items: Source[] }>(sourceId ? null : '/sources?status=reading,queued&sort=priority');
  const create = useAction((b: unknown) => api.post('/tasks', b));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await create.mutateAsync({ title, kind, dueDate: due || null, priority, sourceId: src || null });
    setTitle('');
  };
  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onDone()} className="mb-4 flex flex-wrap gap-2 rounded-lg border border-accent bg-panel p-3">
      <Input autoFocus placeholder="What needs doing? (↵ to add, esc to close)" value={title} onChange={(e) => setTitle(e.target.value)} className="min-w-60 flex-1" />
      <Select value={kind} onChange={(e) => setKind(e.target.value as TaskKind)}>
        {TASK_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </Select>
      {!sourceId && (
        <Select value={src} onChange={(e) => setSrc(e.target.value)} className="max-w-48">
          <option value="">No source</option>
          {sources.data?.items.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </Select>
      )}
      <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-40" />
      <Select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
        {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}
      </Select>
      <Button type="submit" variant="primary">Add</Button>
    </form>
  );
}

export { KIND_LABEL };
