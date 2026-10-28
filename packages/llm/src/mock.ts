import type { LlmProvider, LlmRequest, LlmResult } from "./types";

export type MockScript = (req: LlmRequest, callIndex: number) => string;

const approxTokens = (s: string) => Math.ceil(s.length / 4);

/** Deterministic provider for tests and for running the whole app without API keys. */
export class MockProvider implements LlmProvider {
  readonly id = "mock";
  private n = 0;
  constructor(
    readonly model: string,
    private script: MockScript,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResult> {
    const text = this.script(req, this.n++);
    const inTok =
      approxTokens(req.system) + req.messages.reduce((a, m) => a + approxTokens(m.content), 0);
    return {
      text,
      usage: { inTok, outTok: approxTokens(text) },
      provider: this.id,
      model: this.model,
      latencyMs: 1,
    };
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "task";

/** A scripted "developer": writes a module and a test, runs tests, commits, finishes. */
export const developerScript: MockScript = (req) => {
  const first = req.messages[0]?.content ?? "";
  const task = /TASK: (.*)/.exec(first)?.[1]?.trim() ?? "task";
  const s = slug(task);
  const step = req.messages.filter((m) => m.role === "assistant").length;
  const j = (o: unknown) => JSON.stringify(o);
  const steps = [
    j({
      action: "write_file",
      path: `src/${s}.js`,
      content: `module.exports = { task: ${JSON.stringify(task)}, run: () => "done: " + ${JSON.stringify(task)} };\n`,
    }),
    j({
      action: "write_file",
      path: `test/${s}.test.js`,
      content: `const test = require("node:test");\nconst assert = require("node:assert");\nconst m = require("../src/${s}.js");\ntest("${s}", () => assert.strictEqual(m.run(), "done: " + m.task));\n`,
    }),
    j({ action: "run_tests" }),
    j({ action: "commit", message: `feat: ${task}`.slice(0, 120) }),
    j({ action: "finish", summary: `Implemented "${task}" in src/${s}.js with a passing test.` }),
  ];
  return steps[Math.min(step, steps.length - 1)]!;
};

/** A scripted triage model for keyless local runs: accepts whatever passed the deterministic pre-filter. */
export const triageScript: MockScript = (req) => {
  const raw = /<untrusted>([\s\S]*)<\/untrusted>/.exec(req.messages[0]?.content ?? "")?.[1] ?? "";
  const summary = raw
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^A-Za-z0-9 ,.'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110);
  return JSON.stringify(
    summary.length >= 10
      ? { verdict: "accept", summary, size: "S", category: "feature" }
      : { verdict: "reject", summary: "not a clear software task", size: "S", category: "other" },
  );
};

/** Never finishes: used to prove step, token and time caps end a session cleanly. */
export const loopingScript: MockScript = (_req, n) =>
  n === 0
    ? JSON.stringify({ action: "write_file", path: "notes.txt", content: "work in progress\n" })
    : JSON.stringify({ action: "list_dir", path: "." });
