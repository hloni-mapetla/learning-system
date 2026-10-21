// Input schemas shared by the REST API and MCP tools. Patch schemas carry no defaults on purpose.
import { z } from 'zod';
import { CARD_TYPES, NOTE_KINDS, RATINGS, SOURCE_KINDS, SOURCE_METHODS, SOURCE_STATUSES, TASK_KINDS, TYPED_LINK_RELS } from './types.ts';

const actor = z.enum(['user', 'claude', 'system']);

const priority = z.number().int().min(1).max(5);
const tags = z.array(z.string().min(1));

export const SourceCreate = z.object({
  kind: z.enum(SOURCE_KINDS).optional(),
  title: z.string().trim().min(1),
  authors: z.string().optional(),
  url: z.string().nullish(),
  published: z.string().nullish(),
  status: z.enum(SOURCE_STATUSES).optional(),
  priority: priority.optional(),
  description: z.string().optional(),
  startedAt: z.string().nullish(),
  finishedAt: z.string().nullish(),
  method: z.enum(SOURCE_METHODS).nullish(),
  tags: tags.optional(),
});
export const SourcePatch = SourceCreate.partial();
export type SourceCreate = z.infer<typeof SourceCreate>;
export type SourcePatch = z.infer<typeof SourcePatch>;

export const NoteCreate = z.object({
  kind: z.enum(NOTE_KINDS).optional(),
  title: z.string().trim().optional(),
  body: z.string().optional(),
  quote: z.string().nullish(),
  location: z.string().nullish(),
  sourceId: z.string().nullish(),
  aliases: z.array(z.string()).optional(),
  tags: tags.optional(),
  dedupeKey: z.string().nullish(),
});
/** createdBy is patchable so the learner can correct authorship (e.g. after the v3 backfill). */
export const NotePatch = NoteCreate.omit({ dedupeKey: true }).partial().extend({ createdBy: actor.optional() });
export type NoteCreate = z.infer<typeof NoteCreate>;
export type NotePatch = z.infer<typeof NotePatch>;

export const ItemRefInput = z.object({ type: z.enum(['note', 'source']), id: z.string().min(1) });
export type ItemRefInput = z.infer<typeof ItemRefInput>;

export const LinkCreate = z.object({
  from: ItemRefInput,
  to: ItemRefInput,
  rel: z.enum(TYPED_LINK_RELS),
  rationale: z.string().nullish(),
});
export type LinkCreate = z.infer<typeof LinkCreate>;

export const CardCreate = z.object({
  type: z.enum(CARD_TYPES),
  front: z.string().trim().min(1),
  back: z.string().optional(),
  rubric: z.string().nullish(),
  refs: z.array(ItemRefInput).optional(),
  tags: tags.optional(),
});
export const CardPatch = z.object({
  front: z.string().trim().min(1).optional(),
  back: z.string().optional(),
  rubric: z.string().nullish(),
  suspended: z.boolean().optional(),
  tags: tags.optional(),
  refs: z.array(ItemRefInput).optional(),
});
export type CardCreate = z.infer<typeof CardCreate>;
export type CardPatch = z.infer<typeof CardPatch>;

export const RatingInput = z.union([z.enum(RATINGS), z.number().int().min(1).max(4)]);
export type RatingInput = z.infer<typeof RatingInput>;

export const TaskCreate = z.object({
  title: z.string().trim().min(1),
  kind: z.enum(TASK_KINDS).optional(),
  details: z.string().optional(),
  sourceId: z.string().nullish(),
  noteId: z.string().nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  priority: priority.optional(),
  singleStep: z.boolean().optional(),
});
export const TaskPatch = TaskCreate.partial().extend({
  status: z.enum(['open', 'done', 'cancelled']).optional(),
  sortOrder: z.number().optional(),
});
export const SubtaskCreate = z.object({
  title: z.string().trim().min(1),
  /** Insert before this index (0 = first); default appends. */
  position: z.number().int().min(0).optional(),
});
export const SubtaskPatch = z.object({
  title: z.string().trim().min(1).optional(),
  done: z.boolean().optional(),
});
export type TaskCreate = z.infer<typeof TaskCreate>;
export type SubtaskCreate = z.infer<typeof SubtaskCreate>;
export type SubtaskPatch = z.infer<typeof SubtaskPatch>;
export type TaskPatch = z.infer<typeof TaskPatch>;
