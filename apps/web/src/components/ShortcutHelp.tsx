import { Kbd } from './ui';
import { useHotkeys } from '../lib/hotkeys';

const GROUPS: [string, [string, string][]][] = [
  [
    'Anywhere',
    [
      ['⌘K', 'Command palette / search'],
      ['/', 'Search page'],
      ['c', 'Create a note'],
      ['q', 'Quick capture a thought'],
      ['g d', "Today's daily note"],
      ['g s', 'Go to sources'],
      ['g t', 'Go to today'],
      ['g n', 'Go to notes'],
      ['g g', 'Go to graph'],
      ['g i', 'Go to stats'],
      ['g m', 'Go to import/export'],
      ['g r', 'Go to review'],
      ['g c', 'Go to cards'],
      ['?', 'This help'],
    ],
  ],
  [
    'Lists',
    [
      ['j / k', 'Move selection'],
      ['↵', 'Open selected'],
      ['a', 'Add (task / source / highlight)'],
      ['x', 'Complete task (today)'],
    ],
  ],
  [
    'Source',
    [
      ['r', 'Recall first (focus / new recall)'],
      ['⌘↵', 'Save recall'],
      ['s', 'Skip recall, show highlights'],
      ['n', 'Draft a concept note'],
      ['N', 'Draft a claim note'],
      ['a', 'Capture a highlight'],
    ],
  ],
  [
    'Note',
    [
      ['e', 'Edit body'],
      ['esc', 'Stop editing'],
      ['[[', 'Link autocomplete'],
      ['{{c1::…}}', 'Cloze deletion → card'],
      ['⌘⇧C', 'Wrap selection as cloze'],
      ['C', 'New card from note'],
      ['L', 'New typed link from note'],
      ['[ / ]', 'Daily note: previous / next day'],
    ],
  ],
  [
    'Review',
    [
      ['space', 'Show answer'],
      ['1 2 3 4', 'Again / Hard / Good / Easy'],
      ['u', 'Undo last'],
      ['!', 'Suspend card'],
      ['o', 'Open source note'],
    ],
  ],
];

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  useHotkeys({ Escape: onClose }, []);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 px-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl border border-line bg-panel p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">Keyboard shortcuts</h2>
        <div className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map(([g, items]) => (
            <div key={g}>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-faint uppercase">{g}</h3>
              <ul className="space-y-1.5 text-sm">
                {items.map(([k, d]) => (
                  <li key={k} className="flex items-center justify-between gap-2">
                    <span className="text-muted">{d}</span>
                    <Kbd>{k}</Kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
