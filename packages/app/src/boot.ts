import { createLogger, loadConfig, systemClock, type Config, type Logger } from "@devagent/core";
import { KillSwitch } from "@devagent/safety";
import { Treasury } from "@devagent/treasury";
import { appendEvent, migrate, openDb, type Db } from "@devagent/db";

export interface Booted {
  config: Config;
  log: Logger;
  db: Db;
  kill: KillSwitch;
  treasury: Treasury;
  close(): void;
}

/** Phase 0 boot: validated config, logger, migrated database. No agent logic yet. */
export function boot(
  env: Record<string, string | undefined> = process.env,
  destination?: { write(chunk: string): void },
): Booted {
  const config = loadConfig(env); // throws ConfigError before anything else starts
  const log = createLogger({ service: "orchestrator", level: config.logLevel, destination });
  const db = openDb(config.dbPath);
  const applied = migrate(db, systemClock);
  appendEvent(db, systemClock, {
    type: "orchestrator.boot",
    payload: { applied, cluster: config.solanaCluster },
  });
  log.info({ applied, cluster: config.solanaCluster, dbPath: config.dbPath }, "orchestrator ready");
  const operators = (env.OPERATOR_IDS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const treasury = new Treasury(db, systemClock, operators, {
    dailyCapCents: Number(env.DAILY_CAP_CENTS) || 500,
    minRunwayDays: 0.5,
    // Largest possible session: the LLM cap plus one post with a link (placeholder price, see publisher/costs).
    sessionReserveCents: config.session.maxCents + 20,
  });
  return {
    config,
    log,
    db,
    kill: new KillSwitch(db, systemClock),
    treasury,
    close: () => db.close(),
  };
}
