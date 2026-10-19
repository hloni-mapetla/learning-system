import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Params = Record<string, unknown> | unknown[] | undefined;
export type Row = Record<string, any>;

export interface DbOptions {
  /** Stop migrating at this schema version (tests build old-schema fixtures with it). */
  migrateTo?: number;
  /** Where pre-migration backups go; defaults to <db dir>/backups. null disables them. */
  backupDir?: string | null;
}

/** Thin wrapper over node:sqlite: statement cache, param normalisation, nested transactions. */
export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  #cache = new Map<string, StatementSync>();
  #txDepth = 0;
  /** Path of the backup taken before this connection upgraded the schema, if it did. */
  migrationBackup: string | null = null;

  constructor(path: string, opts: DbOptions = {}) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    migrate(this, opts);
  }

  schemaVersion(): number {
    return Number((this.raw.prepare('PRAGMA user_version').get() as Row).user_version);
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

/**
 * Apply pending migrations. Each file runs in its own transaction with foreign keys OFF, so table rebuilds
 * (create new → copy → drop old → rename) can't cascade-delete cards or review history. Foreign keys are
 * re-checked before commit, and an existing database is snapshotted first.
 */
function migrate(db: Db, opts: DbOptions): void {
  const current = db.schemaVersion();
  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ file: f, version: parseInt(f, 10) }))
    .filter((m) => m.version > current && (opts.migrateTo === undefined || m.version <= opts.migrateTo));
  if (!pending.length) return;

  if (current > 0 && db.path !== ':memory:' && opts.backupDir !== null) {
    const dir = opts.backupDir ?? join(dirname(db.path), 'backups');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let file = join(dir, `pre-migration-v${current}-to-v${pending.at(-1)!.version}-${stamp}.db`);
    for (let i = 2; existsSync(file); i++) file = file.replace(/(-\d+)?\.db$/, `-${i}.db`);
    db.raw.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    db.migrationBackup = file;
  }

  db.raw.exec('PRAGMA foreign_keys = OFF'); // must be outside a transaction to take effect
  try {
    for (const m of pending) {
      db.tx(() => {
        db.exec(readFileSync(join(MIGRATIONS_DIR, m.file), 'utf8'));
        const broken = db.all('PRAGMA foreign_key_check');
        if (broken.length) throw new Error(`Migration ${m.file} left ${broken.length} broken foreign keys, e.g. ${JSON.stringify(broken[0])}`);
        db.exec(`PRAGMA user_version = ${m.version}`);
      });
    }
  } finally {
    db.raw.exec('PRAGMA foreign_keys = ON');
  }
}
