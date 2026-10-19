import { useState } from 'react';
import type { Note } from '@loom/core/types';
import { api, useAction } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { Button, Input, TagInput, Textarea } from './ui';

/**
 * Capture a thought from anywhere without leaving the page: a standalone note (not tied to any source),
 * or a time-stamped line in today's daily note.
 */
export function QuickCapture({ onClose, onSaved }: { onClose: () => void; onSaved: (n: Note, where: 'note' | 'daily') => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const create = useAction((b: unknown) => api.post<Note>('/notes', b));
  const append = useAction((b: unknown) => api.post<Note>('/notes/daily/append', b));
  useHotkeys({ Escape: onClose }, []);

  const save = async (where: 'note' | 'daily') => {
    if (!body.trim() && !title.trim()) return;
    setError(null);
    try {
      const n =
        where === 'daily'
          ? await append.mutateAsync({ text: [title.trim() && `**${title.trim()}**`, body.trim()].filter(Boolean).join(' ') })
          : await create.mutateAsync({ title: title.trim() || undefined, body, tags, kind: 'note' });
      onSaved(n, where);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-start bg-black/30 px-4 pt-[12vh]" onClick={onClose}>
      <form
        className="mx-auto w-full max-w-xl space-y-2 rounded-xl border border-line bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          save('note');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save(e.shiftKey ? 'daily' : 'note');
          }
        }}
      >
        <div className="text-xs font-semibold tracking-wide text-faint uppercase">Quick capture</div>
        <Input placeholder="Title (optional; defaults to the first line)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea
          autoFocus
          rows={6}
          placeholder="A thought, an idea, a question… Markdown and [[links]] work."
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <TagInput value={tags} onChange={setTags} />
        {error && <div className="text-sm text-danger">{error}</div>}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="mr-auto text-xs text-faint">⌘↵ new note · ⌘⇧↵ add to today's daily note · esc</span>
          <Button type="button" size="sm" onClick={() => save('daily')}>Add to daily note</Button>
          <Button type="submit" size="sm" variant="primary">Save note</Button>
        </div>
      </form>
    </div>
  );
}
