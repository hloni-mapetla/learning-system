import { homedir } from 'node:os';
import { join } from 'node:path';
import { Db, type DbOptions } from './db.ts';
import type { Ctx } from './services/context.ts';
import { createTags } from './services/tags.ts';
import { createLinks } from './services/links.ts';
import { createSources } from './services/sources.ts';
import { createNotes } from './services/notes.ts';
import { createSearch } from './services/search.ts';
import { drainEmbedQueue, enqueueAll, pendingEmbeddings, transformersEmbedder, VectorIndex, type Embedder } from './services/embeddings.ts';
import { createSettings } from './services/settings.ts';
import { createCards } from './services/cards.ts';
import { createReview } from './services/review.ts';
import { createTopics } from './services/topics.ts';
import { createRelated } from './services/related.ts';
import { createStudy } from './services/study.ts';
import { createTasks } from './services/tasks.ts';
import { createSubtasks } from './services/subtasks.ts';
import { createSessions } from './services/sessions.ts';
import { createDays } from './services/days.ts';
import { createMomentum } from './services/momentum.ts';
import { createPractice } from './services/practice.ts';
import { createGraph } from './services/graph.ts';
import { createStats } from './services/stats.ts';
import { createImporter } from './services/importer.ts';
import { createExporter } from './services/exporter.ts';
import { createProcessing } from './services/processing.ts';
import type { NoteDetail, SourceDetail } from './types.ts';

export * from './types.ts';
export * as schemas from './schemas.ts';
export { Db } from './db.ts';
export { NotFoundError, ValidationError, localDate, momentumDay, DAY_ROLLOVER_HOUR, addDays, atLocalTime, resolveDay } from './util.ts';
export { transformersEmbedder, type Embedder } from './services/embeddings.ts';
export { parseWikilinks } from './services/wikilinks.ts';
export { humanInterval } from './services/review.ts';
export type { Settings } from './services/settings.ts';
export type { TopicMatch } from './services/topics.ts';
export type { SimilarItem } from './services/related.ts';
export type { StudyContext } from './services/study.ts';
export type { GraphNode, GraphEdge } from './services/graph.ts';
export type { Stats, MasteryRow } from './services/stats.ts';
export type { ImportReport } from './services/importer.ts';
export { parseKindleClippings } from './importers/kindle.ts';
export { REVIEW_TASK_ID, type CompleteResult } from './services/tasks.ts';
export type { SubtaskResult, AddStepsResult } from './services/subtasks.ts';
export { STALE_AFTER_MINUTES, type StartSession } from './services/sessions.ts';
export { SHUTDOWN_HEADING, type PlanInput } from './services/days.ts';
export { REFLECTION_HEADING, meets } from './services/momentum.ts';
export type { RecallStatus, RecallComparison } from './services/processing.ts';
export type { PracticeSet, PracticeCard, ConfusablePair } from './services/practice.ts';
export { REVIEW_CONTEXTS, type ReviewContext } from './services/review.ts';

export interface LoomOptions {
  /** Path to the SQLite file. Defaults to $LOOM_DB or ~/.loom/loom.db. */
  dbPath?: string;
  /** Embedder for semantic search; `null` disables it. Defaults to local bge-small. */
  embedder?: Embedder | null;
  /** Migration options (tests). */
  db?: DbOptions;
}

export function defaultDataDir(): string {
  return process.env.LOOM_DATA_DIR ?? join(homedir(), '.loom');
}
export function defaultDbPath(): string {
  return process.env.LOOM_DB ?? join(defaultDataDir(), 'loom.db');
}

export function createLoom(opts: LoomOptions = {}) {
  const db = new Db(opts.dbPath ?? defaultDbPath(), opts.db);
  const embedder =
    opts.embedder === undefined ? transformersEmbedder({ cacheDir: join(defaultDataDir(), 'models') }) : opts.embedder;
  const ctx: Ctx = { db, embedder, onNoteSaved: [], onIndexNeeded: [] };

  const tags = createTags(ctx);
  const links = createLinks(ctx);
  const sources = createSources(ctx, tags, links);
  const notes = createNotes(ctx, tags, links);
  const index = new VectorIndex(db);
  const search = createSearch(ctx, index);
  const settings = createSettings(db);
  const cards = createCards(ctx, tags);
  const review = createReview(ctx, cards, settings);
  const topics = createTopics(ctx, search);
  const related = createRelated(ctx, links, search, index);
  const study = createStudy(ctx, cards, review, topics);
  const practice = createPractice(ctx, cards, topics, related, settings);
  const tasks = createTasks(ctx, review);
  const subtasks = createSubtasks(ctx, tasks);
  const sessions = createSessions(ctx, tasks, settings, notes);
  const days = createDays(ctx, tasks, subtasks, notes);
  const momentum = createMomentum(ctx, settings, notes, tasks, days);
  const graph = createGraph(ctx);
  const stats = createStats(ctx, cards, review);
  const importer = createImporter(ctx, sources, notes);
  const exporter = createExporter(ctx);
  const processing = createProcessing(ctx, sources, notes, index);
  cards.syncMissingClozes();

  const embeddings = {
    pending: () => pendingEmbeddings(db),
    /** Process queued embeddings now (no-op without an embedder). */
    drain: () => (embedder ? drainEmbedQueue(db, embedder) : Promise.resolve(0)),
    /** Queue everything not yet embedded with the current model. */
    reindexAll: () => (embedder ? enqueueAll(db, embedder.model) : 0),
  };

  function noteDetail(id: string): NoteDetail {
    const note = notes.get(id);
    return { ...note, ...links.forItem('note', id), cards: cards.list({ noteId: id, sort: 'created' }).items };
  }

  function sourceDetail(id: string): SourceDetail {
    const source = sources.get(id);
    return {
      ...source,
      notes: notes.list({ sourceId: id, sort: 'location', limit: 1000 }).items,
      ...links.forItem('source', id),
      cardCount: cards.countForItem('source', id),
      tasks: tasks.list({ sourceId: id, view: 'all_open' }),
      recallState: processing.stateOf(id),
    };
  }

  return {
    db,
    ctx,
    embedder,
    index,
    tags,
    links,
    sources,
    notes,
    search,
    settings,
    cards,
    review,
    topics,
    related,
    study,
    practice,
    tasks,
    subtasks,
    sessions,
    days,
    momentum,
    graph,
    stats,
    importer,
    exporter,
    processing,
    embeddings,
    noteDetail,
    sourceDetail,
    close: () => db.close(),
  };
}
export type Loom = ReturnType<typeof createLoom>;
