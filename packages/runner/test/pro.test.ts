import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { FakeClock, loadConfig } from "@devagent/core";
import { createAgent, migrate, openDb, upsertTask } from "@devagent/db";
import { LocalWorkspace } from "@devagent/sandbox";
import { proEnv, runSession } from "../src";

// Pro mode without a network: a fake SDK stream that behaves like the harness (calls our hooks, writes a file,
// reports a result), so the wiring, the guard and the money accounting are tested for real.
const cfg = loadConfig({ DB_PATH: ":memory:", LLM_MODE: "real", ANTHROPIC_API_KEY: "sk-ant-test" });
const limits = { maxTokens: 200_000, maxCents: 500, maxSeconds: 600, maxSteps: 40 };
const hook = (o: Options, event: "PreToolUse" | "PostToolUse", tool_name: string, tool_input: unknown) =>
  o.hooks![event]![0]!.hooks[0]!(
    { hook_event_name: event, tool_name, tool_input, tool_use_id: "t", tool_response: {}, session_id: "s", transcript_path: "", cwd: o.cwd! } as unknown as HookInput,
    "t",
    { signal: new AbortController().signal },
  );

describe("pro coding mode", () => {
  it("runs the SDK locked down, guards every tool call, commits the work and bills the session", async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const db = openDb(":memory:");
    migrate(db, clock);
    const agentId = createAgent(db, clock, { name: "pro", model: "opus", lockedPrompt: "Build small tested modules." }).id;
    upsertTask(db, clock, { agentId, source: "file", summary: "Add a slugify helper" });
    const workspace = await LocalWorkspace.open(mkdtempSync(join(tmpdir(), "pro-")));
    let seen: Options | undefined;
    const decisions: unknown[] = [];

    async function* fake({ prompt, options }: { prompt: string; options: Options }): AsyncIterable<SDKMessage> {
      seen = options;
      expect(prompt).toContain("Add a slugify helper");
      decisions.push(await hook(options, "PreToolUse", "Read", { file_path: "../../outside.txt" }));
      decisions.push(await hook(options, "PreToolUse", "Bash", { command: "cat .env" }));
      decisions.push(await hook(options, "PreToolUse", "Write", { file_path: "src/slug.js", content: "" }));
      writeFileSync(join(options.cwd!, "src-slug.js"), "module.exports = (s) => s.toLowerCase();\n");
      await hook(options, "PostToolUse", "Write", { file_path: "src-slug.js" });
      yield {
        type: "result",
        subtype: "success",
        result: "Added slugify.",
        total_cost_usd: 0.42,
        num_turns: 6,
        duration_ms: 1234,
        usage: { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as unknown as SDKMessage;
    }

    const r = await runSession({ db, clock, agentId, llm: cfg.llm, limits, workspace, coding: "pro", proQuery: fake });

    // Locked down: no shell or web tools, no user settings, no saved transcripts, no platform secrets in its env.
    expect(seen!.tools).toEqual(["Read", "Write", "Edit", "Glob", "Grep"]);
    expect(seen!.settingSources).toEqual([]);
    expect(seen!.persistSession).toBe(false);
    expect(seen!.permissionMode).toBe("dontAsk");
    expect(seen!.maxBudgetUsd).toBe(5);
    expect(Object.keys(seen!.env!)).not.toContain("SEAL_PRIVATE_KEY");
    // The guard: escape and shell denied, an in-repo write allowed.
    expect(JSON.stringify(decisions[0])).toContain('"deny"');
    expect(JSON.stringify(decisions[1])).toContain('"deny"');
    expect(decisions[2]).toEqual({});

    expect(r.endReason).toBe("finished");
    expect(r.commits).toHaveLength(1);
    expect(r.costCents).toBe(42);
    expect(r.testsPassed).toBeNull(); // never ran tests, so the task is not marked done
    const call = db.prepare("SELECT provider, cost_micro_usd FROM llm_calls").get() as { provider: string; cost_micro_usd: number };
    expect(call).toEqual({ provider: "agent-sdk", cost_micro_usd: 420_000 });
    const kinds = (db.prepare("SELECT kind FROM live_frames ORDER BY seq").all() as { kind: string }[]).map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["start", "write", "commit", "end"]));
  });

  it("hands the SDK process only the API key and basic system variables", () => {
    const env = proEnv("sk-ant-x", { PATH: "/bin", SEAL_PRIVATE_KEY: "s", X_CLIENT_SECRET: "x", GITHUB_TOKEN: "g", HOME: "/h" });
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-x", PATH: "/bin", HOME: "/h" });
  });

  it("points the SDK at OpenRouter with a Bearer token and a blank Anthropic key", () => {
    const env = proEnv("sk-or-x", { PATH: "/bin", SEAL_PRIVATE_KEY: "s" }, "openrouter");
    expect(env).toEqual({ ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: "sk-or-x", ANTHROPIC_API_KEY: "", PATH: "/bin" });
  });
});
