/**
 * `node:sqlite` (`DatabaseSync`, built into Node >= 22.5 — zero native addons)
 * wrapper: opens the database in WAL mode with foreign keys enabled and applies
 * SQL migrations from `./migrations` (copied next to `dist/server.mjs` by `build.mjs`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

function migrationsDir(): string {
  const candidates = [
    new URL('./migrations/', import.meta.url),
    new URL('./db/migrations/', import.meta.url),
  ];
  for (const url of candidates) {
    const p = fileURLToPath(url);
    if (existsSync(p)) return p;
  }
  throw new Error('[minipod:db] migrations directory not found');
}

export function loadMigrations(dir: string = migrationsDir()): Migration[] {
  return readdirSync(dir)
    .map((file) => /^(\d+)_(.+)\.sql$/.exec(file))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      version: Number(m[1]),
      name: m[2] ?? '',
      sql: readFileSync(`${dir}/${m[0]}`, 'utf8'),
    }))
    .sort((a, b) => a.version - b.version);
}

export function migrate(db: Database, migrations: readonly Migration[] = loadMigrations()): number[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  );
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );
  const done: number[] = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
      db.exec('COMMIT');
      done.push(m.version);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return done;
}

export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

let savepointCounter = 0;

/**
 * Atomic transaction helper using SQLite `SAVEPOINT` so nested calls never
 * fail with `cannot start a transaction within a transaction`.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  const name = `minipod_sp_${++savepointCounter}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      // ignore secondary rollback failure
    }
    throw error;
  }
}
