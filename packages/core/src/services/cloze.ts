/** Cloze syntax: {{c1::answer}} or {{c1::answer::hint}} (Anki-compatible). */
const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export function hasCloze(text: string): boolean {
  CLOZE.lastIndex = 0;
  return CLOZE.test(text);
}

/** Distinct cloze indices in order of first appearance. */
export function clozeIndices(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(CLOZE)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** For note-synced clozes: the paragraphs that contain index n (so a card shows local context, not the whole note). */
export function clozeContext(text: string, n: number): string {
  const paras = text.split(/\n\s*\n/);
  const hit = paras.filter((p) => [...p.matchAll(CLOZE)].some((m) => Number(m[1]) === n));
  return hit.join('\n\n').trim();
}

/** Prompt: deletion n hidden as [...] (or [hint]); other deletions shown as plain text. */
export function clozePrompt(text: string, n: number): string {
  return text.replace(CLOZE, (_m, idx, answer, hint) => (Number(idx) === n ? `[${hint?.trim() || '...'}]` : answer));
}

/** Answer: full text with deletion n in bold. */
export function clozeAnswer(text: string, n: number): string {
  return text.replace(CLOZE, (_m, idx, answer) => (Number(idx) === n ? `**${answer}**` : answer));
}

/** Just the hidden text(s) for deletion n. */
export function clozeHidden(text: string, n: number): string[] {
  return [...text.matchAll(CLOZE)].filter((m) => Number(m[1]) === n).map((m) => m[2]);
}

export function stripCloze(text: string): string {
  return text.replace(CLOZE, (_m, _i, answer) => answer);
}
