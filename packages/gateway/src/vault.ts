import { openSealed, seal, type Clock } from "@devagent/core";
import type { Db } from "@devagent/db";
import { parseTokens, refreshTokens, type OAuthApp, type Tokens } from "./oauth";

/** Per agent tokens (GitHub, X). Stored sealed; anyone may store, only the gateway (private seal key) reads. */
export type CredentialKind = "github" | "x";

export function storeCredential(
  db: Db,
  clock: Clock,
  sealPublicKey: string,
  agentId: string,
  kind: CredentialKind,
  secret: string,
  account?: string,
): void {
  db.prepare(
    `INSERT INTO agent_credentials (agent_id, kind, sealed, updated_at, account) VALUES (?,?,?,?,?)
     ON CONFLICT(agent_id, kind) DO UPDATE SET sealed=excluded.sealed, updated_at=excluded.updated_at,
       account=COALESCE(excluded.account, agent_credentials.account), error_at=NULL, last_error=NULL`,
  ).run(agentId, kind, seal(sealPublicKey, Buffer.from(secret, "utf8")), clock.now(), account ?? null);
}

export function removeCredential(db: Db, agentId: string, kind: CredentialKind): void {
  db.prepare("DELETE FROM agent_credentials WHERE agent_id=? AND kind=?").run(agentId, kind);
}

export function hasCredential(db: Db, agentId: string, kind: CredentialKind): boolean {
  return !!db.prepare("SELECT 1 x FROM agent_credentials WHERE agent_id=? AND kind=?").get(agentId, kind);
}

/** Failures that mean the token no longer works (revoked, expired, wrong scope): the creator must reconnect. */
export const AUTH_FAILURE =
  /\b(401|403)\b|authentication failed|bad credentials|invalid_grant|invalid_token|token request failed|no (x|github) token/i;

export function markCredentialOk(db: Db, clock: Clock, agentId: string, kind: CredentialKind): void {
  db.prepare(
    "UPDATE agent_credentials SET last_ok_at=?, error_at=NULL, last_error=NULL WHERE agent_id=? AND kind=?",
  ).run(clock.now(), agentId, kind);
}

export function markCredentialError(db: Db, clock: Clock, agentId: string, kind: CredentialKind, message: string): void {
  db.prepare("UPDATE agent_credentials SET error_at=?, last_error=? WHERE agent_id=? AND kind=?").run(
    clock.now(),
    message.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]").slice(0, 200),
    agentId,
    kind,
  );
}

export interface ConnectionHealth {
  account: string | null;
  needsReconnect: boolean;
  lastOkAt: number | null;
}

/** Public: account names and whether each connection still works. Never tokens, never raw errors. */
export function connectionHealth(db: Db, agentId: string): Record<CredentialKind, ConnectionHealth> {
  const out: Record<CredentialKind, ConnectionHealth> = {
    github: { account: null, needsReconnect: false, lastOkAt: null },
    x: { account: null, needsReconnect: false, lastOkAt: null },
  };
  const rows = db
    .prepare("SELECT kind, account, last_ok_at, error_at FROM agent_credentials WHERE agent_id=?")
    .all(agentId) as { kind: CredentialKind; account: string | null; last_ok_at: number | null; error_at: number | null }[];
  for (const r of rows)
    out[r.kind] = {
      account: r.account ?? "connected",
      needsReconnect: r.error_at !== null && (r.last_ok_at === null || r.error_at > r.last_ok_at),
      lastOkAt: r.last_ok_at,
    };
  return out;
}

/** Public: which accounts an agent has connected (names only, never tokens). */
export function connections(db: Db, agentId: string): Record<CredentialKind, string | null> {
  const rows = db.prepare("SELECT kind, account FROM agent_credentials WHERE agent_id=?").all(agentId) as {
    kind: CredentialKind;
    account: string | null;
  }[];
  const out: Record<CredentialKind, string | null> = { github: null, x: null };
  for (const r of rows) out[r.kind] = r.account ?? "connected";
  return out;
}

export class SealedVault {
  constructor(
    private db: Db,
    private sealPrivateKey: string,
  ) {}
  get(agentId: string, kind: CredentialKind): string | undefined {
    const r = this.db
      .prepare("SELECT sealed FROM agent_credentials WHERE agent_id=? AND kind=?")
      .get(agentId, kind) as { sealed: string } | undefined;
    return r ? openSealed(this.sealPrivateKey, r.sealed).toString("utf8") : undefined;
  }
}

/**
 * Hands out a valid access token, refreshing it first when it expires within five minutes (X tokens last two hours).
 * The new token pair is sealed again right away; refresh tokens may rotate, so the latest one is always kept.
 * One refresh per agent at a time.
 */
export class TokenSource {
  private inflight = new Map<string, Promise<string | undefined>>();
  constructor(
    private db: Db,
    private clock: Clock,
    private vault: SealedVault,
    private sealPublicKey: string,
    private apps: Partial<Record<CredentialKind, OAuthApp>>,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async get(agentId: string, kind: CredentialKind): Promise<string | undefined> {
    const key = `${agentId}:${kind}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.load(agentId, kind).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async load(agentId: string, kind: CredentialKind): Promise<string | undefined> {
    const stored = this.vault.get(agentId, kind);
    if (!stored) return undefined;
    const t: Tokens = parseTokens(stored);
    const app = this.apps[kind];
    if (!t.expiresAt || t.expiresAt - 5 * 60_000 > this.clock.now() || !t.refresh || !app) return t.access;
    const fresh = await refreshTokens(kind, app, t.refresh, this.fetchFn);
    const next: Tokens = { access: fresh.access, refresh: fresh.refresh ?? t.refresh, expiresAt: fresh.expiresAt };
    storeCredential(this.db, this.clock, this.sealPublicKey, agentId, kind, JSON.stringify(next));
    return next.access;
  }
}
