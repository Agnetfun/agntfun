import { createHash } from "node:crypto";
import { ulid, type AgentState, type Clock, type ModelChoice } from "@devagent/core";
import type { Db } from "./index";

type Row = Record<string, unknown>;

export interface AgentRow {
  id: string;
  name: string;
  state: AgentState;
  repo: string | null;
  xHandle: string | null;
  promptHash: string | null;
  model: ModelChoice;
  lockedPrompt: string;
  createdAt: number;
}

const toAgent = (r: Row): AgentRow => ({
  id: r.id as string,
  name: r.name as string,
  state: r.state as AgentState,
  repo: (r.repo as string | null) ?? null,
  xHandle: (r.x_handle as string | null) ?? null,
  promptHash: (r.prompt_hash as string | null) ?? null,
  model: r.model as ModelChoice,
  lockedPrompt: r.locked_prompt as string,
  createdAt: r.created_at as number,
});

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function createAgent(
  db: Db,
  clock: Clock,
  a: { name: string; model: ModelChoice; lockedPrompt: string; repo?: string; xHandle?: string },
): AgentRow {
  const id = ulid(clock.now());
  db.prepare(
    "INSERT INTO agents (id, name, repo, x_handle, prompt_hash, model, locked_prompt, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    id,
    a.name,
    a.repo ?? null,
    a.xHandle ?? null,
    sha256(a.lockedPrompt),
    a.model,
    a.lockedPrompt,
    clock.now(),
  );
  return getAgent(db, id)!;
}

export function getAgent(db: Db, id: string): AgentRow | undefined {
  const r = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
  return r && toAgent(r);
}

export function listAgents(db: Db): AgentRow[] {
  return (db.prepare("SELECT * FROM agents ORDER BY created_at, id").all() as Row[]).map(toAgent);
}

export function setAgentState(db: Db, id: string, state: AgentState): void {
  db.prepare("UPDATE agents SET state = ? WHERE id = ?").run(state, id);
}

export function startSession(
  db: Db,
  clock: Clock,
  agentId: string,
  taskRef: string | null,
): string {
  const id = ulid(clock.now());
  db.prepare("INSERT INTO sessions (id, agent_id, started_at, task_ref) VALUES (?,?,?,?)").run(
    id,
    agentId,
    clock.now(),
    taskRef,
  );
  return id;
}

export interface SessionEnd {
  endReason: string;
  summary: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
}

export function endSession(db: Db, clock: Clock, id: string, e: SessionEnd): void {
  db.prepare(
    "UPDATE sessions SET ended_at=?, end_reason=?, summary=?, tokens_in=?, tokens_out=?, cost_cents=? WHERE id=?",
  ).run(clock.now(), e.endReason, e.summary, e.tokensIn, e.tokensOut, e.costCents, id);
}

export interface LlmCallRecord {
  sessionId: string | null;
  agentId: string | null;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  latencyMs: number;
}

export function insertLlmCall(db: Db, clock: Clock, c: LlmCallRecord): void {
  db.prepare(
    "INSERT INTO llm_calls (id, session_id, agent_id, ts, provider, model, tokens_in, tokens_out, cost_micro_usd, latency_ms) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(
    ulid(clock.now()),
    c.sessionId,
    c.agentId,
    clock.now(),
    c.provider,
    c.model,
    c.tokensIn,
    c.tokensOut,
    c.costMicroUsd,
    c.latencyMs,
  );
}

export interface TaskRow {
  id: string;
  agentId: string;
  source: "file" | "proposal";
  summary: string;
  size: string | null;
  priority: number;
  status: "open" | "done" | "blocked";
}

const toTask = (r: Row): TaskRow => ({
  id: r.id as string,
  agentId: r.agent_id as string,
  source: r.source as TaskRow["source"],
  summary: r.summary as string,
  size: (r.size as string | null) ?? null,
  priority: r.priority as number,
  status: r.status as TaskRow["status"],
});

/** Returns true when a new row was inserted. */
export function upsertTask(
  db: Db,
  clock: Clock,
  t: {
    agentId: string;
    source: "file" | "proposal";
    summary: string;
    size?: string;
    priority?: number;
  },
): boolean {
  const r = db
    .prepare(
      "INSERT OR IGNORE INTO tasks (id, agent_id, source, summary, size, priority, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      ulid(clock.now()),
      t.agentId,
      t.source,
      t.summary,
      t.size ?? null,
      t.priority ?? 0,
      clock.now(),
    );
  return Number(r.changes) > 0;
}

export function pickTask(db: Db, agentId: string): TaskRow | undefined {
  const r = db
    .prepare(
      "SELECT * FROM tasks WHERE agent_id=? AND status='open' ORDER BY priority DESC, created_at, id LIMIT 1",
    )
    .get(agentId) as Row | undefined;
  return r && toTask(r);
}

export function markTaskDone(db: Db, clock: Clock, id: string): void {
  db.prepare("UPDATE tasks SET status='done', done_at=? WHERE id=?").run(clock.now(), id);
}
