import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Params = Record<string, unknown> | unknown[] | undefined;
export type Row = Record<string, any>;

/** Thin wrapper over node:sqlite: statement cache, param normalisation, nested transactions. */
export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  #cache = new Map<string, StatementSync>();
  #txDepth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    migrate(this);
  }

  #stmt(sql: string): StatementSync {
    let s = this.#cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.#cache.set(sql, s);
    }
    return s;
  }

  all<T = Row>(sql: string, params?: Params): T[] {
    return bind(this.#stmt(sql), 'all', params) as T[];
  }
  get<T = Row>(sql: string, params?: Params): T | undefined {
    return bind(this.#stmt(sql), 'get', params) as T | undefined;
  }
  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
    const r = bind(this.#stmt(sql), 'run', params) as { changes: number | bigint; lastInsertRowid: number | bigint };
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Runs fn in a transaction (BEGIN IMMEDIATE so concurrent writers queue instead of failing). */
  tx<T>(fn: () => T): T {
    if (this.#txDepth > 0) {
      this.#txDepth++;
      try { return fn(); } finally { this.#txDepth--; }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.#txDepth = 1;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.#txDepth = 0;
    }
  }

  /** Increments whenever any connection commits; used to tell the UI that data changed. */
  dataVersion(): number {
    return Number((this.raw.prepare('PRAGMA data_version').get() as Row).data_version);
  }

  close(): void {
    this.raw.close();
  }
}

function norm(v: unknown): SQLInputValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Float32Array) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v as SQLInputValue;
}

const paramNames = new WeakMap<StatementSync, Set<string>>();

/** Named parameters a statement actually uses (node:sqlite rejects unknown ones, which makes shared param objects awkward). */
function namesOf(s: StatementSync): Set<string> {
  let names = paramNames.get(s);
  if (!names) {
    names = new Set([...s.sourceSQL.matchAll(/[:@$]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
    paramNames.set(s, names);
  }
  return names;
}

function bind(s: StatementSync, method: 'all' | 'get' | 'run', params: Params): unknown {
  if (params === undefined) return s[method]();
  if (Array.isArray(params)) return s[method](...params.map(norm));
  const used = namesOf(s);
  const named: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(params)) if (used.has(k)) named[k] = norm(v);
  return s[method](named);
}

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

function migrate(db: Db): void {
  const current = Number((db.raw.prepare('PRAGMA user_version').get() as Row).user_version);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files) {
    const version = parseInt(f, 10);
    if (version <= current) continue;
    db.tx(() => {
      db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
}
