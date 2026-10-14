// Domain types shared by core, server, MCP and the web UI. Pure: no runtime imports.

export const SOURCE_KINDS = ['book', 'article', 'paper', 'video', 'lecture', 'podcast', 'other'] as const;
export const SOURCE_STATUSES = ['queued', 'reading', 'done', 'abandoned'] as const;
export const NOTE_KINDS = ['note', 'highlight', 'concept', 'claim', 'summary'] as const;
export const LINK_RELS = ['wikilink', 'supports', 'contradicts', 'example_of', 'prerequisite_of', 'related'] as const;
export const TYPED_LINK_RELS = ['supports', 'contradicts', 'example_of', 'prerequisite_of', 'related'] as const;
export const CARD_TYPES = ['basic', 'cloze', 'open', 'synthesis'] as const;
export const TASK_KINDS = ['todo', 'read', 'process_highlights', 'summarize', 'write'] as const;
export const RATINGS = ['again', 'hard', 'good', 'easy'] as const;
export const CARD_STATES = ['new', 'learning', 'review', 'relearning'] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SourceStatus = (typeof SOURCE_STATUSES)[number];
export type NoteKind = (typeof NOTE_KINDS)[number];
export type LinkRel = (typeof LINK_RELS)[number];
export type CardType = (typeof CARD_TYPES)[number];
export type TaskKind = (typeof TASK_KINDS)[number];
export type RatingName = (typeof RATINGS)[number];
export type CardStateName = (typeof CARD_STATES)[number];
export type ItemType = 'note' | 'source';
export type Actor = 'user' | 'claude' | 'system';

export interface Source {
  id: string;
  kind: SourceKind;
  title: string;
  authors: string;
  url: string | null;
  published: string | null;
  status: SourceStatus;
  priority: number;
  description: string;
  startedAt: string | null;
  finishedAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  body: string;
  quote: string | null;
  location: string | null;
  sourceId: string | null;
  sourceTitle: string | null;
  aliases: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ItemRef {
  type: ItemType;
  id: string;
  title: string;
  kind: string;
  sourceId?: string | null;
  sourceTitle?: string | null;
}

export interface Link {
  id: string;
  rel: LinkRel;
  from: ItemRef;
  to: ItemRef | null; // null = unresolved wikilink
  targetTitle: string | null;
  rationale: string | null;
  createdBy: Actor;
  createdAt: string;
}

export interface NoteDetail extends Note {
  outgoing: Link[];
  backlinks: Link[];
  cards: CardView[];
}

export interface SourceDetail extends Source {
  notes: Note[];
  outgoing: Link[];
  backlinks: Link[];
  cardCount: number;
  tasks: Task[];
}

export interface CardView {
  id: string;
  type: CardType;
  /** What to show the learner (cloze deletions hidden as [...]). */
  prompt: string;
  /** The expected answer (cloze: the full text with deletions marked). */
  answer: string;
  /** Cloze only: the text hidden by this card's deletion. */
  hidden?: string[];
  rubric: string | null;
  /** Raw stored text (cloze markup intact) for editing. */
  front: string;
  back: string;
  noteId: string | null;
  clozeIndex: number | null;
  origin: 'manual' | 'note_cloze';
  suspended: boolean;
  createdBy: Actor;
  refs: ItemRef[];
  tags: string[];
  state: CardStateName;
  due: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReview: string | null;
  /** Probability of recall right now (0–1), null for new cards. */
  retrievability: number | null;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  kind: TaskKind;
  details: string;
  sourceId: string | null;
  sourceTitle: string | null;
  noteId: string | null;
  dueDate: string | null;
  priority: number;
  status: 'open' | 'done' | 'cancelled';
  completedAt: string | null;
  sortOrder: number;
  createdAt: string;
  /** True for computed tasks (e.g. today's reviews) that are not stored rows. */
  virtual?: boolean;
}

export interface SearchHit {
  type: 'note' | 'source' | 'card';
  id: string;
  title: string;
  kind: string;
  snippet: string;
  sourceId: string | null;
  sourceTitle: string | null;
  score: number;
  matchedBy: ('text' | 'semantic')[];
}
