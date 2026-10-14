import { useEffect } from 'react';

export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('.cm-editor');
}

type Handler = (e: KeyboardEvent) => void;

/**
 * Register keyboard shortcuts. Keys: "mod+k", "shift+?", "j", or two-key sequences "g n".
 * Plain keys are ignored while typing; "mod+" combos always fire.
 */
export function useHotkeys(map: Record<string, Handler>, deps: unknown[] = []) {
  useEffect(() => {
    let pendingPrefix: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const combo = `${mod ? 'mod+' : ''}${e.altKey ? 'alt+' : ''}${key}`;
      if (map[combo] && (mod || !isTyping(e))) {
        e.preventDefault();
        map[combo](e);
        return;
      }
      if (mod || isTyping(e)) return;
      if (pendingPrefix) {
        const seq = `${pendingPrefix} ${key}`;
        pendingPrefix = null;
        if (map[seq]) {
          e.preventDefault();
          map[seq](e);
        }
        return;
      }
      if (Object.keys(map).some((k) => k.startsWith(`${key} `))) {
        pendingPrefix = key;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => (pendingPrefix = null), 1200);
        return;
      }
      const shifted = map[`shift+${key}`];
      if (e.shiftKey && shifted) {
        e.preventDefault();
        shifted(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
