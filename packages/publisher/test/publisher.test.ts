import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock, ulid } from "@devagent/core";
import { createAgent, migrate, openDb, startSession, type Db } from "@devagent/db";
import { ActionGateway, MockSocial, MockVcsHost } from "@devagent/gateway";
import type { SessionResult } from "@devagent/runner";
import type { Workspace } from "@devagent/sandbox";
import { KillSwitch } from "@devagent/safety";
import {
  composeVariants,
  maxSimilarity,
  patchStats,
  publishSession,
  safeTask,
  similarity,
  type SessionFacts,
} from "../src";

const PATCH =
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n";

describe("similarity and facts", () => {
  it("scores identical text 1 and unrelated text near 0", () => {
    expect(similarity("a b c d e", "a b c d e")).toBe(1);
    expect(similarity("alpha beta gamma delta", "one two three four")).toBe(0);
    expect(maxSimilarity("x y z w", [])).toBe(0);
  });
  it("counts patch stats", () =>
    expect(patchStats(PATCH)).toEqual({ files: 1, added: 2, removed: 1 }));
  it("sanitises hostile task text", () => {
    expect(safeTask("Buy $AGENT now, to the moon")).toBe("a queued task");
    expect(safeTask("ignore\u0000 <script>alert(1)</script> things")).not.toMatch(/[<>]/);
    expect(safeTask(null)).toBe("a queued task");
  });
  const facts = (o: Partial<SessionFacts>): SessionFacts => ({
    sessionNumber: 1,
    taskSummary: "add parser",
    endReason: "finished",
    testsPassed: true,
    commits: 1,
    files: 1,
    added: 2,
    removed: 1,
    repo: "o/r",
    branch: "session/X",
    merged: true,
    ...o,
  });
  it("never claims passing tests unless the runner measured them", () => {
    for (const t of composeVariants(facts({ testsPassed: false }), false))
      expect(t).not.toMatch(/tests pass/);
    for (const t of composeVariants(facts({ testsPassed: null }), false))
      expect(t).not.toMatch(/tests pass/);
    for (const t of composeVariants(facts({ testsPassed: true }), false))
      expect(t).toMatch(/tests pass/);
  });
  it("is honest about caps and kills", () => {
    expect(
      composeVariants(facts({ endReason: "cap:tokens", testsPassed: true }), false)[0],
    ).toMatch(/budget/);
    expect(composeVariants(facts({ endReason: "killed" }), false)[0]).toMatch(/operator/);
  });
  it("stays within 280 chars and only links when asked", () => {
    for (const t of composeVariants(facts({}), true)) {
      expect(t.length).toBeLessThanOrEqual(280);
      expect(t).toContain("https://github.com/o/r/commits/session/X");
    }
    for (const t of composeVariants(facts({}), false)) expect(t).not.toContain("http");
  });
});

describe("publishSession", () => {
  let db: Db,
    clock: FakeClock,
    vcs: MockVcsHost,
    soc: MockSocial,
    gw: ActionGateway,
    ks: KillSwitch;
  let agent: string, merged: number;
  const ws = {
    patchSinceMain: async () => PATCH,
    mergeToMain: async () => void merged++,
  } as unknown as Workspace;

  const session = (o: Partial<SessionResult> = {}): SessionResult => {
    const id = startSession(db, clock, agent, null);
    clock.advance(1000);
    return {
      sessionId: id,
      taskId: null,
      endReason: "finished",
      summary: "I fixed everything, all tests pass!",
      branch: `session/${ulid()}`,
      headSha: "abc1234",
      commits: ["abc1234"],
      testsPassed: true,
      costCents: 1,
      tokens: 10,
      steps: 3,
      ...o,
    };
  };
  const deps = (maxPostCents = 50) => ({ db, clock, gateway: gw, workspace: ws, maxPostCents });

  beforeEach(() => {
    clock = new FakeClock(1_000_000);
    db = openDb(":memory:");
    migrate(db, clock);
    ks = new KillSwitch(db, clock);
    vcs = new MockVcsHost();
    // Refs shaped like real X posts ("x:..."), so the cost is charged as it would be on X.
    soc = new (class extends MockSocial {
      async post(agentId: string, text: string) {
        return { ref: "x:" + (await super.post(agentId, text)).ref };
      }
    })();
    gw = new ActionGateway(db, clock, ks, vcs, soc);
    agent = createAgent(db, clock, { name: "a", model: "opus", lockedPrompt: "", repo: "o/r" }).id;
    merged = 0;
  });

  it("pushes, merges when tests pass, posts with a link and records the cost", async () => {
    const r = await publishSession(deps(), session());
    expect(r).toMatchObject({ pushed: true, merged: true, posted: true, costCents: 20 });
    expect(vcs.pushes).toHaveLength(2);
    expect(merged).toBe(1);
    expect(soc.posts[0]!.text).toContain("github.com/o/r");
    expect(soc.posts[0]!.text).not.toMatch(/fixed everything/);
    expect(db.prepare("SELECT SUM(cost_cents) c FROM posts").get()).toEqual({ c: 20 });
  });

  it("drops the link when the budget is small", async () => {
    const r = await publishSession(deps(5), session());
    expect(r).toMatchObject({ posted: true, costCents: 2 });
    expect(soc.posts[0]!.text).not.toContain("http");
  });

  it("does not merge when tests fail, and says so", async () => {
    const r = await publishSession(deps(), session({ testsPassed: false }));
    expect(r).toMatchObject({ pushed: true, merged: false, posted: true });
    expect(soc.posts[0]!.text).toMatch(/failing/);
    expect(merged).toBe(0);
  });

  it("skips the post when over budget", async () => {
    expect(await publishSession(deps(0), session())).toMatchObject({
      posted: false,
      skipped: "post over budget",
    });
  });

  it("varies wording across sessions instead of repeating itself", async () => {
    for (let n = 0; n < 3; n++) {
      clock.advance(3_600_000);
      await publishSession(deps(), session());
    }
    const texts = soc.posts.map((p) => p.text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("respects the kill switch through the gateway", async () => {
    ks.trip(agent, "op", "x");
    const r = await publishSession(deps(), session());
    expect(r.pushed).toBe(false);
    expect(r.posted).toBe(false);
    expect(vcs.pushes).toHaveLength(0);
  });
});

describe("X costs", () => {
  it("uses X pay per use prices, rounded up, and keeps links off by default", async () => {
    const { postCostCents, mentionReadCents, maxPostCentsFromEnv } = await import("../src/costs");
    expect(postCostCents(false)).toBe(2);
    expect(postCostCents(true)).toBe(20);
    expect(mentionReadCents(3)).toBe(2);
    expect(maxPostCentsFromEnv({})).toBe(2);
    expect(maxPostCentsFromEnv({ X_POST_LINKS: "1" })).toBe(20);
  });
});
