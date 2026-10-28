import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock, ulid } from "@devagent/core";
import { createAgent, migrate, openDb, type Db } from "@devagent/db";
import { KillSwitch } from "@devagent/safety";
import { ActionGateway, MockSocial, MockVcsHost } from "../src";

const REPO = "agent-one/work";
let db: Db,
  clock: FakeClock,
  ks: KillSwitch,
  vcs: MockVcsHost,
  soc: MockSocial,
  gw: ActionGateway,
  agent: string;

const diff = (path: string, body = "+hello", extra = "") =>
  `diff --git a/${path} b/${path}\n${extra}--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n${body}\n`;
const push = (o: Record<string, unknown> = {}) => ({
  kind: "git_push",
  agentId: agent,
  sessionId: ulid(),
  repo: REPO,
  branch: `session/${ulid()}`,
  headSha: "abc1234",
  patch: diff("src/a.ts"),
  testReport: { passed: true, summary: "ok" },
  merge: false,
  commitMessage: "add helper",
  ...o,
});
const post = (text: string) => ({ kind: "post_update", agentId: agent, sessionId: ulid(), text });

beforeEach(() => {
  clock = new FakeClock(1_000_000);
  db = openDb(":memory:");
  migrate(db, clock);
  ks = new KillSwitch(db, clock);
  vcs = new MockVcsHost();
  soc = new MockSocial();
  gw = new ActionGateway(db, clock, ks, vcs, soc);
  agent = createAgent(db, clock, { name: "one", model: "opus", lockedPrompt: "", repo: REPO }).id;
});

describe("happy path", () => {
  it("allows a clean push and post and audits both", async () => {
    expect((await gw.submit(push())).allowed).toBe(true);
    expect(
      (await gw.submit(post("Added a helper with tests. https://github.com/agent-one/work")))
        .allowed,
    ).toBe(true);
    expect(vcs.pushes).toHaveLength(1);
    expect(soc.posts).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) c FROM gateway_audit WHERE decision='allow'").get()).toEqual(
      { c: 2 },
    );
  });
});

const attacks: Array<[string, () => unknown, string]> = [
  ["schema garbage", () => ({ nonsense: true }), "schema"],
  ["null intent", () => null, "schema"],
  ["unknown kind", () => ({ kind: "shell", cmd: "env" }), "schema"],
  ["bad sha", () => push({ headSha: "zzz; rm -rf /" }), "schema"],
  ["push to another repo", () => push({ repo: "victim/prod" }), "allowlist"],
  ["push to main without merge", () => push({ branch: "main" }), "allowlist"],
  ["push to arbitrary branch", () => push({ branch: "release" }), "allowlist"],
  ["branch injection", () => push({ branch: "session/x; curl evil" }), "allowlist"],
  [
    "merge with failing tests",
    () => push({ branch: "main", merge: true, testReport: { passed: false, summary: "" } }),
    "allowlist",
  ],
  ["unknown agent", () => push({ agentId: "nope" }), "allowlist"],
  ["write .env", () => push({ patch: diff(".env", "+X=1") }), "allowlist"],
  ["write workflow", () => push({ patch: diff(".github/workflows/ci.yml") }), "allowlist"],
  ["write .git hook", () => push({ patch: diff(".git/hooks/pre-commit") }), "allowlist"],
  ["path traversal", () => push({ patch: diff("../../etc/passwd") }), "allowlist"],
  ["absolute path", () => push({ patch: diff("/etc/cron.d/x") }), "allowlist"],
  ["key file", () => push({ patch: diff("deploy/id_rsa") }), "allowlist"],
  [
    "symlink",
    () => push({ patch: diff("link", "+/etc/shadow", "new file mode 120000\n") }),
    "allowlist",
  ],
  ["oversize patch", () => push({ patch: diff("a.txt", "+" + "x".repeat(300_000)) }), "limits"],
  [
    "too many files",
    () => push({ patch: Array.from({ length: 50 }, (_, n) => diff(`f${n}.txt`)).join("") }),
    "limits",
  ],
  [
    "planted anthropic key",
    () => push({ patch: diff("a.ts", "+const k='sk-ant-" + "a1".repeat(20) + "'") }),
    "secrets",
  ],
  [
    "key in commit message",
    () => push({ commitMessage: "key sk-ant-" + "b2".repeat(20) }),
    "secrets",
  ],
  ["post with price talk", () => post("Market cap is up, price target soon"), "content"],
  ["post with cashtag buy call", () => post("Buy $AGENT now"), "content"],
  ["post with mention", () => post("great idea @someone"), "content"],
  ["post with unknown link", () => post("see https://evil.example/x"), "allowlist"],
  ["post with two links", () => post("https://github.com/a https://github.com/b"), "allowlist"],
  ["overlong post", () => post("x".repeat(281)), "limits"],
  ["post leaking key", () => post("here: sk-ant-" + "c3".repeat(20)), "secrets"],
  [
    "malicious commit message",
    () => push({ commitMessage: "Guaranteed profit, to the moon" }),
    "content",
  ],
];

describe("red team: every attack is denied at the expected stage", () => {
  for (const [name, make, stage] of attacks) {
    it(name, async () => {
      const d = await gw.submit(make());
      expect(d).toMatchObject({ allowed: false, stage });
      expect(vcs.pushes).toHaveLength(0);
      expect(soc.posts).toHaveLength(0);
    });
  }
  it("has at least 20 attacks", () => expect(attacks.length).toBeGreaterThanOrEqual(20));
});

describe("rate limits and kill switch", () => {
  it("spam burst is cut off, then recovers with time", async () => {
    const results = [];
    for (let n = 0; n < 8; n++) results.push((await gw.submit(post(`update ${n} ok`))).allowed);
    expect(results.filter(Boolean)).toHaveLength(4);
    clock.advance(31 * 60_000);
    expect((await gw.submit(post("later update"))).allowed).toBe(true);
  });
  it("per agent kill stops it, other agent unaffected, global stops all", async () => {
    const other = createAgent(db, clock, {
      name: "two",
      model: "astra",
      lockedPrompt: "",
      repo: "two/work",
    }).id;
    ks.trip(agent, "op", "x");
    expect(await gw.submit(post("hi"))).toMatchObject({ allowed: false, stage: "kill" });
    expect((await gw.submit({ ...post("hi"), agentId: other })).allowed).toBe(true);
    ks.trip("global", "op", "x");
    expect(await gw.submit({ ...post("hi"), agentId: other })).toMatchObject({
      allowed: false,
      stage: "kill",
    });
    ks.clear("global");
    ks.clear(agent);
    expect((await gw.submit(post("back"))).allowed).toBe(true);
  });
  it("audit log is append-only", async () => {
    await gw.submit(post("one"));
    expect(() => db.prepare("DELETE FROM gateway_audit").run()).toThrow(/append-only/);
  });
});
