import { boot } from "@devagent/app";
import { dismissReports, restore, takedown } from "@devagent/platform";
import { systemClock } from "@devagent/core";

// Operator commands: moderate list | takedown <agentId> <reason> | restore <agentId> | dismiss <agentId>
const [cmd, id, ...rest] = process.argv.slice(2);
const app = boot();
const op = process.env.OPERATOR_ID ?? "";
const operators = (process.env.OPERATOR_IDS ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
try {
  if (cmd === "list") {
    const rows = app.db
      .prepare(
        "SELECT a.id, a.name, a.removed_at removed, COUNT(r.id) open FROM agents a JOIN reports r ON r.agent_id=a.id AND r.status='open' GROUP BY a.id ORDER BY open DESC",
      )
      .all();
    for (const r of rows) console.log(JSON.stringify(r));
  } else if (cmd === "takedown" && id)
    takedown(app.db, systemClock, app.kill, operators, id, op, rest.join(" ") || "operator action");
  else if (cmd === "restore" && id) restore(app.db, systemClock, app.kill, operators, id, op);
  else if (cmd === "dismiss" && id) dismissReports(app.db, operators, id, op);
  else
    console.log(
      "usage: moderate list | takedown <agentId> <reason> | restore <agentId> | dismiss <agentId>",
    );
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  app.close();
}
