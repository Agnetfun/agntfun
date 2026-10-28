import { boot } from "@devagent/app";
import { systemClock } from "@devagent/core";
import { getAgent, listAgents } from "@devagent/db";
import {
  AUTH_FAILURE,
  SealedVault,
  TokenSource,
  appsFromEnv,
  connectionHealth,
  hasCredential,
  markCredentialError,
  markCredentialOk,
  storeCredential,
  whoAmI,
  type CredentialKind,
} from "@devagent/gateway";

// Agent account tokens (gateway side).
//   creds set <agent> github|x <token>   store a token by hand (sealed); the website's Connect buttons are the usual way
//   creds status                         which agents have which accounts, and whether they still work
//   creds check [agent]                  really log in with each connected account (refreshing X tokens) and report
const [cmd, first, kind, token] = process.argv.slice(2);
const app = boot();
const find = (x?: string) => {
  const a = x && (getAgent(app.db, x) ?? listAgents(app.db).find((y) => y.name === x));
  if (!a) throw new Error(`unknown agent ${x}`);
  return a;
};

async function check(agentId: string, name: string) {
  const pub = process.env.SEAL_PUBLIC_KEY;
  const priv = process.env.SEAL_PRIVATE_KEY;
  if (!pub || !priv) throw new Error("SEAL_PUBLIC_KEY and SEAL_PRIVATE_KEY are needed (run pnpm predev)");
  const tokens = new TokenSource(app.db, systemClock, new SealedVault(app.db, priv), pub, appsFromEnv());
  for (const k of ["github", "x"] as CredentialKind[]) {
    if (!hasCredential(app.db, agentId, k)) {
      console.log(`${name}  ${k}: not connected`);
      continue;
    }
    try {
      const t = await tokens.get(agentId, k);
      if (!t) throw new Error(`no ${k} token`);
      const who = await whoAmI(k, t);
      let extra = "";
      if (k === "github") {
        // Classic OAuth tokens list their scopes in a response header.
        const r = await fetch("https://api.github.com/user", {
          headers: { authorization: `Bearer ${t}`, "user-agent": "devagent" },
        });
        const scopes = r.headers.get("x-oauth-scopes") ?? "";
        extra = /\b(public_repo|repo)\b/.test(scopes) ? `, can push (${scopes})` : `, MISSING public_repo (has: ${scopes || "none"})`;
      }
      markCredentialOk(app.db, systemClock, agentId, k);
      console.log(`${name}  ${k}: OK as @${who}${extra}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (AUTH_FAILURE.test(msg)) markCredentialError(app.db, systemClock, agentId, k, msg);
      console.log(`${name}  ${k}: FAILED (${msg.slice(0, 120)})${AUTH_FAILURE.test(msg) ? " -> needs reconnect" : ""}`);
    }
  }
}

try {
  if (cmd === "set") {
    const a = find(first);
    if (kind !== "github" && kind !== "x") throw new Error("kind must be github or x");
    if (!token) throw new Error("missing token");
    const key = process.env.SEAL_PUBLIC_KEY;
    if (!key) throw new Error("SEAL_PUBLIC_KEY is not set (run pnpm predev)");
    storeCredential(app.db, systemClock, key, a.id, kind as CredentialKind, token);
    console.log(`stored ${kind} token for ${a.name} (sealed)`);
  } else if (cmd === "status") {
    for (const a of listAgents(app.db)) {
      const h = connectionHealth(app.db, a.id);
      const show = (k: CredentialKind) =>
        h[k].account ? `@${h[k].account}${h[k].needsReconnect ? " (NEEDS RECONNECT)" : ""}` : "no";
      console.log(`${a.name}  github:${show("github")}  x:${show("x")}`);
    }
  } else if (cmd === "check") {
    const list = first ? [find(first)] : listAgents(app.db);
    for (const a of list) await check(a.id, a.name);
  } else console.log("usage: creds set <agent> github|x <token> | creds status | creds check [agent]");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  app.close();
}
