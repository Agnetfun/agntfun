import { createPublicKey, verify } from "node:crypto";
import { ulid, type Clock } from "@devagent/core";
import type { Db } from "@devagent/db";
import { base58Decode } from "./base58";

/** Token balance of a wallet for an agent's token. Mock now; the real one reads the chain (Phase 6). */
export interface BalanceProvider {
  balanceOf(wallet: string): Promise<number>;
}
export class MockBalances implements BalanceProvider {
  constructor(public balances: Record<string, number> = {}) {}
  async balanceOf(w: string) {
    return this.balances[w] ?? 0;
  }
}

export const voteMessage = (agentId: string, suggestionId: string) =>
  `devagent-vote:v1:${agentId}:${suggestionId}`;

// Wraps a raw 32 byte ed25519 public key (a Solana address) for node:crypto.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyWalletSignature(wallet: string, message: string, sigBase64: string): boolean {
  try {
    const raw = base58Decode(wallet);
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(message), key, Buffer.from(sigBase64, "base64"));
  } catch {
    return false;
  }
}

export interface VoteOptions {
  minBalance: number;
}
export const DEFAULT_VOTE_OPTIONS: VoteOptions = { minBalance: 1000 };

export type VoteResult = { ok: true; weight: number } | { ok: false; reason: string };

/**
 * Weight is the wallet balance, linear and uncapped. Splitting a balance across wallets therefore gains nothing,
 * and wallets under the minimum count for nothing. See DECISIONS D13.
 */
export async function castVote(
  db: Db,
  clock: Clock,
  balances: BalanceProvider,
  v: { agentId: string; suggestionId: string; wallet: string; signature: string },
  opts: VoteOptions = DEFAULT_VOTE_OPTIONS,
): Promise<VoteResult> {
  const s = db
    .prepare("SELECT status, agent_id FROM suggestions WHERE id=?")
    .get(v.suggestionId) as { status: string; agent_id: string } | undefined;
  if (!s || s.agent_id !== v.agentId) return { ok: false, reason: "unknown suggestion" };
  if (s.status !== "accepted" && s.status !== "queued")
    return { ok: false, reason: "not open for votes" };
  if (!verifyWalletSignature(v.wallet, voteMessage(v.agentId, v.suggestionId), v.signature))
    return { ok: false, reason: "bad signature" };
  const bal = await balances.balanceOf(v.wallet);
  if (!(bal >= opts.minBalance)) return { ok: false, reason: "below minimum balance" };
  try {
    db.prepare("INSERT INTO votes (id, suggestion_id, voter, weight, ts) VALUES (?,?,?,?,?)").run(
      ulid(clock.now()),
      v.suggestionId,
      v.wallet,
      bal,
      clock.now(),
    );
  } catch {
    return { ok: false, reason: "already voted" };
  }
  return { ok: true, weight: bal };
}
