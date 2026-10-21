import { useEffect } from 'react';

export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('.cm-editor');
}

type Handler = (e: KeyboardEvent) => void;

/**
 * Register keyboard shortcuts. Keys are matched on `event.key` (so "C" is shift+c and "?" is shift+/):
 * "mod+k" (⌘/Ctrl), plain keys like "j" or "Enter", and two-key sequences like "g n".
 * "alt+ArrowUp" (⌥). Plain keys, alt combos and sequences are ignored while typing in an input/editor; "mod+" combos always fire.
 */
export function useHotkeys(map: Record<string, Handler>, deps: unknown[] = []) {
  useEffect(() => {
    let prefix: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = (k: string, e: KeyboardEvent) => {
      const h = map[k];
      if (!h) return false;
      e.preventDefault();
      h(e);
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        fire(`mod+${e.key.toLowerCase()}`, e);
        return;
      }
      if (isTyping(e)) return;
      if (e.altKey) {
        fire(`alt+${e.key}`, e);
        return;
      }
      if (prefix) {
        const seq = `${prefix} ${e.key}`;
        prefix = null;
        if (fire(seq, e)) return;
      }
      if (Object.keys(map).some((k) => k.startsWith(`${e.key} `))) {
        prefix = e.key;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => (prefix = null), 1200);
        e.preventDefault();
        return;
      }
      fire(e.key, e) || fire(`shift+${e.key}`, e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
