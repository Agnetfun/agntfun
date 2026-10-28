import { openSealed, seal, type Clock } from "@devagent/core";
import type { Db } from "@devagent/db";
import { Keypair } from "@solana/web3.js";

/**
 * One Solana wallet per agent. The secret key is sealed with the platform public key the moment it is made,
 * so the web server that creates it can never read it back. Only the gateway side (orchestrator, operator CLI)
 * holds the private seal key. The agent's model never sees the key: it can only ask the gateway for actions.
 */
export function createAgentWallet(db: Db, clock: Clock, sealPublicKey: string, agentId: string): string {
  const existing = agentWalletAddress(db, agentId);
  if (existing) return existing;
  const kp = Keypair.generate();
  const address = kp.publicKey.toBase58();
  db.prepare(
    "INSERT INTO agent_wallets (agent_id, address, sealed_secret, created_at) VALUES (?,?,?,?)",
  ).run(agentId, address, seal(sealPublicKey, kp.secretKey), clock.now());
  kp.secretKey.fill(0);
  return address;
}

export function agentWalletAddress(db: Db, agentId: string): string | undefined {
  const r = db.prepare("SELECT address FROM agent_wallets WHERE agent_id=?").get(agentId) as
    { address: string } | undefined;
  return r?.address;
}

export function listAgentWallets(db: Db): { agentId: string; address: string }[] {
  return (
    db.prepare("SELECT agent_id, address FROM agent_wallets ORDER BY created_at").all() as {
      agent_id: string;
      address: string;
    }[]
  ).map((r) => ({ agentId: r.agent_id, address: r.address }));
}

/** Gateway side only. Opens the sealed key for one signing operation; callers must not keep it. */
export function openAgentSigner(db: Db, sealPrivateKey: string, agentId: string): Keypair {
  const r = db.prepare("SELECT address, sealed_secret FROM agent_wallets WHERE agent_id=?").get(agentId) as
    { address: string; sealed_secret: string } | undefined;
  if (!r) throw new Error("agent has no wallet");
  const kp = Keypair.fromSecretKey(openSealed(sealPrivateKey, r.sealed_secret));
  if (kp.publicKey.toBase58() !== r.address) throw new Error("wallet record does not match its key");
  return kp;
}

/** A platform owned wallet (for example "buyback"), created once and sealed the same way as agent wallets. */
export function ensurePlatformWallet(db: Db, clock: Clock, sealPublicKey: string, role: string): string {
  const r = db.prepare("SELECT address FROM platform_wallets WHERE role=?").get(role) as { address: string } | undefined;
  if (r) return r.address;
  const kp = Keypair.generate();
  const address = kp.publicKey.toBase58();
  db.prepare("INSERT INTO platform_wallets (role, address, sealed_secret, created_at) VALUES (?,?,?,?)").run(
    role,
    address,
    seal(sealPublicKey, kp.secretKey),
    clock.now(),
  );
  kp.secretKey.fill(0);
  return address;
}

export function platformWalletAddress(db: Db, role: string): string | undefined {
  return (db.prepare("SELECT address FROM platform_wallets WHERE role=?").get(role) as { address: string } | undefined)
    ?.address;
}

/** Gateway side only, for one signing operation. */
export function openPlatformSigner(db: Db, sealPrivateKey: string, role: string): Keypair {
  const r = db.prepare("SELECT address, sealed_secret FROM platform_wallets WHERE role=?").get(role) as
    | { address: string; sealed_secret: string }
    | undefined;
  if (!r) throw new Error(`no platform wallet ${role}`);
  const kp = Keypair.fromSecretKey(openSealed(sealPrivateKey, r.sealed_secret));
  if (kp.publicKey.toBase58() !== r.address) throw new Error("platform wallet record does not match its key");
  return kp;
}

/** Wallets for agents created before wallets existed (or while the seal key was missing). */
export function backfillAgentWallets(db: Db, clock: Clock, sealPublicKey: string): number {
  const ids = db
    .prepare(
      "SELECT a.id FROM agents a LEFT JOIN agent_wallets w ON w.agent_id=a.id WHERE w.agent_id IS NULL AND a.removed_at IS NULL",
    )
    .all() as { id: string }[];
  for (const { id } of ids) createAgentWallet(db, clock, sealPublicKey, id);
  return ids.length;
}
