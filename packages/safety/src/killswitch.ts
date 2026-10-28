import type { Clock } from "@devagent/core";
import { appendEvent, type Db } from "@devagent/db";

/** Global or per agent stop. Checked between every runner step and by the gateway on every intent. */
export class KillSwitch {
  constructor(
    private db: Db,
    private clock: Clock,
  ) {}

  trip(scope: "global" | string, by: string, reason: string): void {
    this.db
      .prepare(
        "INSERT INTO kill_switches (scope, active, set_by, set_at, reason) VALUES (?,1,?,?,?) ON CONFLICT(scope) DO UPDATE SET active=1, set_by=excluded.set_by, set_at=excluded.set_at, reason=excluded.reason",
      )
      .run(scope, by, this.clock.now(), reason);
    appendEvent(this.db, this.clock, {
      type: "kill.trip",
      agentId: scope === "global" ? undefined : scope,
      payload: { scope, by, reason },
    });
  }

  clear(scope: "global" | string, by = "operator"): void {
    this.db
      .prepare("UPDATE kill_switches SET active=0, set_by=?, set_at=? WHERE scope=?")
      .run(by, this.clock.now(), scope);
    appendEvent(this.db, this.clock, {
      type: "kill.clear",
      agentId: scope === "global" ? undefined : scope,
      payload: { scope, by },
    });
  }

  /** With no agent id, only the global switch is checked. */
  isHalted(agentId?: string): boolean {
    const row = agentId
      ? this.db
          .prepare(
            "SELECT 1 AS x FROM kill_switches WHERE active=1 AND scope IN ('global', ?) LIMIT 1",
          )
          .get(agentId)
      : this.db
          .prepare("SELECT 1 AS x FROM kill_switches WHERE active=1 AND scope='global' LIMIT 1")
          .get();
    return row !== undefined;
  }
}
