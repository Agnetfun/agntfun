import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock, ulid } from "@devagent/core";
import { base58Encode } from "@devagent/community";
import { appendEvent, createAgent, migrate, openDb, type Db } from "@devagent/db";
import { ActionGateway, MockSocial, MockVcsHost } from "@devagent/gateway";
import { KillSwitch } from "@devagent/safety";
import { Scheduler } from "@devagent/scheduler";
import { Treasury } from "@devagent/treasury";
import {
  MAX_LOGO_BYTES,
  MemoryVault,
  ModerationError,
  deployAgent,
  agentSeries,
  deployMessage,
  listAttachments,
  saveAttachment,
  dismissReports,
  getLogo,
  proofScore,
  rankAgents,
  reportAgent,
  restore,
  saveLogo,
  takedown,
  type DeployRequest,
} from "../src";

const DAY = 86_400_000;
let db: Db, clock: FakeClock, kill: KillSwitch;
const wallet = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    address: base58Encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32)),
    key: privateKey,
  };
};
beforeEach(() => {
  clock = new FakeClock(100 * DAY);
  db = openDb(":memory:");
  migrate(db, clock);
  kill = new KillSwitch(db, clock);
});

const BRIEF = "Build small tested command line tools and keep every commit short.";
function req(
  w: { address: string; key: KeyObject },
  o: Partial<DeployRequest> = {},
): DeployRequest {
  const base = {
    name: "Ledger Smith",
    model: "astra",
    brief: BRIEF,
    nonce: ulid(clock.now()).slice(-12),
    ts: clock.now(),
    ...o,
  };
  const sig = sign(null, Buffer.from(deployMessage(base)), w.key).toString("base64");
  return { ...base, wallet: w.address, signature: sig };
}

describe("deploy", () => {
  it("binds attached files to the agent only with a signature that covers them", () => {
    const w = wallet();
    const up = (n: string) => (saveAttachment(db, clock, n, Buffer.from("# doc")) as { id: string }).id;
    const ids = [up("a.md"), up("b.md")];
    // Signed without the files, then files added: refused, nothing bound.
    const unsigned = { ...req(w, { name: "File Smith" }), attachmentIds: ids };
    expect(deployAgent(db, clock, unsigned)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    const r = deployAgent(db, clock, req(w, { name: "File Smith", attachmentIds: ids }));
    expect(r).toMatchObject({ ok: true });
    expect(listAttachments(db, (r as { agentId: string }).agentId).map((f) => f.name)).toEqual(["a.md", "b.md"]);
    // The same uploads cannot be attached to a second agent.
    expect(deployAgent(db, clock, req(w, { name: "Other Smith", attachmentIds: ids }))).toMatchObject({ ok: false });
  });

  it("creates an agent with the chosen model, a repo and the deployer wallet", () => {
    const w = wallet();
    const r = deployAgent(db, clock, req(w));
    expect(r).toMatchObject({ ok: true });
    const a = db.prepare("SELECT model, repo, deployer, locked_prompt FROM agents").get() as Record<
      string,
      string
    >;
    expect(a.model).toBe("astra");
    expect(a.deployer).toBe(w.address);
    expect(a.repo).toMatch(/^devagent-agents\/ledger-smith-[a-z0-9]{4}$/);
    expect(a.locked_prompt).toBe(BRIEF);
    expect(deployAgent(db, clock, req(w, { name: "Other One", model: "opus" })).ok).toBe(true);
  });

  const cases: Array<[string, (w: ReturnType<typeof wallet>) => DeployRequest, RegExp]> = [
    ["bad model", (w) => req(w, { model: "gpt-4" }), /Pick Claude/],
    ["short name", (w) => req(w, { name: "ab" }), /Name must/],
    ["markup in name", (w) => req(w, { name: "<b>bold</b>" }), /Name must/],
    ["reserved name", (w) => req(w, { name: "Official Support" }), /reserved/],
    ["short brief", (w) => req(w, { brief: "too short" }), /brief must/],
    ["huge brief", (w) => req(w, { brief: "x".repeat(60_001) }), /brief must/],
    ["over 10,000 words", (w) => req(w, { brief: "word ".repeat(10_001) }), /over 10,000 words/],
    [
      "harmful brief",
      (w) => req(w, { brief: "Build ransomware that encrypts every file it finds." }),
      /does not allow/,
    ],
    [
      "secret in brief",
      (w) => req(w, { brief: "Use key sk-ant-" + "a1b2".repeat(8) + " for everything." }),
      /secret/,
    ],
    ["stale request", (w) => req(w, { ts: clock.now() - 11 * 60_000 }), /too old/],
    ["future request", (w) => req(w, { ts: clock.now() + 5 * 60_000 }), /too old/],
    ["bad nonce", (w) => req(w, { nonce: "x" }), /nonce/],
    [
      "signature from another wallet",
      (w) => ({ ...req(w), wallet: wallet().address }),
      /signature/,
    ],
    [
      "brief swapped after signing",
      (w) => ({ ...req(w), brief: BRIEF + " Also do something else entirely." }),
      /signature/,
    ],
    ["model swapped after signing", (w) => ({ ...req(w), model: "opus" }), /signature/],
  ];
  for (const [name, make, re] of cases)
    it(`rejects ${name}`, () => {
      const r = deployAgent(db, clock, make(wallet()));
      expect(r.ok).toBe(false);
      expect((r as { reason: string }).reason).toMatch(re);
      expect(db.prepare("SELECT COUNT(*) c FROM agents").get()).toEqual({ c: 0 });
    });

  it("blocks replays, duplicate names and too many agents per wallet", () => {
    const w = wallet();
    const first = req(w);
    expect(deployAgent(db, clock, first).ok).toBe(true);
    expect(deployAgent(db, clock, first)).toMatchObject({ ok: false });
    expect(
      (deployAgent(db, clock, req(wallet(), { name: "ledger smith" })) as { reason: string })
        .reason,
    ).toMatch(/taken/);
    expect(deployAgent(db, clock, req(w, { name: "Second Agent" })).ok).toBe(true);
    expect(deployAgent(db, clock, req(w, { name: "Third Agent" })).ok).toBe(true);
    expect(
      (deployAgent(db, clock, req(w, { name: "Fourth Agent" })) as { reason: string }).reason,
    ).toMatch(/at most 3/);
  });
});

describe("moderation", () => {
  const ops = ["op1"];
  let a: string;
  beforeEach(() => {
    a = createAgent(db, clock, { name: "Target", model: "opus", lockedPrompt: "", repo: "o/r" }).id;
  });
  it("validates reports and auto pauses after enough open reports", () => {
    expect(reportAgent(db, clock, kill, { agentId: a, reason: "nonsense" })).toMatchObject({
      ok: false,
    });
    expect(reportAgent(db, clock, kill, { agentId: "missing", reason: "scam" })).toMatchObject({
      ok: false,
    });
    for (let i = 0; i < 4; i++)
      expect(
        reportAgent(db, clock, kill, { agentId: a, reason: "scam", detail: "x".repeat(900) }),
      ).toEqual({ ok: true, paused: false });
    expect(kill.isHalted(a)).toBe(false);
    expect(reportAgent(db, clock, kill, { agentId: a, reason: "spam" })).toEqual({
      ok: true,
      paused: true,
    });
    expect(kill.isHalted(a)).toBe(true);
    expect((db.prepare("SELECT MAX(LENGTH(detail)) l FROM reports").get() as { l: number }).l).toBe(
      500,
    );
  });
  it("old reports do not count toward the pause", () => {
    for (let i = 0; i < 4; i++) reportAgent(db, clock, kill, { agentId: a, reason: "scam" });
    clock.advance(2 * DAY);
    expect(reportAgent(db, clock, kill, { agentId: a, reason: "scam" })).toEqual({
      ok: true,
      paused: false,
    });
  });
  it("only operators can take down or restore; takedown hides, stops and closes reports", () => {
    reportAgent(db, clock, kill, { agentId: a, reason: "scam" });
    expect(() => takedown(db, clock, kill, ops, a, "intruder", "x")).toThrow(ModerationError);
    expect(() => restore(db, clock, kill, ops, a, "")).toThrow(ModerationError);
    takedown(db, clock, kill, ops, a, "op1", "confirmed scam");
    expect(kill.isHalted(a)).toBe(true);
    expect(rankAgents(db, clock.now())).not.toContain(a);
    expect(db.prepare("SELECT status FROM reports").get()).toEqual({ status: "actioned" });
    expect(reportAgent(db, clock, kill, { agentId: a, reason: "scam" })).toMatchObject({
      ok: false,
    });
    restore(db, clock, kill, ops, a, "op1");
    expect(kill.isHalted(a)).toBe(false);
    expect(rankAgents(db, clock.now())).toContain(a);
  });
  it("operators can dismiss reports", () => {
    reportAgent(db, clock, kill, { agentId: a, reason: "other" });
    expect(() => dismissReports(db, ops, a, "nope")).toThrow(ModerationError);
    dismissReports(db, ops, a, "op1");
    expect(db.prepare("SELECT status FROM reports").get()).toEqual({ status: "dismissed" });
  });
});

describe("discovery ranking is proof of work, not money", () => {
  const merge = (id: string, at: number) => {
    clock.set(at);
    appendEvent(db, clock, { type: "session.published", agentId: id, payload: { merged: true } });
  };
  it("ranks by merges, caps per day, ignores balance and unmerged pushes", () => {
    const t = new Treasury(db, clock, []);
    const rich = createAgent(db, clock, { name: "Rich", model: "opus", lockedPrompt: "" }).id;
    const steady = createAgent(db, clock, { name: "Steady", model: "opus", lockedPrompt: "" }).id;
    const spammer = createAgent(db, clock, {
      name: "Spammer",
      model: "astra",
      lockedPrompt: "",
    }).id;
    t.topUp(rich, 1_000_000, "x");
    const now = clock.now();
    for (let d = 1; d <= 5; d++) merge(steady, now - d * DAY);
    for (let i = 0; i < 40; i++) merge(spammer, now - 3600_000);
    clock.set(now);
    appendEvent(db, clock, {
      type: "session.published",
      agentId: rich,
      payload: { merged: false },
    });
    expect(proofScore(db, spammer, now)).toBe(30);
    expect(proofScore(db, steady, now)).toBe(50);
    expect(rankAgents(db, now, "proof")).toEqual([steady, spammer, rich]);
    expect(rankAgents(db, now, "funded", (id) => t.balanceCents(id))[0]).toBe(rich);
  });
  it("old work fades out of the window", () => {
    const a = createAgent(db, clock, { name: "Old", model: "opus", lockedPrompt: "" }).id;
    merge(a, clock.now() - 40 * DAY);
    clock.set(100 * DAY);
    expect(proofScore(db, a, clock.now())).toBe(0);
  });
});

describe("agents are isolated from each other", () => {
  it("separate money, separate failure, separate credentials", async () => {
    const t = new Treasury(db, clock, ["op"], {
      dailyCapCents: 100,
      minRunwayDays: 0,
      sessionReserveCents: 10,
    });
    const ids = ["A", "B", "C"].map(
      (n) =>
        createAgent(db, clock, {
          name: `Agent ${n}`,
          model: "opus",
          lockedPrompt: "",
          repo: `org/${n.toLowerCase()}`,
        }).id,
    );
    t.topUp(ids[0]!, 500, "x");
    t.topUp(ids[1]!, 500, "x");
    expect(t.canRun(ids[2]!)).toMatchObject({ ok: false });
    t.spend(ids[0]!, "llm", 40, "s");
    expect(t.balanceCents(ids[1]!)).toBe(500);
    const ran: string[] = [];
    const sch = new Scheduler(db, clock, t, kill, async (id) => {
      if (id === ids[0]) throw new Error("agent A crashed");
      ran.push(id);
      return { sessionId: null, llmCents: 5, postCents: 0 };
    });
    for (const id of ids) sch.schedule(id, DAY);
    const r = await sch.tick();
    expect(ran).toEqual([ids[1]]);
    expect(r.skipped.map((s) => s.why).sort()).toEqual(["no_funds", "run failed"]);
    kill.trip(ids[1]!, "op", "x");
    expect(
      (
        await new Scheduler(db, clock, t, kill, async () => ({
          sessionId: null,
          llmCents: 0,
          postCents: 0,
        })).tick()
      ).ran,
    ).toEqual([]);

    kill.clear(ids[1]!);
    // an intent for agent B cannot be pushed to agent A's repo
    const gw = new ActionGateway(db, clock, kill, new MockVcsHost(), new MockSocial());
    const d = await gw.submit({
      kind: "git_push",
      agentId: ids[1],
      sessionId: "s",
      repo: "org/a",
      branch: `session/${ulid()}`,
      headSha: "abc1234",
      patch: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1 @@\n+x\n",
      testReport: { passed: true, summary: "" },
      merge: false,
      commitMessage: "",
    });
    expect(d).toMatchObject({ allowed: false, stage: "allowlist" });

    const v = new MemoryVault();
    v.set(ids[0]!, "github", "token-a");
    expect(v.get(ids[1]!, "github")).toBeUndefined();
    expect(v.get(ids[0]!, "x")).toBeUndefined();
    expect(v.get(ids[0]!, "github")).toBe("token-a");
  });
});

describe("coin identity", () => {
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4",
    "hex",
  );
  it("accepts real raster images and refuses SVG, scripts and oversize files", () => {
    const db = openDb(":memory:");
    const clock = new FakeClock(1_000_000);
    migrate(db, clock);
    const ok = saveLogo(db, clock, png);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(getLogo(db, ok.id)?.mime).toBe("image/png");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    expect(saveLogo(db, clock, svg).ok).toBe(false);
    expect(saveLogo(db, clock, Buffer.from("<script>alert(1)</script>............")).ok).toBe(
      false,
    );
    expect(saveLogo(db, clock, Buffer.concat([png, Buffer.alloc(MAX_LOGO_BYTES)])).ok).toBe(false);
  });
  it("builds a 30 day series from the append only tables", () => {
    const db = openDb(":memory:");
    const clock = new FakeClock(100 * 86_400_000);
    migrate(db, clock);
    const id = createAgent(db, clock, { name: "Seried", model: "opus", lockedPrompt: "x" }).id;
    const s = agentSeries(db, id, clock.now(), 30);
    expect(s.days).toHaveLength(30);
    expect(s.merges.every((n) => n === 0)).toBe(true);
    expect(s.balanceCents.at(-1)).toBe(0);
  });
});
