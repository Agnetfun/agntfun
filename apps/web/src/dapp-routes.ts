import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Clock } from "@devagent/core";
import { submitSuggestion } from "@devagent/community";
import type { Db } from "@devagent/db";
import {
  LaunchFlowError,
  agentWalletAddress,
  createAgentWallet,
  feeStatus,
  prepareLaunch,
  submitLaunch,
  type LaunchRpc,
  type WebLaunchConfig,
  devBuyQuote,
} from "@devagent/launch";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { ConnectRoutes, Redirect } from "./connect-routes";
import type { TradeRoutes } from "./trade-routes";

export interface DappDeps {
  db: Db;
  clock: Clock;
  rpc: LaunchRpc & Pick<Connection, "getBalance">;
  launch: WebLaunchConfig;
  /** Public half only. Lets the web server make sealed agent wallets it can never open. */
  sealPublicKey?: string;
  vcsMode: string;
  socialMode: string;
  /** Connect X / GitHub for an agent's own accounts. */
  connect?: ConnectRoutes;
  /** Buy and sell the agent coin from the user wallet. */
  trade?: TradeRoutes;
  /** The platform's own token (buyback and burn target), once launched. */
  platformToken?: { mint: string; symbol: string };
}
export interface Reply {
  status: number;
  body: unknown;
}
export interface RawReply {
  status: number;
  type: string;
  body: Buffer;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "");
const ok = (body: unknown, status = 200): Reply => ({ status, body });
const bad = (error: string, status = 400): Reply => ({ status, body: { error } });

export function createDappRoutes(d: DappDeps) {
  // The browser build of web3.js deserializes and signs transactions with the user's wallet (served locally, CSP self).
  const req = createRequire(import.meta.url);
  const web3Browser = readFileSync(join(dirname(req.resolve("@solana/web3.js")), "index.iife.min.js"));
  // TradingView Lightweight Charts (pinned 4.2.3), served from this site so the CSP stays script-src 'self'.
  const chartsBase = dirname(req.resolve("lightweight-charts"));
  const chartsFile = "lightweight-charts.standalone.production.js";
  const chartsBrowser = readFileSync(
    existsSync(join(chartsBase, "dist", chartsFile)) ? join(chartsBase, "dist", chartsFile) : join(chartsBase, chartsFile),
  );
  const balances = new Map<string, { at: number; lamports: number }>();

  const live = (agentId: string) =>
    ULID.test(agentId) &&
    !!d.db.prepare("SELECT 1 x FROM agents WHERE id=? AND removed_at IS NULL").get(agentId);

  return {
    /** Called after a successful deploy: every agent gets its own wallet right away. */
    onDeployed(agentId: string) {
      if (d.sealPublicKey) createAgentWallet(d.db, d.clock, d.sealPublicKey, agentId);
    },

    postPaths: {
      "/api/launch/prepare": [20, 3_600_000],
      "/api/launch/submit": [20, 3_600_000],
      "/api/suggest": [10, 3_600_000],
      ...d.connect?.postPaths,
      ...d.trade?.postPaths,
    } as Record<string, [number, number]>,

    async post(path: string, body: Record<string, unknown>, client: string): Promise<Reply> {
      if (d.connect && Object.hasOwn(d.connect.postPaths, path)) return d.connect.post(path, body);
      if (d.trade && Object.hasOwn(d.trade.postPaths, path)) return d.trade.post(path, body);
      const agentId = str(body.agentId, 40);
      if (!live(agentId)) return bad("Agent not found.", 404);
      try {
        if (path === "/api/suggest") {
          const text = str(body.text, 600).trim();
          if (text.length < 8 || text.length > 500) return bad("Write 8 to 500 characters.");
          const author = str(body.wallet, 64) || `web:${client}`;
          await submitSuggestion(d.db, d.clock, agentId, author, text);
          return ok({ ok: true, note: "Thanks. It is checked by the filter, then shows up in the queue." }, 201);
        }
        if (path === "/api/launch/prepare")
          return ok(await prepareLaunch(d.db, d.clock, d.rpc, d.launch, agentId, str(body.wallet, 64), Number(body.devBuySol) || 0));
        const step = body.step === "split" ? "split" : "create";
        return ok(await submitLaunch(d.db, d.clock, d.rpc, d.launch, agentId, step, str(body.tx, 4000)));
      } catch (e) {
        if (e instanceof LaunchFlowError) return bad(e.message);
        const m = e instanceof Error ? e.message : "";
        if (/blockhash|expired/i.test(m)) return bad("The transaction expired. Start the launch again.");
        if (/insufficient|lamports|0x1\b/i.test(m)) return bad("The wallet does not have enough SOL for the fees.");
        if (/refusing to build/i.test(m)) return bad("Launching is not enabled on this network.");
        return bad("The network call failed. Try again in a moment.", 502);
      }
    },

    /** Async GET routes. Returns undefined when the path is not ours. */
    get(path: string, query: URLSearchParams = new URLSearchParams()): Promise<Reply | RawReply | Redirect> | undefined {
      const cb = /^\/oauth\/callback\/(x|github)$/.exec(path);
      if (cb && d.connect) return d.connect.callback(cb[1] as "x" | "github", query);
      const cs = /^\/api\/agents\/([0-9A-HJKMNP-TV-Z]{26})\/connections$/.exec(path);
      if (cs) return Promise.resolve(live(cs[1]!) ? ok(d.connect ? d.connect.status(cs[1]!) : {}) : bad("Agent not found.", 404));
      const ps = /^\/api\/agents\/([0-9A-HJKMNP-TV-Z]{26})\/position$/.exec(path);
      if (ps && d.trade) return live(ps[1]!) ? d.trade.position(ps[1]!, query.get("wallet") ?? "") : Promise.resolve(bad("Agent not found.", 404));
      const lv = /^\/api\/agents\/([0-9A-HJKMNP-TV-Z]{26})\/live$/.exec(path);
      if (lv) return Promise.resolve(this.live(lv[1]!, query.get("session") ?? "", Number(query.get("after")) || 0));
      if (path === "/vendor/web3.js")
        return Promise.resolve({ status: 200, type: "text/javascript; charset=utf-8", body: web3Browser });
      if (path === "/vendor/charts.js")
        return Promise.resolve({ status: 200, type: "text/javascript; charset=utf-8", body: chartsBrowser });
      // What a dev buy of ?sol= gets on a new coin, and the amount at which it fills the whole curve.
      if (path === "/api/launch/quote") {
        const sol = Number(query.get("sol"));
        if (!(sol > 0 && sol <= 50)) return Promise.resolve(bad("Enter between 0 and 50 SOL."));
        return devBuyQuote(d.rpc as unknown as Connection, sol)
          .then((q) => ok(q))
          .catch(() => bad("Could not read pump.fun's settings. Try again in a moment.", 502));
      }
      if (path === "/api/config")
        return Promise.resolve(
          ok({
            cluster: d.launch.cluster,
            vcs: d.vcsMode,
            social: d.socialMode,
            platformToken: d.platformToken ?? null,
            // Public app id (not a secret): turns on "Email, Google or any wallet" through Privy.
            privyAppId: process.env.PRIVY_APP_ID || null,
          }),
        );
      if (path === "/api/burns") return Promise.resolve(this.burns());
      const meta = /^\/meta\/([0-9A-HJKMNP-TV-Z]{26})\.json$/.exec(path);
      if (meta) return Promise.resolve(this.metadata(meta[1]!));
      const w = /^\/api\/agents\/([0-9A-HJKMNP-TV-Z]{26})\/wallet$/.exec(path);
      if (w) return this.wallet(w[1]!);
      return undefined;
    },

    /** Buyback activity: infra top ups, buys and burns of the platform token (public, from the event log). */
    burns(): Reply {
      const rows = d.db
        .prepare("SELECT ts, type, payload_json FROM events WHERE type LIKE 'buyback.%' ORDER BY ts DESC LIMIT 100")
        .all() as { ts: number; type: string; payload_json: string }[];
      const items = rows.map((r) => {
        const p = JSON.parse(r.payload_json) as { lamports?: number; tokens?: string; burn?: string; signature?: string; reason?: string };
        return {
          ts: r.ts,
          kind: r.type.replace("buyback.", ""),
          sol: (p.lamports ?? 0) / 1e9,
          tokens: p.tokens ?? null,
          signature: p.burn ?? p.signature ?? null,
          note: p.reason ?? null,
        };
      });
      const sum = (k: string) => items.filter((i) => i.kind === k).reduce((s, i) => s + i.sol, 0);
      const burned = items.filter((i) => i.kind === "burned").reduce((s, i) => s + BigInt(i.tokens ?? "0"), 0n);
      return ok({
        cluster: d.launch.cluster,
        token: d.platformToken ?? null,
        totals: { buybackSol: sum("burned"), infraSol: sum("to_infra"), tokensBurned: burned.toString() },
        items,
      });
    },

    /** Live agent screen: frames of one session after `after`. Without a session id, the newest one. */
    live(agentId: string, sessionId: string, after: number): Reply {
      if (!live(agentId)) return bad("Agent not found.", 404);
      const agent = d.db.prepare("SELECT state FROM agents WHERE id=?").get(agentId) as { state: string };
      const sessions = d.db
        .prepare(
          "SELECT s.id, s.started_at, s.ended_at, t.summary task FROM sessions s LEFT JOIN tasks t ON t.id=s.task_ref WHERE s.agent_id=? AND EXISTS (SELECT 1 FROM live_frames f WHERE f.session_id=s.id) ORDER BY s.started_at DESC LIMIT 5",
        )
        .all(agentId) as { id: string; started_at: number; ended_at: number | null; task: string | null }[];
      const pick = sessions.find((s) => s.id === sessionId) ?? sessions[0];
      if (!pick) return ok({ state: agent.state, live: false, session: null, sessions: [], frames: [] });
      const frames = (
        d.db
          .prepare("SELECT seq, ts, kind, payload_json FROM live_frames WHERE session_id=? AND seq > ? ORDER BY seq LIMIT 200")
          .all(pick.id, Math.max(0, Math.floor(after))) as { seq: number; ts: number; kind: string; payload_json: string }[]
      ).map((f) => ({ seq: f.seq, ts: f.ts, kind: f.kind, ...(JSON.parse(f.payload_json) as object) }));
      const isLive = pick === sessions[0] && pick.ended_at === null && ["running", "waking", "publishing"].includes(agent.state);
      return ok({
        state: agent.state,
        live: isLive,
        session: { id: pick.id, startedAt: pick.started_at, endedAt: pick.ended_at, task: pick.task },
        sessions: sessions.map((s) => ({ id: s.id, startedAt: s.started_at, task: s.task })),
        frames,
      });
    },

    metadata(agentId: string): Reply {
      const a = d.db
        .prepare("SELECT name, ticker, description, logo_id FROM agents WHERE id=? AND removed_at IS NULL")
        .get(agentId) as { name: string; ticker: string | null; description: string; logo_id: string | null } | undefined;
      if (!a) return bad("Agent not found.", 404);
      const base = d.launch.publicUrl.replace(/\/+$/, "");
      return ok({
        name: a.name,
        symbol: a.ticker ?? "AGENT",
        description: a.description || `${a.name}, an autonomous developer agent on DevAgent.`,
        image: a.logo_id ? `${base}/logo/${a.logo_id}` : `${base}/favicon.svg`,
        showName: true,
        website: `${base}/agent/${agentId}`,
      });
    },

    async wallet(agentId: string): Promise<Reply> {
      if (!live(agentId)) return bad("Agent not found.", 404);
      const address = agentWalletAddress(d.db, agentId);
      if (!address) return ok({ address: null, cluster: d.launch.cluster });
      let b = balances.get(address);
      if (!b || Date.now() - b.at > 15_000) {
        try {
          b = { at: Date.now(), lamports: await d.rpc.getBalance(new PublicKey(address), "confirmed") };
          balances.set(address, b);
        } catch {
          return ok({ address, lamports: null, cluster: d.launch.cluster });
        }
      }
      const f = feeStatus(d.db, agentId);
      const earned = (
        d.db
          .prepare("SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE agent_id=? AND ref_type='creator_fee' AND direction='debit'")
          .get(agentId) as { s: number }
      ).s;
      return ok({
        address,
        lamports: b.lamports,
        sol: b.lamports / 1e9,
        cluster: d.launch.cluster,
        fees: {
          waitingSol: f ? f.waitingLamports / 1e9 : null,
          lastPayoutAt: f?.lastPayoutAt ?? null,
          receivedSol: earned / 1e9,
        },
      });
    },
  };
}
export type DappRoutes = ReturnType<typeof createDappRoutes>;
