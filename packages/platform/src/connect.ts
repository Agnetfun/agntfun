import type { Clock } from "@devagent/core";
import { verifyWalletSignature } from "@devagent/community";
import { appendEvent, type Db } from "@devagent/db";
import {
  authorizeUrl,
  exchangeCode,
  newState,
  pkce,
  removeCredential,
  storeCredential,
  whoAmI,
  type CredentialKind,
  type OAuthApp,
} from "@devagent/gateway";

/**
 * "Connect X" / "Connect GitHub" for an agent's own accounts.
 * Only the wallet that created the agent may connect or disconnect, proven by a fresh signed message with a
 * single use nonce. The login state is random, single use and expires in 15 minutes; PKCE binds the code to it.
 * Tokens are sealed the moment they arrive (the web server cannot read them back); only names are public.
 */
export type ConnectRequest = {
  agentId: string;
  kind: CredentialKind;
  wallet: string;
  signature: string;
  nonce: string;
  ts: number;
};
type Apps = Partial<Record<CredentialKind, OAuthApp>>;
const STATE_TTL = 15 * 60_000;
const SIG_TTL = 10 * 60_000;

export const connectMessage = (agentId: string, kind: string, nonce: string, ts: number) =>
  `devagent-connect:v1:${agentId}:${kind}:${nonce}:${ts}`;
export const disconnectMessage = (agentId: string, kind: string, nonce: string, ts: number) =>
  `devagent-disconnect:v1:${agentId}:${kind}:${nonce}:${ts}`;

function authorize(db: Db, clock: Clock, r: ConnectRequest, message: string): string | undefined {
  if (r.kind !== "x" && r.kind !== "github") return "Unknown account type.";
  const a = db.prepare("SELECT deployer, removed_at FROM agents WHERE id=?").get(r.agentId) as
    | { deployer: string | null; removed_at: number | null }
    | undefined;
  if (!a || a.removed_at) return "Agent not found.";
  if (!a.deployer || a.deployer !== r.wallet) return "Only the wallet that created this agent can do this.";
  const now = clock.now();
  if (!Number.isFinite(r.ts) || now - r.ts > SIG_TTL || r.ts - now > 60_000) return "The signature is too old. Sign again.";
  if (typeof r.nonce !== "string" || !/^[A-Za-z0-9]{8,64}$/.test(r.nonce)) return "Missing or invalid nonce.";
  if (!verifyWalletSignature(r.wallet, message, r.signature)) return "The signature does not match this wallet.";
  try {
    db.prepare("INSERT INTO deploy_nonces (nonce, ts) VALUES (?,?)").run(`c:${r.nonce}`, now);
  } catch {
    return "This request was already used.";
  }
  return undefined;
}

export function startConnect(
  db: Db,
  clock: Clock,
  apps: Apps,
  r: ConnectRequest,
): { ok: true; url: string } | { ok: false; reason: string } {
  const app = apps[r.kind];
  if (!app) return { ok: false, reason: `Connecting ${r.kind === "x" ? "X" : "GitHub"} is not set up on this site yet.` };
  const bad = authorize(db, clock, r, connectMessage(r.agentId, r.kind, r.nonce, r.ts));
  if (bad) return { ok: false, reason: bad };
  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(clock.now() - STATE_TTL);
  const state = newState();
  const { verifier, challenge } = pkce();
  db.prepare("INSERT INTO oauth_states (state, agent_id, kind, verifier, created_at) VALUES (?,?,?,?,?)").run(
    state,
    r.agentId,
    r.kind,
    verifier,
    clock.now(),
  );
  return { ok: true, url: authorizeUrl(r.kind, app, state, challenge) };
}

export async function finishConnect(
  db: Db,
  clock: Clock,
  apps: Apps,
  sealPublicKey: string,
  kind: CredentialKind,
  code: string,
  state: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; agentId: string; account: string } | { ok: false; reason: string; agentId?: string }> {
  const s = db.prepare("SELECT agent_id, kind, verifier, created_at FROM oauth_states WHERE state=?").get(state) as
    | { agent_id: string; kind: string; verifier: string; created_at: number }
    | undefined;
  if (s) db.prepare("DELETE FROM oauth_states WHERE state=?").run(state); // single use, whatever happens next
  if (!s || s.kind !== kind) return { ok: false, reason: "This login link is not valid. Start again." };
  if (clock.now() - s.created_at > STATE_TTL) return { ok: false, reason: "This login took too long. Start again.", agentId: s.agent_id };
  const app = apps[kind];
  if (!app || !code) return { ok: false, reason: "The login did not finish.", agentId: s.agent_id };
  const tokens = await exchangeCode(kind, app, code, s.verifier, fetchFn);
  const account = await whoAmI(kind, tokens.access, fetchFn);
  storeCredential(db, clock, sealPublicKey, s.agent_id, kind, JSON.stringify(tokens), account);
  if (kind === "x") db.prepare("UPDATE agents SET x_handle=? WHERE id=?").run(account, s.agent_id);
  else {
    // The agent's repo moves to its own account; earlier local work seeds it on the first push.
    const a = db.prepare("SELECT repo, repo_prev FROM agents WHERE id=?").get(s.agent_id) as { repo: string | null; repo_prev: string | null };
    const name = (a.repo ?? s.agent_id.toLowerCase()).split("/").pop()!;
    const next = `${account}/${name}`;
    if (a.repo !== next)
      db.prepare("UPDATE agents SET repo=?, repo_prev=COALESCE(repo_prev, ?) WHERE id=?").run(next, a.repo, s.agent_id);
  }
  appendEvent(db, clock, { type: "account.connected", agentId: s.agent_id, payload: { kind, account } });
  return { ok: true, agentId: s.agent_id, account };
}

export function disconnect(db: Db, clock: Clock, r: ConnectRequest): { ok: true } | { ok: false; reason: string } {
  const bad = authorize(db, clock, r, disconnectMessage(r.agentId, r.kind, r.nonce, r.ts));
  if (bad) return { ok: false, reason: bad };
  removeCredential(db, r.agentId, r.kind);
  appendEvent(db, clock, { type: "account.disconnected", agentId: r.agentId, payload: { kind: r.kind } });
  return { ok: true };
}
