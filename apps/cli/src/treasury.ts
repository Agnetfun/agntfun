import { boot } from "@devagent/app";
import { getAgent, listAgents } from "@devagent/db";

// Operator commands: treasury status | topup <agent> <cents> | buy-credits <agent> <cents> <provider> | kill <agent|global> | unkill <agent|global>
const [cmd, ...args] = process.argv.slice(2);
const app = boot();
const op = process.env.OPERATOR_ID ?? "";
const agentArg = (s?: string) => {
  const a = s && (getAgent(app.db, s) ?? listAgents(app.db).find((x) => x.name === s));
  if (!a) throw new Error(`unknown agent ${s}`);
  return a.id;
};
try {
  if (cmd === "status") {
    for (const a of listAgents(app.db))
      console.log(
        JSON.stringify({
          agent: a.name,
          state: a.state,
          cashCents: app.treasury.cashCents(a.id),
          creditsCents: app.treasury.creditsCents(a.id),
          burnPerDay: Math.round(app.treasury.burnPerDay(a.id)),
          runwayDays: Number.isFinite(app.treasury.runwayDays(a.id))
            ? app.treasury.runwayDays(a.id).toFixed(1)
            : "n/a",
          halted: app.kill.isHalted(a.id),
        }),
      );
  } else if (cmd === "topup")
    app.treasury.topUp(agentArg(args[0]), Number(args[1]), `cli:${op || "anon"}`);
  else if (cmd === "buy-credits")
    app.treasury.buyCredits(agentArg(args[0]), Number(args[1]), op, args[2] ?? "anthropic");
  else if (cmd === "kill")
    app.kill.trip(
      args[0] === "global" ? "global" : agentArg(args[0]),
      op || "cli",
      "operator command",
    );
  else if (cmd === "unkill")
    app.kill.clear(args[0] === "global" ? "global" : agentArg(args[0]), op || "cli");
  else
    console.log(
      "usage: treasury status | topup <agent> <cents> | buy-credits <agent> <cents> [provider] | kill <agent|global> | unkill <agent|global>",
    );
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  app.close();
}
