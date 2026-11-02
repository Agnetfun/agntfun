import { join } from "node:path";
import { systemClock } from "@devagent/core";
import { appendEvent } from "@devagent/db";
import type { GatewayClient } from "@devagent/gateway";
import { maxPostCentsFromEnv, publishSession } from "@devagent/publisher";
import { runSession } from "@devagent/runner";
import {
  DockerWorkspace,
  LocalWorkspace,
  dockerAvailable,
  type Workspace,
} from "@devagent/sandbox";
import type { RunOnce } from "@devagent/scheduler";
import type { Booted } from "./boot";

export type SandboxMode = "docker" | "local";

/** Never falls back silently: asking for docker without a docker daemon is an error, not a downgrade. */
export async function openWorkspace(
  mode: SandboxMode,
  agentId: string,
  image = "node:22-slim",
  root = join("data", "workspaces"),
): Promise<Workspace> {
  const dir = join(root, agentId);
  if (mode === "local") return LocalWorkspace.open(dir);
  if (!(await dockerAvailable()))
    throw new Error("SANDBOX=docker but no docker daemon is reachable");
  return DockerWorkspace.open(dir, { image, agentId });
}

/** One wake up: run a session in a fresh sandbox, publish through the gateway, report the money spent. */
export function makeRunOnce(app: Booted, gateway: GatewayClient, mode: SandboxMode): RunOnce {
  return async (agentId) => {
    const workspace = await openWorkspace(mode, agentId, process.env.SANDBOX_IMAGE || undefined);
    const r = await runSession({
      db: app.db,
      clock: systemClock,
      agentId,
      llm: app.config.llm,
      limits: app.config.session,
      workspace,
      isHalted: () => app.kill.isHalted(agentId),
      coding: process.env.CODING_MODE === "pro" ? "pro" : "basic",
    });
    // The session already spent model money: it is booked even when publishing fails (a huge diff, a failed merge,
    // a database error), or a failing publish would let an agent run without being charged.
    let postCents = 0;
    try {
      postCents = (
        await publishSession({ db: app.db, clock: systemClock, gateway, workspace, maxPostCents: maxPostCentsFromEnv() }, r)
      ).costCents;
    } catch (e) {
      appendEvent(app.db, systemClock, {
        type: "session.publish_failed",
        agentId,
        sessionId: r.sessionId ?? undefined,
        payload: { error: e instanceof Error ? e.message.slice(0, 300) : "failed" },
      });
    }
    return { sessionId: r.sessionId, llmCents: r.costCents, postCents };
  };
}

export function sandboxModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): SandboxMode {
  const m = env.SANDBOX || "docker";
  if (m !== "docker" && m !== "local") throw new Error("SANDBOX must be docker or local");
  return m;
}
