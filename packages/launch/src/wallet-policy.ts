import { ulid, type Clock } from "@devagent/core";
import type { Db } from "@devagent/db";
import { PublicKey } from "@solana/web3.js";

/**
 * Money leaving an agent wallet (Bankr style controls, enforced in code):
 * a recipient must be on the agent's allowlist, and a newly added recipient only works after a cooldown,
 * so a stolen operator session cannot drain a wallet at once. Each send and each rolling 24 hours are capped.
 * The kill switch pauses all outflows. Every send is logged in an append only table.
 */
export interface WalletPolicy {
  perTxLamports: number;
  dailyLamports: number;
  cooldownMs: number;
}
const SOL = 1_000_000_000;
export const DEFAULT_WALLET_POLICY: WalletPolicy = {
  perTxLamports: 2 * SOL,
  dailyLamports: 5 * SOL,
  cooldownMs: 24 * 3_600_000,
};

export function policyFromEnv(env: Record<string, string | undefined> = process.env): WalletPolicy {
  const sol = (k: string, d: number) => (Number(env[k]) > 0 ? Math.round(Number(env[k]) * SOL) : d);
  return {
    perTxLamports: sol("WALLET_MAX_SEND_SOL", DEFAULT_WALLET_POLICY.perTxLamports),
    dailyLamports: sol("WALLET_MAX_DAILY_SOL", DEFAULT_WALLET_POLICY.dailyLamports),
    // Never zero: a cooldown is what stops a stolen operator session from draining a wallet at once.
    cooldownMs: (Number(env.WALLET_ALLOW_COOLDOWN_HOURS) > 0 ? Number(env.WALLET_ALLOW_COOLDOWN_HOURS) : 24) * 3_600_000,
  };
}

export type OutflowCheck = { ok: true } | { ok: false; reason: string };

export function allowRecipient(
  db: Db,
  clock: Clock,
  agentId: string,
  address: string,
  operator: string,
  p: WalletPolicy,
): number {
  const a = new PublicKey(address).toBase58(); // throws on a malformed address
  const usableAt = clock.now() + p.cooldownMs;
  db.prepare(
    "INSERT OR REPLACE INTO wallet_allowlist (agent_id, address, added_at, usable_at, added_by) VALUES (?,?,?,?,?)",
  ).run(agentId, a, clock.now(), usableAt, operator);
  return usableAt;
}

export function removeRecipient(db: Db, agentId: string, address: string): void {
  db.prepare("DELETE FROM wallet_allowlist WHERE agent_id=? AND address=?").run(agentId, address);
}

export function listRecipients(db: Db, agentId: string) {
  return db
    .prepare("SELECT address, usable_at FROM wallet_allowlist WHERE agent_id=? ORDER BY added_at")
    .all(agentId) as { address: string; usable_at: number }[];
}

export function checkOutflow(
  db: Db,
  clock: Clock,
  agentId: string,
  to: string,
  lamports: number,
  p: WalletPolicy,
  isPaused: () => boolean,
): OutflowCheck {
  if (isPaused()) return { ok: false, reason: "paused" };
  if (!Number.isInteger(lamports) || lamports <= 0) return { ok: false, reason: "invalid amount" };
  const r = db
    .prepare("SELECT usable_at FROM wallet_allowlist WHERE agent_id=? AND address=?")
    .get(agentId, to) as { usable_at: number } | undefined;
  if (!r) return { ok: false, reason: "recipient not on the allowlist" };
  if (r.usable_at > clock.now()) return { ok: false, reason: "recipient is still in its cooldown" };
  if (lamports > p.perTxLamports) return { ok: false, reason: "over the per send limit" };
  const day = (
    db
      .prepare("SELECT COALESCE(SUM(lamports),0) s FROM wallet_outflows WHERE agent_id=? AND ts > ?")
      .get(agentId, clock.now() - 24 * 3_600_000) as { s: number }
  ).s;
  if (day + lamports > p.dailyLamports) return { ok: false, reason: "daily limit reached" };
  return { ok: true };
}

export function recordOutflow(
  db: Db,
  clock: Clock,
  agentId: string,
  to: string,
  lamports: number,
  operator: string,
  signature: string | null,
): void {
  db.prepare(
    "INSERT INTO wallet_outflows (id, agent_id, ts, to_address, lamports, operator, signature) VALUES (?,?,?,?,?,?,?)",
  ).run(ulid(clock.now()), agentId, clock.now(), to, lamports, operator, signature);
}
