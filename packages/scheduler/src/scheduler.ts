import type { Clock } from "@devagent/core";
import { appendEvent, listAgents, setAgentState, type Db } from "@devagent/db";
import type { KillSwitch } from "@devagent/safety";
import type { Treasury } from "@devagent/treasury";

/** What one wake up does. Returns the money it spent so the scheduler can book it. */
export interface RunOutcome {
  sessionId: string | null;
  llmCents: number;
  postCents: number;
}
export type RunOnce = (agentId: string) => Promise<RunOutcome>;

export interface TickReport {
  ran: string[];
  skipped: Array<{ agentId: string; why: string }>;
}

/** Duty cycle: wake, run one short session, sleep until the next interval. Money and the kill switch decide every wake up. */
export class Scheduler {
  constructor(
    private db: Db,
    private clock: Clock,
    private treasury: Treasury,
    private kill: KillSwitch,
    private runOnce: RunOnce,
  ) {}

  schedule(agentId: string, intervalMs: number, firstWakeAt = this.clock.now()): void {
    this.db
      .prepare(
        "INSERT INTO agent_schedule (agent_id, interval_ms, next_wake_at) VALUES (?,?,?) ON CONFLICT(agent_id) DO UPDATE SET interval_ms=excluded.interval_ms",
      )
      .run(agentId, intervalMs, firstWakeAt);
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { ran: [], skipped: [] };
    const now = this.clock.now();
    for (const a of listAgents(this.db)) {
      const sch = this.db
        .prepare("SELECT interval_ms, next_wake_at FROM agent_schedule WHERE agent_id=?")
        .get(a.id) as { interval_ms: number; next_wake_at: number } | undefined;
      if (!sch || sch.next_wake_at > now) continue;
      const defer = (why: string) => {
        report.skipped.push({ agentId: a.id, why });
        this.setNext(a.id, now + sch.interval_ms);
      };
      if (this.kill.isHalted(a.id)) {
        if (a.state !== "halted") setAgentState(this.db, a.id, "halted");
        defer("halted");
        continue;
      }
      if (a.state === "halted") setAgentState(this.db, a.id, "sleeping"); // switch was cleared
      const gate = this.treasury.canRun(a.id);
      if (!gate.ok) {
        if (a.state !== "starved") {
          setAgentState(this.db, a.id, "starved");
          appendEvent(this.db, this.clock, {
            type: "agent.starved",
            agentId: a.id,
            payload: { reason: gate.reason },
          });
        }
        defer(gate.reason);
        continue;
      }
      setAgentState(this.db, a.id, "waking");
      setAgentState(this.db, a.id, "running");
      try {
        const out = await this.runOnce(a.id);
        setAgentState(this.db, a.id, "publishing");
        const ref = out.sessionId ?? `${now}`;
        this.treasury.spend(a.id, "llm", out.llmCents, ref);
        this.treasury.spend(a.id, "x_posts", out.postCents, ref);
        this.db
          .prepare("UPDATE agent_schedule SET last_session_id=? WHERE agent_id=?")
          .run(out.sessionId, a.id);
        report.ran.push(a.id);
      } catch (e) {
        appendEvent(this.db, this.clock, {
          type: "agent.run_failed",
          agentId: a.id,
          payload: { error: e instanceof Error ? e.message.slice(0, 200) : "error" },
        });
        report.skipped.push({ agentId: a.id, why: "run failed" });
      }
      setAgentState(this.db, a.id, "sleeping");
      this.setNext(a.id, now + sch.interval_ms);
    }
    return report;
  }

  private setNext(agentId: string, at: number) {
    this.db.prepare("UPDATE agent_schedule SET next_wake_at=? WHERE agent_id=?").run(at, agentId);
  }
}
