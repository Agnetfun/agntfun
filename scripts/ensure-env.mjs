import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  console.log("Created .env from .env.example (gitignored).");
}

// Seal keys for agent wallets and tokens. Generated once; losing SEAL_PRIVATE_KEY makes every agent wallet unusable.
let env = readFileSync(".env", "utf8");
const has = (k) => new RegExp(`^${k}=.+$`, "m").test(env);
if (!has("SEAL_PUBLIC_KEY") || !has("SEAL_PRIVATE_KEY")) {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const priv = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const set = (k, v) => {
    env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
  };
  set("SEAL_PUBLIC_KEY", pub);
  set("SEAL_PRIVATE_KEY", priv);
  writeFileSync(".env", env);
  console.log("Generated SEAL_PUBLIC_KEY / SEAL_PRIVATE_KEY in .env. Back up SEAL_PRIVATE_KEY: it unlocks every agent wallet.");
}
