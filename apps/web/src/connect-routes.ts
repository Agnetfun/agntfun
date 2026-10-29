import type { Clock } from "@devagent/core";
import type { Db } from "@devagent/db";
import { connectionHealth, type CredentialKind, type OAuthApp } from "@devagent/gateway";
import { disconnect, finishConnect, startConnect, type ConnectRequest } from "@devagent/platform";

/** Web side of "Connect X" / "Connect GitHub". The callback seals tokens with the public key only. */
export interface ConnectDeps {
  db: Db;
  clock: Clock;
  apps: Partial<Record<CredentialKind, OAuthApp>>;
  sealPublicKey?: string;
  publicUrl?: string;
}
export type Redirect = { status: 302; redirect: string };

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

export function createConnectRoutes(d: ConnectDeps) {
  const request = (b: Record<string, unknown>): ConnectRequest => ({
    agentId: str(b.agentId, 40),
    kind: (b.kind === "github" ? "github" : "x") as CredentialKind,
    wallet: str(b.wallet, 64),
    signature: str(b.signature, 200),
    nonce: str(b.nonce, 64),
    ts: Number(b.ts),
  });
  return {
    postPaths: {
      "/api/connect/start": [20, 3_600_000],
      "/api/connect/remove": [20, 3_600_000],
    } as Record<string, [number, number]>,

    post(path: string, body: Record<string, unknown>) {
      if (!d.sealPublicKey) return { status: 503, body: { error: "Account connections are not set up on this site." } };
      if (path === "/api/connect/start") {
        const out = startConnect(d.db, d.clock, d.apps, request(body));
        return out.ok ? { status: 200, body: { url: out.url } } : { status: 400, body: { error: out.reason } };
      }
      const out = disconnect(d.db, d.clock, request(body));
      return out.ok ? { status: 200, body: { ok: true } } : { status: 400, body: { error: out.reason } };
    },

    status(agentId: string) {
      const c = connectionHealth(d.db, agentId);
      // `setup` tells the site owner what is missing; it holds env key names and the public callback URL only.
      const setup = (k: CredentialKind) =>
        d.apps[k]
          ? undefined
          : {
              keys: k === "x" ? ["X_CLIENT_ID", "X_CLIENT_SECRET"] : ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
              callback: `${d.publicUrl ?? "http://127.0.0.1:3000"}/oauth/callback/${k}`,
            };
      return {
        github: { ...c.github, available: !!d.apps.github, setup: setup("github") },
        x: { ...c.x, available: !!d.apps.x, setup: setup("x") },
      };
    },

    /** OAuth provider redirect back: /oauth/callback/x?code&state (or ?error=access_denied). */
    async callback(kind: CredentialKind, q: URLSearchParams): Promise<Redirect> {
      const back = (agentId: string | undefined, key: string, value: string): Redirect => ({
        status: 302,
        redirect: `${agentId ? `/agent/${encodeURIComponent(agentId)}` : "/"}?${key}=${encodeURIComponent(value)}`,
      });
      const state = str(q.get("state"), 100);
      if (q.get("error") || !q.get("code")) {
        const row = d.db.prepare("SELECT agent_id FROM oauth_states WHERE state=?").get(state) as
          | { agent_id: string }
          | undefined;
        d.db.prepare("DELETE FROM oauth_states WHERE state=?").run(state);
        return back(row?.agent_id, "connect_error", "The login was cancelled.");
      }
      if (!d.sealPublicKey) return back(undefined, "connect_error", "Account connections are not set up.");
      try {
        const out = await finishConnect(d.db, d.clock, d.apps, d.sealPublicKey, kind, str(q.get("code"), 500), state);
        return out.ok
          ? back(out.agentId, "connected", `${kind}:${out.account}`)
          : back(out.agentId, "connect_error", out.reason);
      } catch {
        return back(undefined, "connect_error", "The login could not be finished. Try again.");
      }
    },
  };
}
export type ConnectRoutes = ReturnType<typeof createConnectRoutes>;
