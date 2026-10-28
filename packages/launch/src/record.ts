import type { Clock } from "@devagent/core";
import type { Db } from "@devagent/db";
import type { Share } from "./split";

export interface LaunchRow {
  agentId: string;
  mint: string;
  cluster: string;
  signature: string;
  split: Share[];
  launchedAt: number;
}

export function recordLaunch(db: Db, clock: Clock, l: Omit<LaunchRow, "launchedAt">): void {
  db.prepare(
    "INSERT INTO launches (agent_id, mint, cluster, signature, split_json, launched_at) VALUES (?,?,?,?,?,?)",
  ).run(l.agentId, l.mint, l.cluster, l.signature, JSON.stringify(l.split), clock.now());
}

export function getLaunch(db: Db, agentId: string): LaunchRow | undefined {
  const r = db.prepare("SELECT * FROM launches WHERE agent_id=?").get(agentId) as
    | {
        agent_id: string;
        mint: string;
        cluster: string;
        signature: string;
        split_json: string;
        launched_at: number;
      }
    | undefined;
  return (
    r && {
      agentId: r.agent_id,
      mint: r.mint,
      cluster: r.cluster,
      signature: r.signature,
      split: JSON.parse(r.split_json) as Share[],
      launchedAt: r.launched_at,
    }
  );
}
