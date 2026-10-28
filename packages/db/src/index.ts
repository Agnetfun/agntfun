import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ulid, type Clock } from "@devagent/core";
import { MIGRATIONS } from "./migrations";

export type Db = DatabaseSync;
export { MIGRATIONS };
export * from "./repos";

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

/** Applies pending migrations in order. Returns the versions applied this call. */
export function migrate(db: Db, clock: Clock): number[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const done = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version as number),
  );
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        clock.now(),
      );
      db.exec("COMMIT");
      applied.push(m.version);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return applied;
}

export interface NewEvent {
  type: string;
  agentId?: string;
  sessionId?: string;
  payload?: unknown;
}

export function appendEvent(db: Db, clock: Clock, e: NewEvent): string {
  const id = ulid(clock.now());
  db.prepare(
    "INSERT INTO events (id, agent_id, session_id, ts, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    e.agentId ?? null,
    e.sessionId ?? null,
    clock.now(),
    e.type,
    JSON.stringify(e.payload ?? {}),
  );
  return id;
}
