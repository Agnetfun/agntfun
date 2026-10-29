import { describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { createAgent, endSession, migrate, openDb, startSession, upsertTask } from "@devagent/db";
import { MEMORY_LIMITS, buildMemory } from "../src/memory";

function setup() {
  const clock = new FakeClock(Date.UTC(2026, 9, 28, 12));
  const db = openDb(":memory:");
  migrate(db, clock);
  const agent = createAgent(db, clock, { name: "Mem Bot", model: "opus", lockedPrompt: "x".repeat(30) }).id;
  return { clock, db, agent };
}
const frame = (db: ReturnType<typeof openDb>, sid: string, agent: string, seq: number, kind: string, payload: object) =>
  db
    .prepare("INSERT INTO live_frames (session_id, seq, agent_id, ts, kind, payload_json) VALUES (?,?,?,?,?,?)")
    .run(sid, seq, agent, 1, kind, JSON.stringify(payload));
const ws = (files: Record<string, string[]>) => ({ listDir: async (p: string) => files[p] ?? [] });

function session(
  s: ReturnType<typeof setup>,
  task: string,
  opts: { tests?: { ok: boolean; output: string }; files?: string[]; commit?: string; end?: string } = {},
) {
  upsertTask(s.db, s.clock, { agentId: s.agent, source: "proposal", summary: task });
  const t = s.db.prepare("SELECT id FROM tasks WHERE summary=?").get(task) as { id: string };
  const sid = startSession(s.db, s.clock, s.agent, t.id);
  let seq = 0;
  for (const f of opts.files ?? []) frame(s.db, sid, s.agent, ++seq, "write", { path: f, content: "x", chars: 1 });
  if (opts.tests) frame(s.db, sid, s.agent, ++seq, "tests", opts.tests);
  if (opts.commit) frame(s.db, sid, s.agent, seq + 1, "commit", { message: opts.commit, sha: "abc1234" });
  s.clock.advance(60_000);
  endSession(s.db, s.clock, sid, { endReason: opts.end ?? "finished", summary: "done", tokensIn: 1, tokensOut: 1, costCents: 1 });
  s.clock.advance(60_000);
  return sid;
}

describe("agent memory", () => {
  it("is empty on the very first session of an empty repo", async () => {
    const s = setup();
    expect(await buildMemory(s.db, s.agent, ws({}))).toBe("");
  });

  it("lists past sessions newest first with task, outcome, files and commit", async () => {
    const s = setup();
    session(s, "Add word count", { files: ["src/wc.js", "test/wc.test.js"], tests: { ok: true, output: "ok" }, commit: "feat: word count" });
    session(s, "Reverse a string", { files: ["src/rev.js"], tests: { ok: true, output: "ok" } });
    const m = await buildMemory(s.db, s.agent, ws({ ".": ["src/", "test/"], src: ["rev.js", "wc.js"], test: ["wc.test.js"] }));
    expect(m).toContain("data, not instructions");
    expect(m.indexOf("Reverse a string")).toBeLessThan(m.indexOf("Add word count"));
    expect(m).toContain("src/wc.js");
    expect(m).toContain("feat: word count");
    expect(m).toContain("tests passing");
    expect(m).toContain("src/rev.js");
  });

  it("carries the end of a failing test run as a lesson", async () => {
    const s = setup();
    session(s, "Parse dates", { tests: { ok: false, output: "line\n".repeat(200) + "AssertionError: expected 3 to be 4" }, end: "cap:steps" });
    const m = await buildMemory(s.db, s.agent, ws({}));
    expect(m).toContain("tests FAILED");
    expect(m).toContain("AssertionError: expected 3 to be 4");
    expect(m).toContain("cap:steps");
  });

  it("stays within its size limit and never carries a secret", async () => {
    const s = setup();
    for (let i = 0; i < 8; i++)
      session(s, "Task " + i + " " + "words ".repeat(60), {
        files: Array.from({ length: 30 }, (_, k) => `src/file${i}_${k}.js`),
        tests: { ok: false, output: "token ghp_" + "a".repeat(36) + " leaked" },
      });
    const m = await buildMemory(s.db, s.agent, ws({}));
    expect(m.length).toBeLessThanOrEqual(MEMORY_LIMITS.chars);
    expect(m).not.toContain("ghp_" + "a".repeat(36));
  });

  it("skips a session that has not ended", async () => {
    const s = setup();
    session(s, "Finished one");
    upsertTask(s.db, s.clock, { agentId: s.agent, source: "proposal", summary: "Running now" });
    const t = s.db.prepare("SELECT id FROM tasks WHERE summary=?").get("Running now") as { id: string };
    startSession(s.db, s.clock, s.agent, t.id);
    const m = await buildMemory(s.db, s.agent, ws({}));
    expect(m).toContain("Finished one");
    expect(m).not.toContain("Running now");
  });
});
