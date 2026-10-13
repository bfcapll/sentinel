import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';
import { Repos } from './repos.js';

export type Db = Database.Database;

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function migrate(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
  );
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Math.floor(Date.now() / 1000),
      );
    })();
    count++;
  }
  return count;
}

/** The store: one SQLite file, WAL mode, typed repositories, one-writer transactions. */
export class Store {
  readonly repos: Repos;

  constructor(readonly db: Db) {
    this.repos = new Repos(db);
  }

  static open(file: string): Store {
    const db = openDb(file);
    migrate(db);
    return new Store(db);
  }

  /** Run `fn` in one transaction; throws roll everything back. Nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.db.inTransaction) return fn();
    return this.db.transaction(fn)();
  }

  /** Consistent online backup (safe under WAL while the service is running). */
  async backupTo(dest: string): Promise<void> {
    mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    await this.db.backup(dest);
  }

  close(): void {
    this.db.close();
  }
}
