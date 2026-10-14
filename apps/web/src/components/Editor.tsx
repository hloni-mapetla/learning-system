import { useEffect, useRef } from 'react';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { minimalSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { api } from '../lib/api';

async function wikilinkSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  const m = ctx.matchBefore(/\[\[[^\]\n|]*/);
  if (!m) return null;
  const prefix = m.text.slice(2);
  const rows = await api.get<{ type: string; id: string; title: string; kind: string }[]>(
    `/titles?prefix=${encodeURIComponent(prefix)}&limit=12`,
  );
  const closed = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === ']]';
  return {
    from: m.from + 2,
    filter: false,
    options: rows.map((r) => ({
      label: r.title,
      detail: r.type === 'source' ? `source · ${r.kind}` : r.kind,
      apply: closed ? r.title : `${r.title}]]`,
    })),
  };
}

/** Wrap the selection in the next cloze deletion: {{cN::selection}}. */
function wrapCloze(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  if (from === to) return false;
  const doc = view.state.doc.toString();
  const used = [...doc.matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]));
  const n = used.length ? Math.max(...used) + 1 : 1;
  const text = view.state.sliceDoc(from, to);
  view.dispatch({ changes: { from, to, insert: `{{c${n}::${text}}}` } });
  return true;
}

export function Editor({
  value,
  onChange,
  onBlur,
  onEscape,
  autoFocus,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  onEscape?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cbs = useRef({ onChange, onBlur, onEscape });
  cbs.current = { onChange, onBlur, onEscape };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          minimalSetup,
          markdown(),
          EditorView.lineWrapping,
          autocompletion({ override: [wikilinkSource], activateOnTyping: true }),
          cmPlaceholder(placeholder ?? 'Write in Markdown. [[ to link, {{c1::text}} for a cloze card.'),
          keymap.of([
            { key: 'Mod-Shift-c', run: wrapCloze },
            {
              key: 'Escape',
              run: () => {
                cbs.current.onEscape?.();
                return !!cbs.current.onEscape;
              },
            },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbs.current.onChange(u.state.doc.toString());
            if (u.focusChanged && !u.view.hasFocus) cbs.current.onBlur?.();
          }),
        ],
      }),
    });
    view.current = v;
    if (autoFocus) v.focus();
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Accept external updates (e.g. Claude edited the note) when the user isn't typing.
  useEffect(() => {
    const v = view.current;
    if (v && !v.hasFocus && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} className="h-full min-h-[50vh]" />;
}
