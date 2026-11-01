// Mainnet test mode on this PC: its own settings (.env.mainnet), database and wallet keys, so devnet stays untouched.
// First run: creates .env.mainnet from .env (keeps model, Privy and account app keys; fresh seal keys; mainnet switches).
// Every run: refuses to start until the mainnet-only values are filled in. Both files are gitignored.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const FILE = ".env.mainnet";
const set = (env, k, v) =>
  new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
const get = (env, k) => (new RegExp(`^${k}=(.*)$`, "m").exec(env)?.[1] ?? "").trim();

if (!existsSync(FILE)) {
  if (!existsSync(".env")) {
    console.error("No .env yet: run pnpm local once first.");
    process.exit(1);
  }
  let env = readFileSync(".env", "utf8");
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const values = {
    SOLANA_CLUSTER: "mainnet-beta",
    REAL_MONEY: "1",
    DB_PATH: "./data/mainnet.db",
    SOLANA_RPC_URL: "",
    PUBLIC_URL: "",
    INFRA_WALLET: "",
    TRUST_PROXY: "1",
    // Fresh keys: mainnet agent wallets are separate from devnet ones. BACK UP SEAL_PRIVATE_KEY.
    SEAL_PUBLIC_KEY: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    SEAL_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
  for (const [k, v] of Object.entries(values)) env = set(env, k, v);
  writeFileSync(FILE, `# MAINNET test settings (real SOL). Created from .env by scripts/make-mainnet-env.mjs.\n${env}`);
  console.log(`Created ${FILE} with fresh wallet keys. Back up its SEAL_PRIVATE_KEY: it unlocks every mainnet agent wallet.`);
}

const env = readFileSync(FILE, "utf8");
const missing = [];
if (!/^https:\/\//.test(get(env, "SOLANA_RPC_URL")) || /devnet/.test(get(env, "SOLANA_RPC_URL")))
  missing.push("SOLANA_RPC_URL  a MAINNET RPC, e.g. https://mainnet.helius-rpc.com/?api-key=YOUR_KEY");
if (!/^https:\/\/[^/]+$/.test(get(env, "PUBLIC_URL")))
  missing.push("PUBLIC_URL      your public https address (tunnel or domain), no trailing slash");
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(get(env, "INFRA_WALLET")))
  missing.push("INFRA_WALLET    your Solana address that receives the 10% infra share");
if (missing.length) {
  console.error(`\nMainnet mode needs these in ${FILE}:\n  ${missing.join("\n  ")}\n`);
  process.exit(1);
}
console.log(`MAINNET: real SOL. Settings ${FILE}, database ${get(env, "DB_PATH") || "./data/devagent.db"}, site ${get(env, "PUBLIC_URL")}`);
