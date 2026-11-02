import { ulid, type Clock } from "@devagent/core";
import { appendEvent, getAgent, markTaskDone, type Db } from "@devagent/db";
import type { GatewayClient } from "@devagent/gateway";
import type { SessionResult } from "@devagent/runner";
import type { Workspace } from "@devagent/sandbox";
import { composeVariants, patchStats, postCostCents, type SessionFacts } from "./compose";
import { maxSimilarity } from "./similarity";

export interface PublishDeps {
  db: Db;
  clock: Clock;
  gateway: GatewayClient;
  workspace: Workspace;
  /** Cents the agent may spend on this post. A link is only added when it fits. */
  maxPostCents: number;
  similarityLimit?: number;
}

export interface PublishResult {
  pushed: boolean;
  merged: boolean;
  posted: boolean;
  postText?: string;
  skipped?: string;
  costCents: number;
}

export async function publishSession(d: PublishDeps, r: SessionResult): Promise<PublishResult> {
  const out: PublishResult = { pushed: false, merged: false, posted: false, costCents: 0 };
  if (!r.sessionId || !r.branch || !r.headSha) return { ...out, skipped: "no branch to publish" };
  const session = d.db.prepare("SELECT agent_id FROM sessions WHERE id=?").get(r.sessionId) as
    { agent_id: string } | undefined;
  const agent = session && getAgent(d.db, session.agent_id);
  if (!agent?.repo) return { ...out, skipped: "agent has no repo" };

  const patch = await d.workspace.patchSinceMain();
  const starter = (await d.workspace.patchOfMain?.()) ?? "";
  const stats = patchStats(patch);
  const base = {
    kind: "git_push" as const,
    agentId: agent.id,
    sessionId: r.sessionId,
    repo: agent.repo,
    headSha: r.headSha,
    base: starter.length <= 200_000 ? starter : "",
    testReport: { passed: r.testsPassed === true, summary: `endReason=${r.endReason}` },
  };
  if (patch.trim()) {
    const push = await d.gateway.submit({
      ...base,
      branch: r.branch,
      patch,
      merge: false,
      commitMessage: "",
    });
    out.pushed = push.allowed;
    if (push.allowed && r.endReason === "finished" && r.testsPassed === true) {
      const merge = await d.gateway.submit({
        ...base,
        branch: "main",
        patch,
        merge: true,
        commitMessage: "",
      });
      if (merge.allowed) {
        await d.workspace.mergeToMain();
        out.merged = true;
        // Done means merged: only now does the task leave the queue.
        if (r.taskId) markTaskDone(d.db, d.clock, r.taskId);
      }
    }
  }

  const sessionNumber = (
    d.db
      .prepare(
        "SELECT COUNT(*) c FROM sessions WHERE agent_id=? AND started_at <= (SELECT started_at FROM sessions WHERE id=?)",
      )
      .get(agent.id, r.sessionId) as { c: number }
  ).c;
  const task = r.taskId
    ? (d.db.prepare("SELECT summary FROM tasks WHERE id=?").get(r.taskId) as
        { summary: string } | undefined)
    : undefined;
  const facts: SessionFacts = {
    sessionNumber,
    taskSummary: task?.summary ?? null,
    endReason: r.endReason,
    testsPassed: r.testsPassed,
    commits: r.commits.length,
    ...stats,
    repo: agent.repo,
    branch: out.pushed ? r.branch : null,
    merged: out.merged,
  };
  appendEvent(d.db, d.clock, {
    type: "session.published",
    agentId: agent.id,
    sessionId: r.sessionId,
    payload: {
      branch: r.branch,
      headSha: r.headSha,
      pushed: out.pushed,
      merged: out.merged,
      testsPassed: r.testsPassed,
      endReason: r.endReason,
      ...stats,
    },
  });
  const withLink = out.pushed && postCostCents(true) <= d.maxPostCents;
  const cost = postCostCents(withLink);
  if (cost > d.maxPostCents) return { ...out, skipped: "post over budget" };

  const previous = (
    d.db
      .prepare("SELECT text FROM posts WHERE agent_id=? ORDER BY ts DESC LIMIT 20")
      .all(agent.id) as { text: string }[]
  ).map((p) => p.text);
  const limit = d.similarityLimit ?? 0.6;
  const text = composeVariants(facts, withLink).find((t) => maxSimilarity(t, previous) < limit);
  if (!text) return { ...out, skipped: "too similar to recent posts" };

  const decision = await d.gateway.submit({
    kind: "post_update",
    agentId: agent.id,
    sessionId: r.sessionId,
    text,
  });
  if (!decision.allowed)
    return { ...out, skipped: `gateway: ${decision.stage} ${decision.reason}` };
  // Only a real X post costs money; the local outbox (no X account connected) is free.
  const charged = decision.ref.startsWith("x:") ? cost : 0;
  d.db
    .prepare(
      "INSERT INTO posts (id, agent_id, session_id, ts, text, ref, linked, cost_cents) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      ulid(d.clock.now()),
      agent.id,
      r.sessionId,
      d.clock.now(),
      text,
      decision.ref,
      withLink ? 1 : 0,
      charged,
    );
  return { ...out, posted: true, postText: text, costCents: charged };
}
