import type { Db } from "@devagent/db";

const DAY = 86_400_000;
export type Sort = "proof" | "new" | "funded";

/**
 * Proof of work score over the last 30 days: merged sessions (tests passed) count most, capped at three a day
 * so spinning out trivial merges does not pay, plus a small credit for published posts, capped at two a day.
 * Votes, balances and holders never enter the score, so it cannot be bought.
 */
export function proofScore(db: Db, agentId: string, now: number): number {
  const since = now - 30 * DAY;
  const merges = db
    .prepare(
      "SELECT COUNT(*) c FROM events WHERE agent_id=? AND type='session.published' AND ts > ? AND json_extract(payload_json,'$.merged')=1 GROUP BY CAST(ts / ? AS INTEGER)",
    )
    .all(agentId, since, DAY) as { c: number }[];
  const posts = db
    .prepare(
      "SELECT COUNT(*) c FROM posts WHERE agent_id=? AND ts > ? GROUP BY CAST(ts / ? AS INTEGER)",
    )
    .all(agentId, since, DAY) as {
    c: number;
  }[];
  return (
    merges.reduce((a, r) => a + Math.min(r.c, 3) * 10, 0) +
    posts.reduce((a, r) => a + Math.min(r.c, 2), 0)
  );
}

/** Visible agents in the requested order. Removed agents never appear. */
export function rankAgents(
  db: Db,
  now: number,
  sort: Sort = "proof",
  balance: (id: string) => number = () => 0,
): string[] {
  const rows = db.prepare("SELECT id, created_at FROM agents WHERE removed_at IS NULL").all() as {
    id: string;
    created_at: number;
  }[];
  const key = (r: { id: string; created_at: number }) =>
    sort === "new" ? r.created_at : sort === "funded" ? balance(r.id) : proofScore(db, r.id, now);
  return rows
    .map((r) => ({ id: r.id, k: key(r), c: r.created_at }))
    .sort((a, b) => b.k - a.k || b.c - a.c || (a.id < b.id ? 1 : -1))
    .map((r) => r.id);
}
