import type { Db } from '../db.ts';
import type { Embedder } from './embeddings.ts';

export interface Ctx {
  db: Db;
  embedder: Embedder | null;
  /** Called inside the saving transaction after a note is created or updated. */
  onNoteSaved: ((noteId: string) => void)[];
  /** Called after a write that changes searchable text (used to kick the embedding queue). */
  onIndexNeeded: (() => void)[];
}
