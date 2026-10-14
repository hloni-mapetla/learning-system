import { Marked, type TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';
import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../lib/api';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const wikilink: TokenizerAndRendererExtension = {
  name: 'wikilink',
  level: 'inline',
  start: (src) => src.indexOf('[['),
  tokenizer(src) {
    const m = /^\[\[([^[\]|#\n]+)(#[^[\]|\n]*)?(?:\|([^[\]\n]+))?\]\]/.exec(src);
    if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim(), label: (m[3] ?? m[1]).trim() };
  },
  renderer: (t) => `<a class="wikilink" href="#" data-wikilink="${esc(t.target)}">${esc(t.label)}</a>`,
};

const cloze: TokenizerAndRendererExtension = {
  name: 'cloze',
  level: 'inline',
  start: (src) => src.indexOf('{{c'),
  tokenizer(src) {
    const m = /^\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/.exec(src);
    if (m) return { type: 'cloze', raw: m[0], index: m[1], text: m[2], hint: m[3] };
  },
  renderer: (t) => `<span class="cloze" title="c${t.index}${t.hint ? ` — ${esc(t.hint)}` : ''}">${esc(t.text)}</span>`,
};

const marked = new Marked({ gfm: true, breaks: false });
marked.use({ extensions: [wikilink, cloze] });

export function renderMarkdown(md: string, dangling?: Set<string>): string {
  let html = marked.parse(md, { async: false }) as string;
  if (dangling?.size) {
    html = html.replace(/<a class="wikilink" href="#" data-wikilink="([^"]*)">/g, (m, t) =>
      dangling.has(t.toLowerCase().replace(/&amp;/g, '&')) ? m.replace('class="wikilink"', 'class="wikilink dangling"') : m,
    );
  }
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-wikilink', 'target'] });
}

/** Follow a [[wikilink]]: open the note/source, or create the note if it doesn't exist yet. */
export function useWikilinkClick() {
  const navigate = useNavigate();
  return async (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a[data-wikilink]') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const title = a.dataset.wikilink!;
    const hit = await api.get<{ type: 'note' | 'source'; id: string } | null>(`/resolve?title=${encodeURIComponent(title)}`);
    if (hit) navigate({ to: hit.type === 'note' ? '/notes/$id' : '/sources/$id', params: { id: hit.id } });
    else if (confirm(`"${title}" doesn't exist yet. Create it?`)) {
      const n = await api.post<{ id: string }>('/notes', { title, body: '' });
      navigate({ to: '/notes/$id', params: { id: n.id }, search: { edit: true } });
    }
  };
}

export function Markdown({ text, dangling, className = '' }: { text: string; dangling?: Set<string>; className?: string }) {
  const html = useMemo(() => renderMarkdown(text, dangling), [text, dangling]);
  const onClick = useWikilinkClick();
  return <div className={`prose-loom ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
