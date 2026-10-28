import type { Clock } from "@devagent/core";
import { upsertTask, type Db } from "@devagent/db";

export interface Ranked {
  id: string;
  summary: string;
  size: string | null;
  score: number;
  voters: number;
}

/** Accepted suggestions ordered by total vote weight, then by arrival. Only the triaged summary is exposed. */
export function rankQueue(db: Db, agentId: string): Ranked[] {
  return (
    db
      .prepare(
        `SELECT s.id, s.summary, s.size, COALESCE(SUM(v.weight),0) AS score, COUNT(v.id) AS voters
         FROM suggestions s LEFT JOIN votes v ON v.suggestion_id = s.id
         WHERE s.agent_id=? AND s.status IN ('accepted','queued')
         GROUP BY s.id ORDER BY score DESC, s.received_at, s.id`,
      )
      .all(agentId) as {
      id: string;
      summary: string;
      size: string | null;
      score: number;
      voters: number;
    }[]
  ).map((r) => ({ ...r }));
}

/** Turns the top voted suggestions into agent tasks. Unvoted suggestions are never promoted. */
export function promoteTop(db: Db, clock: Clock, agentId: string, n: number): number {
  let promoted = 0;
  for (const r of rankQueue(db, agentId)
    .filter((x) => x.score > 0)
    .slice(0, n)) {
    const inserted = upsertTask(db, clock, {
      agentId,
      source: "proposal",
      summary: r.summary,
      size: r.size ?? undefined,
      priority: Math.max(1, Math.round(r.score / 1000)),
    });
    db.prepare("UPDATE suggestions SET status='queued' WHERE id=?").run(r.id);
    if (inserted) promoted++;
  }
  return promoted;
}
