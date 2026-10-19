import { useEffect, useRef, useState } from 'react';
import { FEELS_HARDER_NOTE, RECALL_PROMPT, type Actor } from '@loom/core/types';
import { api, useAction } from '../lib/api';
import { Badge, Button, Textarea } from './ui';

/** Blank-page recall: write what you remember before looking at any highlights. */
export function RecallBox({
  sourceId,
  sourceTitle,
  onSaved,
  onCancel,
  autoFocus = true,
}: {
  sourceId: string;
  sourceTitle?: string | null;
  onSaved?: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const ref = useRef<HTMLTextAreaElement>(null);
  const save = useAction((body: unknown) => api.post(`/sources/${sourceId}/recall`, body));

  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  const submit = async () => {
    if (!text.trim() || save.isPending) return;
    await save.mutateAsync({ text });
    setText('');
    setStartedAt(null);
    onSaved?.();
  };
  const secs = startedAt ? Math.floor((now - startedAt) / 1000) : 0;

  return (
    <form
      id="recall-box"
      className="mb-6 rounded-lg border border-accent bg-panel p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && onCancel) onCancel();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="mb-1 flex items-center gap-2">
        <h2 className="font-semibold">Recall first{sourceTitle ? `: ${sourceTitle}` : ''}</h2>
        <span className="ml-auto font-mono text-xs text-faint tabular-nums">
          {startedAt ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''}
        </span>
      </div>
      <p className="mb-3 text-sm text-muted">{RECALL_PROMPT}</p>
      <Textarea
        ref={ref}
        autoFocus={autoFocus}
        rows={7}
        placeholder="Don't look anything up. What do you remember?"
        value={text}
        onChange={(e) => {
          if (startedAt === null) setStartedAt(Date.now());
          setText(e.target.value);
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="text-xs text-faint">⌘↵ save{onCancel ? ' · esc close' : ''}</span>
        {onCancel && <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onCancel}>Not now</Button>}
        <Button type="submit" variant="primary" size="sm" className={onCancel ? '' : 'ml-auto'} disabled={!text.trim() || save.isPending}>
          Save recall
        </Button>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-faint">{FEELS_HARDER_NOTE}</p>
    </form>
  );
}

/** Marks content the learner didn't write. Their own work stays unmarked. */
export function AuthorBadge({ by }: { by: Actor }) {
  if (by === 'claude') return <Badge tone="warn">by Claude</Badge>;
  if (by === 'system') return <Badge>imported</Badge>;
  return null;
}
