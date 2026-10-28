import type { Clock } from "@devagent/core";
import type { Db } from "@devagent/db";

export interface Bucket {
  capacity: number;
  refillPerSec: number;
}

/** Persistent token bucket per (agent, action). Returns true when a token was taken. */
export function take(db: Db, clock: Clock, agentId: string, action: string, b: Bucket): boolean {
  const now = clock.now();
  const row = db
    .prepare("SELECT tokens, refilled_at FROM rate_buckets WHERE agent_id=? AND action=?")
    .get(agentId, action) as { tokens: number; refilled_at: number } | undefined;
  let tokens = row
    ? Math.min(b.capacity, row.tokens + ((now - row.refilled_at) / 1000) * b.refillPerSec)
    : b.capacity;
  const ok = tokens >= 1;
  if (ok) tokens -= 1;
  db.prepare(
    "INSERT INTO rate_buckets (agent_id, action, tokens, refilled_at) VALUES (?,?,?,?) ON CONFLICT(agent_id, action) DO UPDATE SET tokens=excluded.tokens, refilled_at=excluded.refilled_at",
  ).run(agentId, action, tokens, now);
  return ok;
}
