/** Parser for Kindle "My Clippings.txt". */

export interface KindleClipping {
  bookTitle: string;
  author: string;
  kind: 'highlight' | 'note' | 'bookmark';
  page: string | null;
  location: string | null; // "1234-1240"
  addedAt: string | null; // as written by the device
  text: string;
}

const SEP = /^={10}\s*$/m;

/** Split "Title (Author)" — the author is the last parenthesised group. */
export function splitTitleAuthor(line: string): { title: string; author: string } {
  const clean = line.replace(/^﻿/, '').trim();
  const m = /^(.*)\(([^()]*)\)\s*$/.exec(clean);
  if (!m) return { title: clean, author: '' };
  // "Last, First" → "First Last"; multiple authors separated by ';' are kept.
  const author = m[2]
    .split(';')
    .map((a) => {
      const parts = a.split(',').map((p) => p.trim());
      return parts.length === 2 ? `${parts[1]} ${parts[0]}` : a.trim();
    })
    .join(', ');
  return { title: m[1].trim(), author };
}

export function parseKindleClippings(text: string): KindleClipping[] {
  const out: KindleClipping[] = [];
  for (const block of text.split(SEP)) {
    const lines = block.replace(/\r/g, '').split('\n').map((l) => l.trim());
    while (lines.length && !lines[0]) lines.shift();
    if (lines.length < 2) continue;
    const { title, author } = splitTitleAuthor(lines[0]);
    const meta = lines[1];
    const lower = meta.toLowerCase();
    const kind: KindleClipping['kind'] = lower.includes('bookmark') ? 'bookmark' : /\bnote\b/.test(lower) ? 'note' : 'highlight';
    const page = /page\s+([\w-]+)/i.exec(meta)?.[1] ?? null;
    const location = /loc(?:ation)?\.?\s+([\d-]+)/i.exec(meta)?.[1] ?? null;
    const addedAt = /Added on\s+(.+)$/i.exec(meta)?.[1]?.trim() ?? null;
    const body = lines.slice(2).join('\n').trim();
    if (kind === 'bookmark' || !body) continue;
    out.push({ bookTitle: title, author, kind, page, location, addedAt, text: body });
  }
  return dropSuperseded(out);
}

/**
 * Kindle appends a new clipping every time a highlight is extended, so the file holds
 * overlapping versions. Keep only the longest highlight for overlapping/contained text in the same book.
 */
function dropSuperseded(clips: KindleClipping[]): KindleClipping[] {
  const keep: KindleClipping[] = [];
  for (const c of clips) {
    if (c.kind !== 'highlight') {
      keep.push(c);
      continue;
    }
    const i = keep.findIndex(
      (k) => k.kind === 'highlight' && k.bookTitle === c.bookTitle && (k.text.includes(c.text) || c.text.includes(k.text)),
    );
    if (i === -1) keep.push(c);
    else if (c.text.length > keep[i].text.length) keep[i] = c;
  }
  return keep;
}
