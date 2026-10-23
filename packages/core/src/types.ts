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
  /** How often its due date has been moved while it was open ("keeps getting moved"). */
  timesRescheduled: number;
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

export const SESSION_KINDS = ['starter', 'focus'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
export type SessionOutcome = 'completed' | 'stopped' | 'continued' | 'abandoned';

/** A timed work session: a short starter ("just 10 minutes") or a focus block followed by a real break. */
export interface Session {
  id: string;
  kind: SessionKind;
  taskId: string | null;
  subtaskId: string | null;
  taskTitle: string | null;
  subtaskTitle: string | null;
  plannedMinutes: number;
  breakMinutes: number;
  startedAt: string;
  /** When the planned time runs out. */
  endsAt: string;
  endedAt: string | null;
  /** null while running. */
  outcome: SessionOutcome | null;
  actualMinutes: number | null;
  continuedFrom: string | null;
  createdBy: Actor;
  /** Steps ticked off while this session was running. */
  subtasksCompleted: { id: string; title: string }[];
}

/** The live timer state: a running session, or a break after a finished focus block. */
export interface SessionState {
  running: Session | null;
  onBreak: { until: string; after: Session } | null;
}

export const STARTER_QUESTION = 'Keep going? Stopping here counts.';

/** What got done in a day: completed tasks and steps, and tasks whose steps were defined. */
export interface DoneToday {
  date: string;
  tasks: { id: string; title: string; at: string }[];
  subtasks: { id: string; title: string; taskId: string; taskTitle: string; at: string }[];
  stepsDefined: { taskId: string; taskTitle: string; at: string }[];
  /** Starter sessions and focus blocks that weren't abandoned. */
  sessions: { id: string; kind: SessionKind; taskTitle: string | null; minutes: number; outcome: SessionOutcome; at: string }[];
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

export const ROUTINE_ACTIONS = ['wake', 'start_first_task'] as const;
export type RoutineAction = (typeof ROUTINE_ACTIONS)[number];

/** One line of the morning routine template. */
export interface RoutineItem {
  id: string;
  title: string;
  optional: boolean;
  /** wake: ticking it logs the wake time. start_first_task: ticked by the first session of the day. */
  action: RoutineAction | null;
  sortOrder: number;
}

export const DEFAULT_MORNING_ROUTINE: { title: string; optional?: boolean; action?: RoutineAction }[] = [
  { title: 'Stand up', action: 'wake' },
  { title: 'Lights on / curtains open' },
  { title: 'Exercise', optional: true },
  { title: 'Short shower' },
  { title: 'Simple breakfast' },
  { title: 'Start first task', action: 'start_first_task' },
];

/** A day (rolling over at 4am): its morning, the plan made the evening before, and its shutdown. */
export interface Day {
  date: string;
  wakeAt: string | null;
  /** When work started: the first session of the day, or typed in. */
  workStartAt: string | null;
  workStartSessionId: string | null;
  /** Minutes from waking to starting work, when both are known. */
  wakeToWorkMinutes: number | null;
  /** "HH:MM", optional. */
  targetStart: string | null;
  plannedAt: string | null;
  plannedBy: Actor | null;
  /** The one task to start with, and its first step: the planned step while it's open, else the task's next action. */
  firstThing: { task: Task; step: Subtask | null } | null;
  shutdownAt: string | null;
  rating: number | null;
  reflection: string | null;
  routine: (RoutineItem & { checkedAt: string | null })[];
}

export const PLAN_STEP_PROMPT = "What's the first physical step, small enough to start half-awake?";

export const MINIMUM_KINDS = ['sessions', 'focus_minutes', 'steps'] as const;
export type MinimumKind = (typeof MINIMUM_KINDS)[number];
/** The daily minimum: a deliberately low bar (default: start one session of any length). */
export interface DailyMinimum {
  kind: MinimumKind;
  value: number;
}

export function describeMinimum(m: DailyMinimum): string {
  if (m.kind === 'sessions') return m.value === 1 ? 'Start one session (any length)' : `Start ${m.value} sessions`;
  if (m.kind === 'focus_minutes') return `${m.value} minutes of focused work`;
  return m.value === 1 ? 'Finish or define one step' : `Finish or define ${m.value} steps`;
}

/** What a day counted toward its minimum. Steps = steps ticked + tasks completed + tasks whose steps were defined. */
export interface DayMeasure {
  sessions: number;
  focusMinutes: number;
  steps: number;
}

export interface ChainDay {
  date: string;
  met: boolean;
  /** Frozen with the rule in force on the day, rather than worked out with today's rule. */
  frozen: boolean;
  measure: DayMeasure;
  rating: number | null;
}

export interface Chain {
  minimum: DailyMinimum;
  /** Oldest first, ending today. */
  days: ChainDay[];
  /** Consecutive days meeting the minimum, up to today (today still counts as open until it's met). */
  current: number;
  todayMet: boolean;
}

/** Momentum statistics over a window of days. Descriptive only: every figure carries its sample size. */
export interface MomentumStats {
  from: string;
  to: string;
  days: number;
  perDay: { date: string; focusMinutes: number; sessions: number; met: boolean; wakeAt: string | null; workStartAt: string | null; rating: number | null }[];
  perWeek: { weekStart: string; focusMinutes: number; daysWithFocus: number }[];
  /** Starter sessions and focus blocks: how many were started and how they ended. */
  starters: { started: number; keptGoing: number; stopped: number; abandoned: number };
  blocks: { started: number; completed: number; stopped: number; abandoned: number };
  /** Minutes from waking to the first session, over days with both logged. */
  wakeToWork: { n: number; median: number | null; min: number | null; max: number | null };
  /** Average day rating grouped by when work started. */
  ratingByStart: { bucket: string; n: number; avgRating: number | null }[];
  daysMet: number;
  ratedDays: number;
}

/** What happened to a task over time: moves, sessions on it, when its steps were defined. */
export interface TaskHistory {
  taskId: string;
  createdAt: string;
  rescheduled: { from: string | null; to: string | null; at: string; by: Actor }[];
  sessions: { count: number; minutes: number; lastAt: string | null };
  stepsDefinedAt: string | null;
}

/** One line per day for reviews: the morning, the plan, the minimum, what got done, the rating. */
export interface DayLogEntry {
  date: string;
  wakeAt: string | null;
  workStartAt: string | null;
  wakeToWorkMinutes: number | null;
  firstThing: { task: string; step: string | null; taskStatus: Task['status'] } | null;
  targetStart: string | null;
  /** The first session of the day was on the planned first task. */
  startedOnFirstThing: boolean | null;
  minimumMet: boolean;
  measure: DayMeasure;
  done: { tasks: string[]; steps: string[]; stepsDefined: string[] };
  rating: number | null;
  reflection: string | null;
  shutdown: boolean;
}
