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

/**
 * How much support an idea needs before the agent builds it: enough distinct holders AND enough of the coin's supply.
 * Both together, so neither one whale nor a crowd of dust wallets can push an idea through alone.
 */
export interface Quorum {
  minVoters: number;
  /** Total vote weight (tokens held by the voters, in whole tokens). */
  minWeight: number;
}
/** pump.fun coins always have a supply of one billion tokens. */
export const COIN_SUPPLY = 1_000_000_000;
export const NO_QUORUM: Quorum = { minVoters: 1, minWeight: 0 };

export function quorumFromEnv(env: Record<string, string | undefined> = process.env): Quorum {
  const voters = Number(env.VOTE_MIN_VOTERS);
  const pct = Number(env.VOTE_MIN_SUPPLY_PCT);
  return {
    minVoters: Number.isFinite(voters) && voters >= 1 ? Math.floor(voters) : 3,
    minWeight: ((Number.isFinite(pct) && pct >= 0 ? pct : 1) / 100) * COIN_SUPPLY,
  };
}

export const meetsQuorum = (r: Pick<Ranked, "score" | "voters">, q: Quorum) =>
  r.score > 0 && r.voters >= q.minVoters && r.score >= q.minWeight;

/** Turns the top voted suggestions that reached the quorum into agent tasks. Unvoted suggestions are never promoted. */
export function promoteTop(db: Db, clock: Clock, agentId: string, n: number, quorum: Quorum = NO_QUORUM): number {
  let promoted = 0;
  for (const r of rankQueue(db, agentId)
    .filter((x) => meetsQuorum(x, quorum))
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
