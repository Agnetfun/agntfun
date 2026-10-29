import { boot, openWorkspace, sandboxModeFromEnv } from "@devagent/app";
import { ConfigError, MODEL_CHOICES, systemClock, type ModelChoice } from "@devagent/core";
import { createAgent, listAgents } from "@devagent/db";
import { ActionGateway, adaptersFromEnv } from "@devagent/gateway";
import { maxPostCentsFromEnv, publishSession } from "@devagent/publisher";
import { runSession, syncTasksFromFile } from "@devagent/runner";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1]! : def;
};

async function agentRun() {
  const model = flag("model", "opus") as ModelChoice;
  if (!MODEL_CHOICES.includes(model))
    throw new Error(`--model must be one of ${MODEL_CHOICES.join(", ")}`);
  const app = boot();
  const { db, config } = app;
  const name = flag("name", `demo-${model}`);
  const agent =
    listAgents(db).find((a) => a.name === name) ??
    createAgent(db, systemClock, {
      name,
      model,
      lockedPrompt: "Build small, tested JavaScript modules.",
      repo: `demo/${name}`,
    });
  if (!agent.repo) db.prepare("UPDATE agents SET repo=? WHERE id=?").run(`demo/${name}`, agent.id);
  const added = syncTasksFromFile(db, systemClock, agent.id, flag("task", "tasks/toy.md"));
  const workspace = await openWorkspace(sandboxModeFromEnv(), agent.id, process.env.SANDBOX_IMAGE || undefined);
  const r = await runSession({
    db,
    clock: systemClock,
    agentId: agent.id,
    llm: config.llm,
    limits: config.session,
    workspace,
    isHalted: () => app.kill.isHalted(agent.id),
  });
  const adapters = adaptersFromEnv(db); // VCS_MODE / SOCIAL_MODE pick local, real or mock
  const gateway = new ActionGateway(db, systemClock, app.kill, adapters.vcs, adapters.social);
  const published = await publishSession(
    { db, clock: systemClock, gateway, workspace, maxPostCents: maxPostCentsFromEnv() },
    r,
  );
  console.log(
    JSON.stringify(
      {
        agent: agent.name,
        model: agent.model,
        llmMode: config.llm.mode,
        newTasks: added,
        ...r,
        published,
      },
      null,
      2,
    ),
  );
  app.close();
  process.exit(r.endReason === "finished" || r.endReason === "no_task" ? 0 : 2);
}

const commands: Record<string, () => Promise<void>> = { "agent:run": agentRun };

try {
  const fn = cmd ? commands[cmd] : undefined;
  if (!fn) {
    console.error(
      `usage: cli <${Object.keys(commands).join("|")}> [--model opus|astra] [--task file] [--name n]`,
    );
    process.exit(1);
  }
  await fn();
} catch (e) {
  console.error(e instanceof ConfigError ? e.message : (e as Error).message);
  process.exit(1);
}
