/** A [[wikilink]] occurrence: [[Target]], [[Target|label]], [[Target#heading]]. */
export interface WikiRef {
  target: string;
  label: string | null;
}

const WIKILINK = /\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|([^\[\]\n]+))?\]\]/g;

export function parseWikilinks(md: string): WikiRef[] {
  const seen = new Set<string>();
  const out: WikiRef[] = [];
  // Ignore fenced and inline code.
  const text = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of text.matchAll(WIKILINK)) {
    const target = m[1].trim();
    if (!target) continue;
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ target, label: m[2]?.trim() || null });
  }
  return out;
}
