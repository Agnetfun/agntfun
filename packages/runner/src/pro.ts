import { relative, resolve } from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionLimits } from "@devagent/core";
import type { Workspace } from "@devagent/sandbox";
import { PRO_TOOLS, TEST_TOOL, checkToolCall } from "./pro-guard";
import type { LiveScreen } from "./live";

/**
 * Pro coding mode: the Claude Agent SDK (the Claude Code harness) drives the session instead of the basic one action
 * loop. It reads the whole repo, edits many files and iterates on failing tests. The boundary stays in code:
 *  - only Read/Write/Edit/Glob/Grep plus our run_tests tool exist (no shell, no web), and every call passes the
 *    PreToolUse guard that pins paths to the agent's repo (pro-guard.ts);
 *  - tests run in the agent's sandbox through run_tests, never on the host;
 *  - the SDK process gets a minimal environment (the model API key only, none of the platform's secrets), loads no
 *    user or project settings, and saves no transcripts;
 *  - turns, dollars and wall time are capped; the kill switch aborts it.
 * Pushing and posting stay with the gateway after the session, exactly as in basic mode.
 */
export interface ProRunArgs {
  workspace: Workspace;
  /** The agent's locked brief and house rules, appended to the Claude Code system prompt. */
  rules: string;
  /** Task plus memory. */
  prompt: string;
  apiKey: string;
  /** Which door to Claude: Anthropic directly or OpenRouter. */
  via?: "anthropic" | "openrouter";
  modelId: string;
  effort: "low" | "medium" | "high";
  limits: SessionLimits;
  screen: LiveScreen;
  isHalted?: () => boolean;
  onTests?: (ok: boolean) => void;
  onWrite?: () => void;
  /** Test hook: stands in for the SDK's query(). */
  queryFn?: (a: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
}

export interface ProRunResult {
  endReason: string;
  summary: string;
  costMicroUsd: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  durationMs: number;
}

const TEST_TIMEOUT_MS = 60_000;
/** Only what the SDK process needs to start: no seal keys, no OAuth secrets, no wallet keys. */
const ENV_KEEP = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG"];

export function proEnv(
  apiKey: string,
  from: NodeJS.ProcessEnv = process.env,
  via: "anthropic" | "openrouter" = "anthropic",
): Record<string, string> {
  // OpenRouter: base URL plus a Bearer token, and an empty ANTHROPIC_API_KEY so the harness does not try Anthropic
  // directly (per OpenRouter's Claude Code guide).
  const env: Record<string, string> =
    via === "openrouter"
      ? { ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_API_KEY: "" }
      : { ANTHROPIC_API_KEY: apiKey };
  for (const k of ENV_KEEP) if (from[k]) env[k] = from[k]!;
  return env;
}

export async function runPro(a: ProRunArgs): Promise<ProRunResult> {
  const root = a.workspace.root;
  if (!root) throw new Error("pro coding mode needs a workspace folder");

  const runTests = tool(
    "run_tests",
    "Run the project's test suite (node --test) in the sandbox and return the output. Run it after every change.",
    {},
    async () => {
      const r = await a.workspace.runTests(TEST_TIMEOUT_MS);
      a.onTests?.(r.ok);
      a.screen.tests(r.ok, r.output);
      return { content: [{ type: "text" as const, text: `${r.ok ? "TESTS PASSED" : "TESTS FAILED"}\n${r.output.slice(-2500)}` }] };
    },
  );

  const rel = (p: unknown) => (typeof p === "string" ? relative(root, resolve(root, p)).replace(/\\/g, "/") : "");
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const g = checkToolCall(root, input.tool_name, input.tool_input);
    if (!g.ok)
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: g.reason } };
    if (input.tool_name === "Read") a.screen.read(rel((input.tool_input as { file_path?: unknown }).file_path));
    return {};
  };
  // After a write or edit the live screen shows the file as it now is.
  const shown: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" || (input.tool_name !== "Write" && input.tool_name !== "Edit")) return {};
    const path = rel((input.tool_input as { file_path?: unknown }).file_path);
    a.onWrite?.();
    try {
      a.screen.write(path, await a.workspace.readFile(path));
    } catch {
      /* the screen is a view */
    }
    return {};
  };

  const abort = new AbortController();
  let endReason = "finished";
  const stop = (why: string) => {
    if (abort.signal.aborted) return;
    endReason = why;
    abort.abort();
  };
  const killWatch = setInterval(() => a.isHalted?.() && stop("killed"), 1000);
  const timeCap = setTimeout(() => stop("cap:time"), a.limits.maxSeconds * 1000);

  const options: Options = {
    cwd: root,
    model: a.modelId,
    effort: a.effort,
    tools: [...PRO_TOOLS],
    allowedTools: [...PRO_TOOLS, TEST_TOOL],
    permissionMode: "dontAsk",
    settingSources: [],
    persistSession: false,
    mcpServers: { devagent: createSdkMcpServer({ name: "devagent", tools: [runTests] }) },
    hooks: { PreToolUse: [{ hooks: [guard] }], PostToolUse: [{ hooks: [shown] }] },
    systemPrompt: { type: "preset", preset: "claude_code", append: a.rules },
    maxTurns: a.limits.maxSteps,
    maxBudgetUsd: a.limits.maxCents / 100,
    env: proEnv(a.apiKey, process.env, a.via),
    abortController: abort,
  };

  const out: ProRunResult = { endReason, summary: "", costMicroUsd: 0, tokensIn: 0, tokensOut: 0, turns: 0, durationMs: 0 };
  try {
    for await (const m of (a.queryFn ?? query)({ prompt: a.prompt, options })) {
      if (m.type !== "result") continue;
      out.costMicroUsd = Math.round(m.total_cost_usd * 1_000_000);
      out.tokensIn = m.usage.input_tokens + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
      out.tokensOut = m.usage.output_tokens;
      out.turns = m.num_turns;
      out.durationMs = m.duration_ms;
      if (m.subtype === "success") out.summary = m.result.slice(0, 1000);
      else
        endReason =
          m.subtype === "error_max_turns" ? "cap:steps" : m.subtype === "error_max_budget_usd" ? "cap:cost" : "error";
    }
  } catch (e) {
    if (!abort.signal.aborted) {
      endReason = "error";
      out.summary = `Session failed: ${(e as Error).message}`;
    }
  } finally {
    clearInterval(killWatch);
    clearTimeout(timeCap);
  }
  return { ...out, endReason };
}
