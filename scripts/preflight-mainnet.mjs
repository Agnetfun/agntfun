// Mainnet preflight: checks production settings before real money moves. Exits 1 on any blocking problem.
//   pnpm preflight /etc/devagent/app.env /etc/devagent/orchestrator.env
// The first file is what the website reads, so it must not hold SEAL_PRIVATE_KEY.
import { existsSync, readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: pnpm preflight <app.env> [orchestrator.env]");
  process.exit(2);
}

const parse = (file) => {
  if (!existsSync(file)) throw new Error(`missing file ${file}`);
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
};

const app = parse(files[0]);
const env = Object.assign({}, ...files.map(parse));
const errors = [];
const warnings = [];
const need = (ok, msg) => ok || errors.push(msg);
const wish = (ok, msg) => ok || warnings.push(msg);
const base58 = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s ?? "");

need(env.SOLANA_CLUSTER === "mainnet-beta", "SOLANA_CLUSTER must be mainnet-beta");
need(env.REAL_MONEY === "1", "REAL_MONEY must be 1");
need(/^https:\/\//.test(env.SOLANA_RPC_URL ?? ""), "SOLANA_RPC_URL must be an https mainnet RPC (for example Helius)");
need(!/api\.mainnet-beta\.solana\.com/.test(env.SOLANA_RPC_URL ?? ""), "SOLANA_RPC_URL: the public mainnet RPC is too rate limited");
need(!/devnet|testnet/.test(env.SOLANA_RPC_URL ?? ""), "SOLANA_RPC_URL points at devnet or testnet");
need(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(env.PUBLIC_URL ?? ""), "PUBLIC_URL must be https://your.domain (no path, no trailing slash)");
need(!/localhost|127\.0\.0\.1/.test(env.PUBLIC_URL ?? ""), "PUBLIC_URL cannot be localhost");
need(env.WEB_STRICT_KEYS === "1", "WEB_STRICT_KEYS must be 1");
need(!app.SEAL_PRIVATE_KEY, `${files[0]} (read by the website) must not contain SEAL_PRIVATE_KEY`);
need(!!env.SEAL_PUBLIC_KEY && !!env.SEAL_PRIVATE_KEY, "SEAL_PUBLIC_KEY and SEAL_PRIVATE_KEY must both be set");
need(base58(env.INFRA_WALLET), "INFRA_WALLET must be a Solana address (mainnet launches are refused without it)");
need(env.PROMOTE_UNVOTED_WHEN_IDLE !== "1", "PROMOTE_UNVOTED_WHEN_IDLE must be 0: in production ideas need holder votes");
need((env.SANDBOX || "docker") === "docker", "SANDBOX must be docker: agent code must run isolated");
need(env.LLM_MODE === "real", "LLM_MODE must be real");
need(!!(env.OPENROUTER_API_KEY || env.ANTHROPIC_API_KEY), "set OPENROUTER_API_KEY or ANTHROPIC_API_KEY");
wish(!env.PLATFORM_TOKEN_MINT || base58(env.PLATFORM_TOKEN_MINT), "PLATFORM_TOKEN_MINT does not look like a mint address");
wish(!!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET), "GitHub app keys empty: creators cannot connect GitHub");
wish(!!(env.X_CLIENT_ID && env.X_CLIENT_SECRET), "X app keys empty: creators cannot connect X");
wish(Number(env.VOTE_MIN_VOTERS || 3) >= 2, "VOTE_MIN_VOTERS below 2 lets one wallet decide alone");
wish(!(env.OPENROUTER_MODEL_ID || "").endsWith(":free"), "OPENROUTER_MODEL_ID is a free test model");
wish(env.CLIENT_DEBUG !== "1", "CLIENT_DEBUG=1 forwards browser errors to the server: a test switch, turn it off for launch");

for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`FAIL  ${e}`);
if (errors.length) {
  console.log(`\nPreflight failed: ${errors.length} problem(s). Nothing is safe to run on mainnet yet.`);
  process.exit(1);
}
console.log(`\nPreflight passed${warnings.length ? ` with ${warnings.length} warning(s)` : ""}. Ready for mainnet.`);
