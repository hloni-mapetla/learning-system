/** Minimal YAML-ish frontmatter + Markdown import (Obsidian-style files). */

export interface ParsedMarkdown {
  title: string | null;
  body: string;
  meta: Record<string, string | string[]>;
}

export function parseFrontmatter(md: string): ParsedMarkdown {
  const text = md.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const meta: Record<string, string | string[]> = {};
  let body = text;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m) {
    body = text.slice(m[0].length);
    let lastKey: string | null = null;
    for (const line of m[1].split('\n')) {
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item && lastKey) {
        const cur = meta[lastKey];
        meta[lastKey] = [...(Array.isArray(cur) ? cur : cur ? [cur] : []), unquote(item[1])];
        continue;
      }
      const kv = /^([\w-]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      lastKey = kv[1].toLowerCase();
      const v = kv[2].trim();
      if (v.startsWith('[') && v.endsWith(']')) {
        meta[lastKey] = v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
      } else meta[lastKey] = unquote(v);
    }
  }
  const h1 = /^#\s+(.+)$/m.exec(body);
  const title = (typeof meta.title === 'string' && meta.title) || h1?.[1]?.trim() || null;
  if (h1 && title === h1[1].trim() && body.trimStart().startsWith(h1[0])) body = body.trimStart().slice(h1[0].length).trimStart();
  return { title, body: body.trim(), meta };
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

/**
 * Split pasted plain text into highlights: blank-line separated paragraphs. A trailing "(p. 12)" / "— loc 345"
 * becomes the location; lines starting with "Note:" attach to the previous highlight as a comment.
 */
export function splitPastedHighlights(text: string): { quote: string; location: string | null; note: string | null }[] {
  const out: { quote: string; location: string | null; note: string | null }[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const p = raw.trim().replace(/^[-*•>]\s*/, '');
    if (!p) continue;
    const note = /^(note|comment|me):\s*(.+)$/is.exec(p);
    if (note && out.length) {
      out[out.length - 1].note = note[2].trim();
      continue;
    }
    const loc = /[\s—–-]*\(?\b((?:p\.?|page|pp\.?|loc\.?|location|ch\.?|chapter)\s*[\w.-]*\d[\w.-]*)\)?\s*$/i.exec(p);
    const quote = (loc ? p.slice(0, loc.index) : p).trim().replace(/^["“]|["”]$/g, '');
    if (quote) out.push({ quote, location: loc ? loc[1] : null, note: null });
  }
  return out;
}
