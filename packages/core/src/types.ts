// Domain types shared by core, server, MCP and the web UI. Pure: no runtime imports.

export const SOURCE_KINDS = ['book', 'article', 'paper', 'video', 'lecture', 'podcast', 'other'] as const;
export const SOURCE_STATUSES = ['queued', 'reading', 'done', 'abandoned'] as const;
export const NOTE_KINDS = ['note', 'highlight', 'concept', 'claim', 'summary', 'recall', 'explanation'] as const;
/** Kinds that count as the learner's own production when they wrote them. */
export const PRODUCTION_KINDS = ['recall', 'concept', 'claim', 'explanation', 'summary'] as const;
export const SOURCE_METHODS = ['recall_first', 'highlights_first'] as const;
export const LINK_RELS = ['wikilink', 'supports', 'contradicts', 'example_of', 'prerequisite_of', 'related'] as const;
export const TYPED_LINK_RELS = ['supports', 'contradicts', 'example_of', 'prerequisite_of', 'related'] as const;
export const CARD_TYPES = ['basic', 'cloze', 'open', 'synthesis'] as const;
export const TASK_KINDS = ['todo', 'read', 'process_highlights', 'summarize', 'write'] as const;
export const RATINGS = ['again', 'hard', 'good', 'easy'] as const;
export const CARD_STATES = ['new', 'learning', 'review', 'relearning'] as const;

// Wording shared by the UI and the MCP tools, so the learner sees the same prompt everywhere.
export const RECALL_PROMPT =
  "Without looking at the book or your highlights: what do you remember? The main argument, ideas, examples, " +
  "anything that surprised you or that you disagreed with. Fragments are fine. Write it the way you'd tell a friend.";

export const FEELS_HARDER_NOTE =
  'The first 2–3 weeks of recall-first will probably feel harder and less productive than rereading highlights. ' +
  'That feeling is the effort that makes it stick: fluent rereading feels better and works worse.';

/** Task kinds flagged "needs a first step" when they have no steps. Read/process tasks have their own flow. */
export const STEP_KINDS = ['todo', 'write', 'summarize'] as const;

export const FIRST_STEP_PROMPT = "What's the very first physical step?";
export const STARTABILITY_HINT = 'Could you make this a physical action you could start in 2 minutes?';
const VAGUE_STARTS = /^(work on|work at|do|finish|handle|deal with|sort out|look into|think about|figure out|continue|progress|start on|get on with|tackle|try to|wrap up)\b/i;

/**
 * A soft hint when a step looks vague (very short, or "work on…", "finish…", "deal with…"). Never blocking.
 * Returns null when the step reads like something you could start.
 */
export function startabilityHint(step: string): string | null {
  const s = step.trim();
  if (!s) return null;
  if (VAGUE_STARTS.test(s) || s.split(/\s+/).length < 2 || s.length < 8) return STARTABILITY_HINT;
  return null;
}

export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SourceStatus = (typeof SOURCE_STATUSES)[number];
export type NoteKind = (typeof NOTE_KINDS)[number];
export type LinkRel = (typeof LINK_RELS)[number];
export type CardType = (typeof CARD_TYPES)[number];
export type TaskKind = (typeof TASK_KINDS)[number];
export type RatingName = (typeof RATINGS)[number];
export type CardStateName = (typeof CARD_STATES)[number];
export type SourceMethod = (typeof SOURCE_METHODS)[number];
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
  /** How it was processed: blank-page recall before highlights, or highlights first (null = not yet). */
  method: SourceMethod | null;
  createdBy: Actor;
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
  /** Who wrote it: the learner, Claude, or an importer (system). */
  createdBy: Actor;
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
  /** none = no recall yet and not skipped; highlights stay hidden in the UI until done or skipped. */
  recallState: RecallState;
}

export type RecallState = 'none' | 'done' | 'skipped';

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
  createdBy: Actor;
  /** Too small to need steps: never flagged "needs a first step". */
  singleStep: boolean;
  /** Ordered steps (one level). */
  subtasks: Subtask[];
  progress: { done: number; total: number };
  /** The first incomplete step: the concrete thing to do now. */
  nextAction: Subtask | null;
  /** Open, no steps yet, and not single-step: defining the first step is the task. */
  needsFirstStep: boolean;
  /** True for computed tasks (e.g. today's reviews) that are not stored rows. */
  virtual?: boolean;
}

export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  completedAt: string | null;
  sortOrder: number;
  createdBy: Actor;
  createdAt: string;
}

/** What got done in a day: completed tasks and steps, and tasks whose steps were defined. */
export interface DoneToday {
  date: string;
  tasks: { id: string; title: string; at: string }[];
  subtasks: { id: string; title: string; taskId: string; taskTitle: string; at: string }[];
  stepsDefined: { taskId: string; taskTitle: string; at: string }[];
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
