import { redactSecrets, type Clock, type LlmConfig, type SessionLimits } from "@devagent/core";
import {
  isFreeModel,
  priceFor,
  BudgetExceeded,
  MeteredProvider,
  SessionBudget,
  createProvider,
  microUsdToCents,
  type LlmProvider,
} from "@devagent/llm";
import {
  appendEvent,
  endSession,
  getAgent,
  insertLlmCall,
  markTaskDone,
  pickTask,
  setAgentState,
  startSession,
  type Db,
} from "@devagent/db";
import { parseAction, type Action } from "./actions";
import { buildSystemPrompt, taskMessage } from "./prompt";
import { LiveScreen } from "./live";
import { buildMemory } from "./memory";
import { runPro, type ProRunArgs } from "./pro";
import type { Workspace } from "@devagent/sandbox";

export interface RunSessionArgs {
  db: Db;
  clock: Clock;
  agentId: string;
  llm: LlmConfig;
  limits: SessionLimits;
  workspace: Workspace;
  /** Test hook. Normally the provider comes from the agent's model choice. */
  provider?: LlmProvider;
  isHalted?: () => boolean;
  /** "pro" runs the Claude Agent SDK harness (real mode, opus only); "basic" is the one action loop. */
  coding?: "basic" | "pro";
  /** Test hook for pro mode. */
  proQuery?: ProRunArgs["queryFn"];
}

export interface SessionResult {
  sessionId: string | null;
  taskId: string | null;
  endReason: string;
  summary: string;
  branch: string | null;
  headSha: string | null;
  commits: string[];
  testsPassed: boolean | null;
  costCents: number;
  tokens: number;
  steps: number;
}

const MAX_BAD_OUTPUTS = 3;
const TEST_TIMEOUT_MS = 60_000;
const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n[truncated]` : s);

function safeJson(o: unknown): unknown {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(o)));
  } catch {
    return { redacted: true };
  }
}

export async function runSession(a: RunSessionArgs): Promise<SessionResult> {
  const { db, clock, workspace } = a;
  const agent = getAgent(db, a.agentId);
  if (!agent) throw new Error(`unknown agent ${a.agentId}`);

  const task = pickTask(db, agent.id);
  if (!task) {
    return {
      sessionId: null,
      taskId: null,
      endReason: "no_task",
      summary: "No open task.",
      branch: null,
      headSha: null,
      commits: [],
      testsPassed: null,
      costCents: 0,
      tokens: 0,
      steps: 0,
    };
  }

  const sessionId = startSession(db, clock, agent.id, task.id);
  const emit = (type: string, payload?: unknown) =>
    appendEvent(db, clock, {
      type,
      agentId: agent.id,
      sessionId,
      payload: safeJson(payload ?? {}),
    });
  setAgentState(db, agent.id, "running");

  const budget = new SessionBudget(
    {
      maxTokens: a.limits.maxTokens,
      maxMicroUsd: a.limits.maxCents * 10_000,
      maxMs: a.limits.maxSeconds * 1000,
      maxSteps: a.limits.maxSteps,
    },
    clock,
    a.isHalted,
  );
  const inner = a.provider ?? createProvider(agent.model, a.llm);
  const llm = new MeteredProvider(inner, budget, priceFor(agent.model, inner.model), (r) =>
    insertLlmCall(db, clock, { ...r, sessionId, agentId: agent.id }),
  );

  const commits: string[] = [];
  const branch = `session/${sessionId}`;
  let headSha: string | null = null;
  let testsPassed: boolean | null = null;
  let endReason = "finished";
  let finishSummary = "";
  let proCost: { costMicroUsd: number; tokensIn: number; tokensOut: number; turns: number } | null = null;
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: taskMessage(task.summary) },
  ];
  const system = buildSystemPrompt(agent.lockedPrompt);

  const screen = new LiveScreen(db, clock, agent.id, sessionId);
  const exec = async (act: Action): Promise<string> => {
    switch (act.action) {
      case "read_file":
        screen.read(act.path);
        return clip(await workspace.readFile(act.path));
      case "write_file":
        await workspace.writeFile(act.path, act.content);
        screen.write(act.path, act.content);
        testsPassed = null; // code changed since the last test run
        return `wrote ${act.path} (${act.content.length} chars)`;
      case "list_dir": {
        const listing = (await workspace.listDir(act.path)).join("\n") || "(empty)";
        screen.list(act.path, listing);
        return listing;
      }
      case "run_tests": {
        const r = await workspace.runTests(TEST_TIMEOUT_MS);
        testsPassed = r.ok;
        screen.tests(r.ok, r.output);
        return `${r.ok ? "TESTS PASSED" : "TESTS FAILED"}\n${clip(r.output, 2500)}`;
      }
      case "commit": {
        const sha = await workspace.commitAll(act.message);
        if (sha) commits.push(sha);
        screen.commit(act.message, sha);
        return sha ? `committed ${sha}` : "nothing to commit";
      }
      case "finish":
        return "ok";
    }
  };

  emit("session.start", { task: task.summary, model: agent.model, provider: inner.id });
  screen.start(task.summary);
  try {
    await workspace.startBranch(branch);
    // Memory: what earlier sessions did, as data appended to the first message.
    const memory = await buildMemory(db, agent.id, workspace);
    if (memory) {
      messages[0] = { role: "user", content: `${messages[0]!.content}\n\n${memory}` };
      const recalled = (memory.match(/^- /gm) ?? []).length;
      emit("session.memory", { chars: memory.length, sessions: recalled });
      if (recalled) screen.recall(recalled);
    }
    const pro = a.coding === "pro" && agent.model === "opus" && (a.llm.mode === "real" || !!a.proQuery);
    if (pro) {
      const r = await runPro({
        workspace,
        rules: system,
        prompt: messages[0]!.content,
        apiKey: a.llm.anthropic.apiKey ?? "",
        via: a.llm.anthropic.via,
        modelId: a.llm.anthropic.modelId,
        effort: a.llm.anthropic.effort,
        limits: a.limits,
        screen,
        isHalted: a.isHalted,
        onTests: (ok) => (testsPassed = ok),
        onWrite: () => (testsPassed = null), // code changed since the last test run
        queryFn: a.proQuery,
      });
      if (isFreeModel(a.llm.anthropic.modelId)) r.costMicroUsd = 0; // the SDK's estimate assumes a paid model
      proCost = r;
      insertLlmCall(db, clock, {
        sessionId,
        agentId: agent.id,
        provider: "agent-sdk",
        model: a.llm.anthropic.modelId,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        costMicroUsd: r.costMicroUsd,
        latencyMs: r.durationMs,
      });
      endReason = r.endReason;
      finishSummary = r.summary;
      emit("session.pro", { turns: r.turns, endReason: r.endReason, costMicroUsd: r.costMicroUsd });
      const sha = await workspace.commitAll(`feat: ${task.summary}`.slice(0, 120));
      if (sha) {
        commits.push(sha);
        screen.commit(`feat: ${task.summary}`.slice(0, 120), sha);
      }
    }
    let bad = 0;
    for (; !pro; ) {
      budget.step();
      const res = await llm.complete({ system, messages, maxTokens: 2000 });
      const parsed = parseAction(res.text);
      messages.push({ role: "assistant", content: res.text });
      if (!parsed.ok) {
        emit("session.bad_output", { error: parsed.error });
        if (++bad >= MAX_BAD_OUTPUTS) {
          endReason = "error:bad_output";
          break;
        }
        messages.push({
          role: "user",
          content: `Invalid action: ${parsed.error}. Reply with ONE JSON action.`,
        });
        continue;
      }
      const act = parsed.action;
      let result: string;
      try {
        result = await exec(act);
      } catch (e) {
        result = `ERROR: ${(e as Error).message}`;
      }
      emit("session.step", {
        action: act.action,
        path: "path" in act ? act.path : undefined,
        result: clip(result, 300),
      });
      if (act.action === "finish") {
        finishSummary = act.summary;
        break;
      }
      messages.push({ role: "user", content: clip(result) });
    }
  } catch (e) {
    if (e instanceof BudgetExceeded)
      endReason = e.reason === "killed" ? "killed" : `cap:${e.reason}`;
    else {
      endReason = "error";
      finishSummary = `Session failed: ${redactSecrets((e as Error).message)}`;
    }
  }

  // Never lose work: commit leftovers on the session branch, even after a cap or a kill.
  try {
    const wip = await workspace.commitAll(`wip: session ended (${endReason})`);
    if (wip) commits.push(wip);
    // The merge into main is the gateway's job (it needs a passing test report). Here we only
    // record that the task is complete.
    if (endReason === "finished" && testsPassed === true && commits.length > 0) {
      markTaskDone(db, clock, task.id);
    }
    headSha = await workspace.headSha();
  } catch (e) {
    emit("session.cleanup_error", { error: (e as Error).message });
  }

  const tests = testsPassed === null ? "not run" : testsPassed ? "passing" : "failing";
  const summary =
    finishSummary ||
    `Session ended (${endReason}) after ${proCost ? proCost.turns : budget.steps} step(s): ${commits.length} commit(s), tests ${tests}.`;
  const costCents = microUsdToCents(proCost ? proCost.costMicroUsd : budget.microUsd);
  endSession(db, clock, sessionId, {
    endReason,
    summary: redactSecrets(summary).slice(0, 1000),
    tokensIn: proCost ? proCost.tokensIn : budget.tokensIn,
    tokensOut: proCost ? proCost.tokensOut : budget.tokensOut,
    costCents,
  });
  setAgentState(db, agent.id, endReason === "killed" ? "halted" : "sleeping");
  emit("session.end", { endReason, commits: commits.length, tests, costCents });
  screen.end(endReason, tests, commits.length);
  await workspace.destroy().catch(() => {}); // stop any sandbox container; files and history stay

  return {
    sessionId,
    taskId: task.id,
    endReason,
    summary,
    branch,
    headSha,
    commits,
    testsPassed,
    costCents,
    tokens: proCost ? proCost.tokensIn + proCost.tokensOut : budget.tokens,
    steps: proCost ? proCost.turns : budget.steps,
  };
}
