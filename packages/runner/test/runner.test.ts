import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock, loadConfig } from "@devagent/core";
import { createAgent, migrate, openDb, upsertTask, type Db } from "@devagent/db";
import { MockProvider, loopingScript } from "@devagent/llm";
import { LocalWorkspace } from "@devagent/sandbox";
import { parseAction, runSession } from "../src";

const cfg = loadConfig({ DB_PATH: ":memory:" });
const limits = { maxTokens: 200_000, maxCents: 500, maxSeconds: 600, maxSteps: 40 };
let db: Db;
let clock: FakeClock;
let agentId: string;

const ws = () => LocalWorkspace.open(mkdtempSync(join(tmpdir(), "ws-")));
const rows = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;

beforeEach(() => {
  clock = new FakeClock(1_700_000_000_000);
  db = openDb(":memory:");
  migrate(db, clock);
  agentId = createAgent(db, clock, {
    name: "bot",
    model: "astra",
    lockedPrompt: "Build small tested modules.",
  }).id;
  upsertTask(db, clock, { agentId, source: "file", summary: "Add sum helper" });
});

describe("parseAction", () => {
  it("accepts fenced json and chatter", () => {
    const r = parseAction('Sure!\n```json\n{"action":"run_tests"}\n```');
    expect(r).toEqual({ ok: true, action: { action: "run_tests" } });
  });
  it("rejects unknown actions and bad json", () => {
    expect(parseAction('{"action":"shell","cmd":"ls"}').ok).toBe(false);
    expect(parseAction("{nope").ok).toBe(false);
    expect(parseAction("plain text").ok).toBe(false);
  });
});

describe("runSession", () => {
  it("finishes a toy task deterministically with passing tests, a commit and stored cost", async () => {
    const w = await ws();
    const r = await runSession({ db, clock, agentId, llm: cfg.llm, limits, workspace: w });
    expect(r).toMatchObject({ endReason: "finished", testsPassed: true });
    expect(r.commits).toHaveLength(1);
    expect(await w.readFile("src/add-sum-helper.js")).toContain("Add sum helper");
    expect(rows("SELECT status FROM tasks")[0]!.status).toBe("done");
    const s = rows("SELECT * FROM sessions")[0]!;
    expect(s.end_reason).toBe("finished");
    expect(Number(s.cost_cents)).toBeGreaterThanOrEqual(1);
    expect(rows("SELECT * FROM llm_calls")).toHaveLength(5);
    expect(rows("SELECT type FROM events").map((e) => e.type)).toContain("session.end");
  });

  it("is repeatable: two runs give the same actions", async () => {
    const out: string[] = [];
    for (let i = 0; i < 2; i++) {
      const d = openDb(":memory:");
      migrate(d, clock);
      const id = createAgent(d, clock, { name: "b", model: "opus", lockedPrompt: "" }).id;
      upsertTask(d, clock, { agentId: id, source: "file", summary: "Add sum helper" });
      await runSession({ db: d, clock, agentId: id, llm: cfg.llm, limits, workspace: await ws() });
      out.push(
        JSON.stringify(
          d
            .prepare("SELECT type, payload_json FROM events WHERE type='session.step'")
            .all()
            .map((e) => JSON.parse(e.payload_json as string).action),
        ),
      );
    }
    expect(out[0]).toBe(out[1]);
  });

  it("ends cleanly at the step cap, keeps work, leaves the task open", async () => {
    const w = await ws();
    const r = await runSession({
      db,
      clock,
      agentId,
      llm: cfg.llm,
      limits: { ...limits, maxSteps: 3 },
      workspace: w,
      provider: new MockProvider("m", loopingScript),
    });
    expect(r.endReason).toBe("cap:steps");
    expect(r.summary).toContain("cap:steps");
    expect(r.commits).toHaveLength(1); // wip commit of notes.txt
    expect(rows("SELECT status FROM tasks")[0]!.status).toBe("open");
    expect(rows("SELECT end_reason FROM sessions")[0]!.end_reason).toBe("cap:steps");
  });

  it("ends at the token cap", async () => {
    const r = await runSession({
      db,
      clock,
      agentId,
      llm: cfg.llm,
      limits: { ...limits, maxTokens: 50 },
      workspace: await ws(),
      provider: new MockProvider("m", loopingScript),
    });
    expect(r.endReason).toBe("cap:tokens");
  });

  it("ends at the time cap using the clock", async () => {
    const slow = new MockProvider("m", (req, n) => (clock.advance(6000), loopingScript(req, n)));
    const r = await runSession({
      db,
      clock,
      agentId,
      llm: cfg.llm,
      limits: { ...limits, maxSeconds: 10 },
      workspace: await ws(),
      provider: slow,
    });
    expect(r.endReason).toBe("cap:time");
  });

  it("kill switch ends the session and halts the agent", async () => {
    let halted = false;
    const p = new MockProvider("m", (req, n) => ((halted = n >= 1), loopingScript(req, n)));
    const r = await runSession({
      db,
      clock,
      agentId,
      llm: cfg.llm,
      limits,
      workspace: await ws(),
      provider: p,
      isHalted: () => halted,
    });
    expect(r.endReason).toBe("killed");
    expect(rows("SELECT state FROM agents")[0]!.state).toBe("halted");
  });

  it("stops after repeated unparseable output", async () => {
    const r = await runSession({
      db,
      clock,
      agentId,
      llm: cfg.llm,
      limits,
      workspace: await ws(),
      provider: new MockProvider("m", () => "I will just talk instead"),
    });
    expect(r.endReason).toBe("error:bad_output");
  });

  it("reports no_task without creating a session", async () => {
    db.exec("UPDATE tasks SET status='done'");
    const r = await runSession({ db, clock, agentId, llm: cfg.llm, limits, workspace: await ws() });
    expect(r.endReason).toBe("no_task");
    expect(rows("SELECT * FROM sessions")).toHaveLength(0);
  });
});
