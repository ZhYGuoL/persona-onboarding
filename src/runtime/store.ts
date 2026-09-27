// SQLite persistence: one row of state per session plus an append-only event log.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboxState, SessionState } from "../brain/types.ts";

export type LogDir = "in" | "out" | "note";

export interface LogEntry {
  seq: number;
  ts: number;
  dir: LogDir;
  type: string;
  payload: unknown;
}

export interface SessionRow {
  state: SessionState;
  clockOffsetMs: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      pragma journal_mode = wal;
      pragma synchronous = normal;
      create table if not exists sessions (
        id text primary key,
        created_at integer not null,
        updated_at integer not null,
        clock_offset integer not null default 0,
        state text not null
      );
      create table if not exists events (
        session_id text not null,
        seq integer not null,
        ts integer not null,
        dir text not null,
        type text not null,
        payload text not null,
        primary key (session_id, seq)
      );
    `);
  }

  load(id: string): SessionRow | null {
    const row = this.db.prepare("select state, clock_offset from sessions where id = ?").get(id) as
      | { state: string; clock_offset: number }
      | undefined;
    if (!row) return null;
    const state = JSON.parse(row.state) as SessionState;
    // Sessions saved by an older build lack newer inbox fields.
    state.inbox = {
      source: null,
      scanning: false,
      scannedAt: null,
      findings: [],
      failures: 0,
      ...(state.inbox as Partial<InboxState> | undefined),
    };
    return { state, clockOffsetMs: row.clock_offset };
  }

  save(state: SessionState, clockOffsetMs: number, now: number): void {
    this.db
      .prepare(
        `insert into sessions (id, created_at, updated_at, clock_offset, state) values (?, ?, ?, ?, ?)
         on conflict(id) do update set updated_at = excluded.updated_at,
           clock_offset = excluded.clock_offset, state = excluded.state`,
      )
      .run(state.id, state.createdAt, now, clockOffsetMs, JSON.stringify(state));
  }

  append(sessionId: string, entry: Omit<LogEntry, "seq">): LogEntry {
    const last = this.db
      .prepare("select max(seq) as seq from events where session_id = ?")
      .get(sessionId) as { seq: number | null };
    const seq = (last.seq ?? 0) + 1;
    this.db
      .prepare(
        "insert into events (session_id, seq, ts, dir, type, payload) values (?, ?, ?, ?, ?, ?)",
      )
      .run(sessionId, seq, entry.ts, entry.dir, entry.type, JSON.stringify(entry.payload ?? null));
    return { seq, ...entry };
  }

  events(sessionId: string, afterSeq = 0): LogEntry[] {
    const rows = this.db
      .prepare(
        "select seq, ts, dir, type, payload from events where session_id = ? and seq > ? order by seq",
      )
      .all(sessionId, afterSeq) as Array<{
      seq: number;
      ts: number;
      dir: LogDir;
      type: string;
      payload: string;
    }>;
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  /** Sessions with armed timers, so a restart can re-arm them. */
  sessionsWithTimers(): string[] {
    const rows = this.db
      .prepare("select id from sessions where json_extract(state, '$.timers') != '{}'")
      .all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  close(): void {
    this.db.close();
  }
}
