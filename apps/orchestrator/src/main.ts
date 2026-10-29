import { ConfigError, systemClock } from "@devagent/core";
import { appendEvent, listAgents } from "@devagent/db";
import { ActionGateway, adaptersFromEnv } from "@devagent/gateway";
import {
  boot,
  communityTick,
  makeChainTick,
  makePriceTick,
  makeRunOnce,
  openRouterCreditsLeft,
  sandboxModeFromEnv,
} from "@devagent/app";
import { Scheduler } from "@devagent/scheduler";

let app;
try {
  app = boot();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

if (process.argv.includes("--once")) {
  app.close();
  process.exit(0);
}

// This process is the gateway: it alone builds the real adapters and holds the private seal key.
const adapters = adaptersFromEnv(app.db);
app.log.info({ vcs: adapters.vcsMode, social: adapters.socialMode, llm: app.config.llm.mode }, "adapters");
const gateway = new ActionGateway(app.db, systemClock, app.kill, adapters.vcs, adapters.social);
const scheduler = new Scheduler(
  app.db,
  systemClock,
  app.treasury,
  app.kill,
  makeRunOnce(app, gateway, sandboxModeFromEnv()),
);
const intervalMs = (Number(process.env.AGENT_INTERVAL_MINUTES) || 360) * 60_000;
const chainTick = makeChainTick(app);
const chainEveryMs = (Number(process.env.CHAIN_POLL_SECONDS) || 60) * 1000;
let lastChain = 0;

// Prices run apart from the main loop so a long session or a slow fee payout never stalls the chart.
const priceTick = makePriceTick(app);
const priceEveryMs = Math.max(5, Number(process.env.PRICE_POLL_SECONDS) || 10) * 1000;
let pricing = false;
const priceTimer = setInterval(async () => {
  if (pricing) return;
  pricing = true;
  try {
    await priceTick();
  } catch (e) {
    app.log.warn({ err: e instanceof Error ? e.message : String(e) }, "price sample failed");
  } finally {
    pricing = false;
  }
}, priceEveryMs);

// OpenRouter credit watch: warn the owner before agents run dry (top up with crypto on openrouter.ai).
const orKey = process.env.OPENROUTER_MANAGEMENT_KEY;
const orLowUsd = Number(process.env.OPENROUTER_LOW_USD) || 10;
const checkCredits = async () => {
  if (!orKey) return;
  try {
    const left = await openRouterCreditsLeft(orKey);
    if (left < orLowUsd) {
      app.log.warn({ creditsUsd: Math.round(left * 100) / 100 }, "OpenRouter credits are low: top up at openrouter.ai/settings/credits");
      appendEvent(app.db, systemClock, { type: "llm.credits_low", payload: { creditsUsd: left } });
    } else app.log.info({ creditsUsd: Math.round(left * 100) / 100 }, "OpenRouter credits");
  } catch (e) {
    app.log.warn({ err: e instanceof Error ? e.message : String(e) }, "OpenRouter credit check failed");
  }
};
void checkCredits();
const creditTimer = setInterval(checkCredits, 3_600_000);

let busy = false;
const timer = setInterval(async () => {
  appendEvent(app.db, systemClock, { type: "orchestrator.heartbeat" });
  app.log.debug("heartbeat");
  if (busy) return;
  busy = true;
  try {
    if (Date.now() - lastChain >= chainEveryMs) {
      lastChain = Date.now();
      const c = await chainTick();
      if (c.wallets || c.booked || c.feePayouts || c.buyback) app.log.info(c, "chain");
    }
    const k = await communityTick(app, adapters);
    if (k.collected || k.accepted || k.promoted) app.log.info(k, "community");
    for (const a of listAgents(app.db)) scheduler.schedule(a.id, intervalMs); // keeps existing wake times
    const r = await scheduler.tick();
    if (r.ran.length || r.skipped.length) app.log.info(r, "tick");
  } catch (e) {
    app.log.error({ err: e instanceof Error ? e.message : String(e) }, "tick failed");
  } finally {
    busy = false;
  }
}, app.config.heartbeatSeconds * 1000);

const stop = () => {
  clearInterval(timer);
  clearInterval(priceTimer);
  clearInterval(creditTimer);
  app.log.info("shutting down");
  app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
