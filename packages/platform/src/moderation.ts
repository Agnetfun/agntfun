import { ulid, type Clock } from "@devagent/core";
import { appendEvent, type Db } from "@devagent/db";
import type { KillSwitch } from "@devagent/safety";

export const REPORT_REASONS = [
  "scam",
  "harmful_content",
  "impersonation",
  "spam",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface ModerationPolicy {
  /** Open reports within a day that pause an agent until an operator looks. */
  autoPauseAt: number;
}
export const DEFAULT_MODERATION: ModerationPolicy = { autoPauseAt: 5 };

export class ModerationError extends Error {}

export function reportAgent(
  db: Db,
  clock: Clock,
  kill: KillSwitch,
  r: { agentId: string; reason: string; detail?: string },
  policy: ModerationPolicy = DEFAULT_MODERATION,
): { ok: true; paused: boolean } | { ok: false; reason: string } {
  if (!(REPORT_REASONS as readonly string[]).includes(r.reason))
    return { ok: false, reason: "Pick a reason from the list." };
  const detail = String(r.detail ?? "").slice(0, 500);
  const a = db.prepare("SELECT removed_at FROM agents WHERE id=?").get(r.agentId) as
    { removed_at: number | null } | undefined;
  if (!a || a.removed_at) return { ok: false, reason: "Agent not found." };
  db.prepare("INSERT INTO reports (id, agent_id, ts, reason, detail) VALUES (?,?,?,?,?)").run(
    ulid(clock.now()),
    r.agentId,
    clock.now(),
    r.reason,
    detail,
  );
  const open = db
    .prepare("SELECT COUNT(*) c FROM reports WHERE agent_id=? AND status='open' AND ts > ?")
    .get(r.agentId, clock.now() - 86_400_000) as { c: number };
  let paused = false;
  if (open.c >= policy.autoPauseAt && !kill.isHalted(r.agentId)) {
    kill.trip(r.agentId, "auto", `${open.c} open reports in 24 hours`);
    paused = true;
  }
  return { ok: true, paused };
}

function assertOperator(operators: string[], id: string) {
  if (!id || !operators.includes(id)) throw new ModerationError("not an operator");
}

/** Hides the agent everywhere, stops it, and closes its open reports as actioned. */
export function takedown(
  db: Db,
  clock: Clock,
  kill: KillSwitch,
  operators: string[],
  agentId: string,
  operatorId: string,
  reason: string,
): void {
  assertOperator(operators, operatorId);
  db.prepare("UPDATE agents SET removed_at=?, removed_reason=? WHERE id=?").run(
    clock.now(),
    reason.slice(0, 200),
    agentId,
  );
  db.prepare("UPDATE reports SET status='actioned' WHERE agent_id=? AND status='open'").run(
    agentId,
  );
  kill.trip(agentId, operatorId, `takedown: ${reason}`.slice(0, 200));
  appendEvent(db, clock, {
    type: "moderation.takedown",
    agentId,
    payload: { operatorId, reason: reason.slice(0, 200) },
  });
}

export function restore(
  db: Db,
  clock: Clock,
  kill: KillSwitch,
  operators: string[],
  agentId: string,
  operatorId: string,
): void {
  assertOperator(operators, operatorId);
  db.prepare("UPDATE agents SET removed_at=NULL, removed_reason=NULL WHERE id=?").run(agentId);
  kill.clear(agentId, operatorId);
  appendEvent(db, clock, { type: "moderation.restore", agentId, payload: { operatorId } });
}

export function dismissReports(
  db: Db,
  operators: string[],
  agentId: string,
  operatorId: string,
): void {
  assertOperator(operators, operatorId);
  db.prepare("UPDATE reports SET status='dismissed' WHERE agent_id=? AND status='open'").run(
    agentId,
  );
}
