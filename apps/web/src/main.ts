import { ConfigError, systemClock } from "@devagent/core";
import { boot, rpcUrl } from "@devagent/app";
import { ChainMarket, DemoMarket } from "@devagent/dashboard";
import { ChainBalances, ensurePlatformWallet, getLaunch, type TokenRpc } from "@devagent/launch";
import { DEFAULT_DEPLOY } from "@devagent/platform";
import { Connection, PublicKey } from "@solana/web3.js";
import { appsFromEnv } from "@devagent/gateway";
import { createConnectRoutes } from "./connect-routes";
import { createTradeRoutes } from "./trade-routes";
import { createDappRoutes } from "./dapp-routes";
import { createWebServer } from "./server";

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
const env = process.env;
const port = Number(env.WEB_PORT) || 3000;
const host = env.WEB_HOST || "127.0.0.1";
const rpc = new Connection(rpcUrl(app), "confirmed");
// Voting weight is read from the chain, only for real (devnet or localnet) launches. Mocks and no launch: no voting.
const tokenRpc: TokenRpc = {
  getParsedTokenAccountsByOwner: (owner, filter) =>
    rpc.getParsedTokenAccountsByOwner(owner as PublicKey, {
      mint: filter.mint as PublicKey,
    }) as unknown as ReturnType<TokenRpc["getParsedTokenAccountsByOwner"]>,
};
if (app.config.solanaCluster === "mainnet-beta") {
  app.log.warn("MAINNET: launches and agent wallets use real SOL");
  if (!env.INFRA_WALLET) app.log.warn("INFRA_WALLET is empty: mainnet launches are refused until it is set");
  if (!env.SOLANA_RPC_URL) app.log.warn("SOLANA_RPC_URL is empty: the public mainnet RPC is rate limited");
}
if (!env.SEAL_PUBLIC_KEY) app.log.warn("SEAL_PUBLIC_KEY is not set: new agents get no wallet (run pnpm predev)");
if (env.SEAL_PRIVATE_KEY && env.WEB_STRICT_KEYS === "1")
  throw new Error("The web server must not hold SEAL_PRIVATE_KEY in production");
const dapp = createDappRoutes({
  db: app.db,
  clock: systemClock,
  rpc,
  sealPublicKey: env.SEAL_PUBLIC_KEY,
  launch: {
    cluster: app.config.solanaCluster,
    publicUrl: env.PUBLIC_URL || `http://${host}:${port}`,
    infraWallet: env.INFRA_WALLET || undefined,
    // The buyback wallet is platform owned and sealed; the web server only needs its address.
    buybackWallet: env.SEAL_PUBLIC_KEY
      ? ensurePlatformWallet(app.db, systemClock, env.SEAL_PUBLIC_KEY, "buyback")
      : undefined,
  },
  vcsMode: env.VCS_MODE || "auto",
  socialMode: env.SOCIAL_MODE || "auto",
  platformToken: env.PLATFORM_TOKEN_MINT
    ? { mint: env.PLATFORM_TOKEN_MINT, symbol: env.PLATFORM_TOKEN_SYMBOL || "TOKEN" }
    : undefined,
  trade: createTradeRoutes({ db: app.db, clock: systemClock, rpc }),
  connect: createConnectRoutes({
    db: app.db,
    clock: systemClock,
    apps: appsFromEnv(env),
    sealPublicKey: env.SEAL_PUBLIC_KEY,
    // Same base the OAuth redirect uses, so the setup hint shows the exact callback to register.
    publicUrl: (env.PUBLIC_URL || `http://${env.WEB_HOST || "127.0.0.1"}:${env.WEB_PORT || 3000}`).replace(/\/+$/, ""),
  }),
});
const web = createWebServer({
  db: app.db,
  treasury: app.treasury,
  kill: app.kill,
  dapp,
  market: env.MARKET === "demo" ? new DemoMarket() : new ChainMarket(app.db, Number(env.SOL_USD) || 150),
  deploy: { ...DEFAULT_DEPLOY, org: env.GITHUB_ORG || DEFAULT_DEPLOY.org },
  balancesFor: (agentId) => {
    const l = getLaunch(app.db, agentId);
    if (!l || l.cluster === "mock") return undefined;
    return new ChainBalances(tokenRpc, new PublicKey(l.mint), (w) => new PublicKey(w));
  },
  trustProxy: env.TRUST_PROXY === "1",
});
web.server.listen(port, host, () => app.log.info({ port, host }, "web ready"));
const stop = () => {
  web.close();
  app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
