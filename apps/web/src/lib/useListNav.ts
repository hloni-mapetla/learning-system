import { useEffect, useState } from 'react';
import { useHotkeys } from './hotkeys';

/** j/k selection over a list, Enter to open. Scrolls the selected row (data-row index) into view. */
export function useListNav(count: number, onOpen: (i: number) => void, extra: Record<string, (e: KeyboardEvent) => void> = {}) {
  const [sel, setSel] = useState(-1);
  useEffect(() => {
    if (sel >= count) setSel(count - 1);
  }, [count, sel]);
  useEffect(() => {
    if (sel >= 0) document.querySelector(`[data-row="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  useHotkeys(
    {
      j: () => setSel((s) => Math.min(count - 1, s + 1)),
      k: () => setSel((s) => Math.max(0, s - 1)),
      ArrowDown: () => setSel((s) => Math.min(count - 1, s + 1)),
      ArrowUp: () => setSel((s) => Math.max(0, s - 1)),
      Enter: () => sel >= 0 && onOpen(sel),
      ...extra,
    },
    [count, sel, onOpen],
  );
  return [sel, setSel] as const;
}
