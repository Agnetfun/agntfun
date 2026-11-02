import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock, type Clock } from "@devagent/core";
import { castVote, type BalanceProvider } from "@devagent/community";
import { getLogo, saveLogo, agentSeries, MAX_LOGO_BYTES, MAX_LOGO_TEXT } from "@devagent/platform";
import {
  DemoMarket,
  TIMEFRAMES,
  agentCards,
  agentDetail,
  platformStats,
  treasuryOverview,
  version,
  type MarketProvider,
  type Timeframe,
} from "@devagent/dashboard";
import type { Db } from "@devagent/db";
import {
  DEFAULT_DEPLOY,
  deployAgent,
  reportAgent,
  type DeployOptions,
  type Sort,
} from "@devagent/platform";
import type { KillSwitch } from "@devagent/safety";
import type { Treasury } from "@devagent/treasury";
import type { DappRoutes } from "./dapp-routes";
import { createAttachmentRoutes } from "./attachment-routes";

export interface WebDeps {
  db: Db;
  treasury: Treasury;
  publicDir?: string;
  pollMs?: number;
  maxStreams?: number;
  /** Requests allowed per client per ten seconds. */
  rateLimit?: number;
  /** Deploys allowed per client per hour. Tests raise it. */
  deployPerHour?: number;
  /** Source of price, volume and holder numbers. Defaults to labelled demo data. */
  market?: MarketProvider;
  trustProxy?: boolean;
  /** Concurrent live streams one client may hold open. */
  maxStreamsPerClient?: number;
  kill?: KillSwitch;
  clock?: Clock;
  deploy?: DeployOptions;
  /** Vote weight source for one agent's coin, or undefined when the agent has no coin yet. */
  balancesFor?: (agentId: string) => BalanceProvider | undefined;
  /** Launch, suggestion and wallet routes (see dapp-routes.ts). */
  dapp?: DappRoutes;
}

const MAX_BODY = 8192;
/** A deploy carries a brief of up to 10,000 words (60,000 characters) plus small fields. */
const MAX_DEPLOY_BODY = 131_072;
const SORTS: Sort[] = ["proof", "new", "funded"];

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};
const STRICT_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
// With a Privy app, the policy adds exactly what Privy's CSP guide lists for its login window, embedded wallets,
// WalletConnect and Cloudflare Turnstile, plus the public Solana RPCs its wallet screens read. Nothing else loosens.
const PRIVY_CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https://explorer-api.walletconnect.com",
  "connect-src 'self' https://auth.privy.io wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://*.rpc.privy.systems https://explorer-api.walletconnect.com https://api.mainnet-beta.solana.com https://api.devnet.solana.com wss://api.mainnet-beta.solana.com wss://api.devnet.solana.com",
  "child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org",
  "frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Blocked requests are reported back (saved to data/csp-reports.jsonl) so a missing Privy domain shows up at once.
  "report-uri /api/csp-report",
].join("; ");
export const CSP = process.env.PRIVY_APP_ID ? PRIVY_CSP : STRICT_CSP;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface Asset {
  type: string;
  body: Buffer;
}

/** Everything under public/ is read once at start. The URL table is fixed, so request paths never touch the disk. */
function loadAssets(dir: string): { assets: Map<string, Asset>; pages: Map<string, Asset> } {
  const icons = new Map<string, string>();
  for (const f of readdirSync(join(dir, "icons")))
    icons.set(f.replace(/\.svg$/, ""), readFileSync(join(dir, "icons", f), "utf8").trim());
  const partials = new Map<string, string>();
  for (const f of readdirSync(join(dir, "partials")))
    partials.set(f.replace(/\.html$/, ""), readFileSync(join(dir, "partials", f), "utf8"));
  const inline = (html: string) =>
    html
      .replace(/\{\{partial:([a-z-]+)\}\}/g, (_m, n: string) => {
        const p = partials.get(n);
        if (p === undefined) throw new Error(`unknown partial ${n}`);
        return p;
      })
      .replace(/\{\{icon:([a-z-]+)\}\}/g, (_m, n: string) => {
        const svg = icons.get(n);
        if (!svg) throw new Error(`unknown icon ${n}`);
        return svg.replace("<svg ", '<svg aria-hidden="true" focusable="false" class="icon" ');
      });
  const assets = new Map<string, Asset>();
  const pages = new Map<string, Asset>();
  for (const f of readdirSync(dir)) {
    const ext = extname(f);
    if (ext === ".html")
      pages.set(f.replace(/\.html$/, ""), {
        type: TYPES[ext]!,
        body: Buffer.from(inline(readFileSync(join(dir, f), "utf8"))),
      });
    else if (ext === ".css" || ext === ".js" || ext === ".svg" || ext === ".png")
      assets.set(`/${f}`, { type: TYPES[ext]!, body: readFileSync(join(dir, f)) });
  }
  for (const f of readdirSync(join(dir, "fonts"))) {
    const ext = extname(f);
    if (TYPES[ext])
      assets.set(`/fonts/${f}`, { type: TYPES[ext]!, body: readFileSync(join(dir, "fonts", f)) });
  }
  return { assets, pages };
}

export function createWebServer(d: WebDeps): { server: Server; close(): void; streams(): number } {
  const { assets, pages } = loadAssets(d.publicDir ?? join(HERE, "..", "public"));
  const market = d.market ?? new DemoMarket();
  const maxStreams = d.maxStreams ?? 500;
  const limit = d.rateLimit ?? 120;
  const perClient = d.maxStreamsPerClient ?? 20;
  const streams = new Set<ServerResponse>();
  const streamOwner = new Map<ServerResponse, string>();
  const hits = new Map<string, { n: number; reset: number }>();

  const base = (res: ServerResponse, status: number, type: string, cache: string) => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": cache,
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "cross-origin-opener-policy": "same-origin",
    });
  };
  const send = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    a: Asset,
    cache = "no-cache",
  ) => {
    base(res, status, a.type, cache);
    res.end(req.method === "HEAD" ? undefined : a.body);
  };
  const json = (req: IncomingMessage, res: ServerResponse, status: number, v: unknown) =>
    send(
      req,
      res,
      status,
      { type: "application/json; charset=utf-8", body: Buffer.from(JSON.stringify(v)) },
      "no-store",
    );
  const notFound = (req: IncomingMessage, res: ServerResponse) =>
    send(req, res, 404, pages.get("404")!);

  // Behind a proxy the leftmost X-Forwarded-For entry is whatever the client sent, so it cannot key a rate limit.
  // Use Cloudflare's own header when present, else the entry our proxy appended (the rightmost one).
  const forwardedIp = (req: IncomingMessage) => {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim();
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",");
    return xff[xff.length - 1]?.trim() ?? "";
  };
  const clientKey = (req: IncomingMessage) =>
    (d.trustProxy ? forwardedIp(req) : "") || req.socket.remoteAddress || "unknown";

  const clock = d.clock ?? systemClock;
  const buckets = new Map<string, { n: number; reset: number }>();
  const allow = (key: string, route: string, max: number, windowMs: number) => {
    const now = Date.now();
    const k = `${route}:${key}`;
    const b = buckets.get(k);
    if (!b || b.reset < now) {
      buckets.set(k, { n: 1, reset: now + windowMs });
      return true;
    }
    return ++b.n <= max;
  };
  const readJson = (
    req: IncomingMessage,
    max = MAX_BODY,
  ): Promise<
    { ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }
  > =>
    new Promise((resolve) => {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json"))
        return resolve({ ok: false, status: 415, error: "Send JSON." });
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host)
        return resolve({ ok: false, status: 403, error: "Cross site requests are not allowed." });
      const parts: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > max) {
          if (size - c.length <= max)
            resolve({ ok: false, status: 413, error: "That request is too large." });
          // keep draining so the response can be delivered, but never buffer it
        } else parts.push(c);
      });
      req.on("end", () => {
        if (size > max) return;
        try {
          const v = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
          if (v && typeof v === "object" && !Array.isArray(v))
            resolve({ ok: true, body: v as Record<string, unknown> });
          else resolve({ ok: false, status: 400, error: "Send a JSON object." });
        } catch {
          resolve({ ok: false, status: 400, error: "That was not valid JSON." });
        }
      });
      req.on("error", () =>
        resolve({ ok: false, status: 400, error: "The request was interrupted." }),
      );
    });
  const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "");

  /** Raw image body. Size capped while reading; the type is decided from the bytes, not the header. */
  const files = createAttachmentRoutes({ db: d.db, clock });

  /**
   * Browser diagnostics, small JSON appended to data/ for the owner to read: CSP violation reports
   * (csp-reports.jsonl) and, on test networks only, console errors forwarded by the Privy bundle (client-log.jsonl).
   */
  async function cspReport(req: IncomingMessage, res: ServerResponse, path: string) {
    let body = "";
    for await (const c of req) {
      body += (c as Buffer).toString("utf8");
      if (body.length > 8192) break;
    }
    try {
      const j = JSON.parse(body) as Record<string, unknown>;
      let file = "data/csp-reports.jsonl";
      let entry: Record<string, string>;
      if (path === "/api/client-log") {
        if (process.env.SOLANA_CLUSTER === "mainnet-beta" && process.env.CLIENT_DEBUG !== "1") throw new Error("off on mainnet");
        file = "data/client-log.jsonl";
        entry = { level: String(j.level ?? "").slice(0, 10), msg: String(j.msg ?? "").slice(0, 1500) };
      } else {
        const r = (j["csp-report"] ?? {}) as Record<string, unknown>;
        entry = {
          directive: String(r["violated-directive"] ?? r["effective-directive"] ?? "").slice(0, 100),
          blocked: String(r["blocked-uri"] ?? "").slice(0, 300),
          source: String(r["source-file"] ?? "").slice(0, 200),
        };
      }
      mkdirSync("data", { recursive: true });
      appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch {
      /* not a report, or logging is off */
    }
    res.writeHead(204, { "content-security-policy": CSP });
    res.end();
  }

  async function uploadLogo(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host)
      return json(req, res, 403, { error: "Cross site requests are not allowed." });
    const parts: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size <= MAX_LOGO_BYTES + 1) parts.push(c as Buffer);
    }
    if (size > MAX_LOGO_BYTES) return json(req, res, 413, { error: `The image is over ${MAX_LOGO_TEXT}.` });
    const out = saveLogo(d.db, clock, Buffer.concat(parts));
    return out.ok
      ? json(req, res, 201, { id: out.id })
      : json(req, res, 400, { error: out.reason });
  }

  async function post(req: IncomingMessage, res: ServerResponse, path: string, key: string) {
    const rule: Record<string, [number, number]> = {
      "/api/deploy": [d.deployPerHour ?? 5, 3_600_000],
      "/api/vote": [60, 600_000],
      "/api/report": [5, 3_600_000],
      "/api/logo": [10, 3_600_000],
      "/api/csp-report": [60, 3_600_000],
      "/api/client-log": [60, 3_600_000],
      [files.path]: files.rule,
      ...d.dapp?.postPaths,
    };
    const r = rule[path];
    if (!r) {
      res.writeHead(405, { allow: "GET, HEAD", "content-security-policy": CSP });
      return void res.end();
    }
    if (!allow(key, path, r[0], r[1]))
      return json(req, res, 429, { error: "Too many attempts. Try again later." });
    if (path === "/api/logo") return uploadLogo(req, res);
    if (path === files.path) return files.upload(req, res, json);
    if (path === "/api/csp-report" || path === "/api/client-log") return cspReport(req, res, path);
    const b = await readJson(req, path === "/api/deploy" ? MAX_DEPLOY_BODY : MAX_BODY);
    if (!b.ok) return json(req, res, b.status, { error: b.error });
    const body = b.body;
    if (d.dapp && Object.hasOwn(d.dapp.postPaths, path)) {
      const r = await d.dapp.post(path, body, key);
      return json(req, res, r.status, r.body);
    }
    if (path === "/api/deploy") {
      const out = deployAgent(
        d.db,
        clock,
        {
          name: str(body.name, 80),
          model: str(body.model, 20),
          brief: str(body.brief, 61_000),
          wallet: str(body.wallet, 64),
          signature: str(body.signature, 200),
          nonce: str(body.nonce, 64),
          ts: Number(body.ts),
          ticker: str(body.ticker, 12),
          description: str(body.description, 400),
          xHandle: str(body.xHandle, 20),
          logoId: str(body.logoId, 40),
          attachmentIds: Array.isArray(body.attachmentIds)
            ? body.attachmentIds.filter((x): x is string => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 40))
            : undefined,
        },
        d.deploy ?? DEFAULT_DEPLOY,
      );
      if (out.ok) d.dapp?.onDeployed(out.agentId);
      return out.ok ? json(req, res, 201, out) : json(req, res, 400, { error: out.reason });
    }
    if (path === "/api/report") {
      if (!d.kill) return json(req, res, 503, { error: "Reports are not available." });
      const out = reportAgent(d.db, clock, d.kill, {
        agentId: str(body.agentId, 40),
        reason: str(body.reason, 30),
        detail: str(body.detail, 600),
      });
      return out.ok
        ? json(req, res, 201, { ok: true })
        : json(req, res, 400, { error: out.reason });
    }
    // vote
    const agentId = str(body.agentId, 40);
    const balances = d.balancesFor?.(agentId);
    if (!balances)
      return json(req, res, 400, {
        error: "This agent has no token yet, so there is nothing to vote with.",
      });
    const out = await castVote(d.db, clock, balances, {
      agentId,
      suggestionId: str(body.suggestionId, 40),
      wallet: str(body.wallet, 64),
      signature: str(body.signature, 200),
    });
    const VOTE_ERRORS: Record<string, string> = {
      "below minimum balance": "You need at least 1,000 of this agent's coin to vote. Your wallet holds less.",
      "already voted": "You already voted for this idea.",
      "not open for votes": "This idea is no longer open for votes.",
      "bad signature": "The signature does not match this wallet. Sign again.",
      "unknown suggestion": "That idea was not found. Refresh the page.",
    };
    return out.ok
      ? json(req, res, 201, { ok: true, weight: out.weight })
      : json(req, res, 400, { error: VOTE_ERRORS[out.reason] ?? out.reason });
  }

  let last = version(d.db);
  const broadcast = (data: string) => {
    for (const s of streams) s.write(`event: change\ndata: ${data}\n\n`);
  };
  // A throw inside a timer would crash the whole process (a busy database, a closed stream); log and carry on.
  const safely = (name: string, f: () => void) => () => {
    try {
      f();
    } catch (e) {
      console.error(`web: ${name} failed:`, e instanceof Error ? e.message : e);
    }
  };
  const poll = setInterval(
    safely("change poll", () => {
      const v = version(d.db);
      if (v !== last) {
        last = v;
        broadcast(v);
      }
    }),
    d.pollMs ?? 2000,
  );
  const beat = setInterval(
    safely("keepalive", () => {
      for (const s of streams) s.write(": keepalive\n\n");
    }),
    15_000,
  );
  const sweep = setInterval(
    safely("sweep", () => {
      const now = Date.now();
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    }),
    30_000,
  );
  for (const t of [poll, beat, sweep]) t.unref();

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (req.method === "POST") {
        post(req, res, path, clientKey(req)).catch(() => {
          if (!res.headersSent)
            json(req, res, 500, {
              error: "Something went wrong on our side. Try again in a moment.",
            });
        });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD, POST", "content-security-policy": CSP });
        return void res.end();
      }
      // Privy refuses wallet sign in on an IP address (its server rejects the SIWS message for 127.0.0.1, accepts
      // localhost). Pages opened on 127.0.0.1 move to localhost; API calls, files and OAuth callbacks stay put.
      const host = String(req.headers.host ?? "");
      // Only direct visits on this machine: a tunnel or proxy forwards with these headers and is never redirected.
      const direct = !req.headers["x-forwarded-for"] && !req.headers["cf-connecting-ip"];
      if (process.env.PRIVY_APP_ID && direct && /^127\.0\.0\.1(:\d+)?$/.test(host) && !/^\/(api|oauth|files|vendor|meta|logo)\b/.test(path) && !/\.[a-z0-9]+$/i.test(path)) {
        // With a public https address (tunnel or domain) go there; otherwise to localhost on this machine.
        const pub = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
        const to = /^https:\/\//.test(pub) ? `${pub}${req.url ?? "/"}` : `http://${host.replace("127.0.0.1", "localhost")}${req.url ?? "/"}`;
        res.writeHead(302, { location: to, "content-security-policy": CSP });
        return void res.end();
      }
      const now = Date.now();
      const key = clientKey(req);
      const h = hits.get(key);
      if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + 10_000 });
      else if (++h.n > limit && path.startsWith("/api") && path !== "/api/stream") {
        res.writeHead(429, { "retry-after": "10", "content-security-policy": CSP });
        return void res.end("Too many requests. Try again in a few seconds.");
      }

      if (path === "/api/agents")
        return json(req, res, 200, {
          stats: platformStats(d.db),
          agents: agentCards(
            d.db,
            d.treasury,
            SORTS.find((x) => x === url.searchParams.get("sort")) ?? "new",
          ).map((a) => ({
            ...a,
            market: {
              ...market.snapshot(a.id, Date.now()),
              spark: market.candles(a.id, "1h", Date.now(), 24).map((c) => c.c),
            },
          })),
        });
      if (path === "/api/treasury") return json(req, res, 200, treasuryOverview(d.db, d.treasury));
      const mk = /^\/api\/agents\/([0-9A-HJKMNP-TV-Z]{26})\/(market|holders)$/.exec(path);
      if (mk) {
        const live = d.db
          .prepare("SELECT 1 x FROM agents WHERE id=? AND removed_at IS NULL")
          .get(mk[1]!);
        if (!live) return json(req, res, 404, { error: "Agent not found." });
        if (mk[2] === "holders")
          return json(req, res, 200, {
            source: market.snapshot(mk[1]!, Date.now()).source,
            holders: market.holders(mk[1]!),
          });
        const tf = url.searchParams.get("tf") ?? "15m";
        if (!Object.hasOwn(TIMEFRAMES, tf))
          return json(req, res, 400, { error: "Timeframe must be 1m, 5m, 15m, 1h, 4h or 1D." });
        return json(req, res, 200, {
          snapshot: market.snapshot(mk[1]!, Date.now()),
          candles: market.candles(mk[1]!, tf as Timeframe, Date.now()),
        });
      }
      if (files.get(req, res, path, json)) return;
      const lg = /^\/logo\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(path);
      if (lg) {
        const l = getLogo(d.db, lg[1]!);
        if (!l) return notFound(req, res);
        return send(req, res, 200, { type: l.mime, body: l.bytes }, "public, max-age=3600");
      }
      const sm = /^\/api\/agents\/([0-9A-HJKMNP-TV-Z]{26})\/series$/.exec(path);
      if (sm) return json(req, res, 200, agentSeries(d.db, sm[1]!, Date.now()));
      const m = /^\/api\/agents\/([^/]+)$/.exec(path);
      if (m) {
        const removed = ULID.test(m[1]!)
          ? (d.db.prepare("SELECT removed_at r FROM agents WHERE id=?").get(m[1]!) as
              { r: number | null } | undefined)
          : undefined;
        if (removed?.r) return json(req, res, 410, { error: "This agent was removed." });
        const detail = ULID.test(m[1]!) ? agentDetail(d.db, d.treasury, m[1]!) : undefined;
        return detail
          ? json(req, res, 200, detail)
          : json(req, res, 404, { error: "Agent not found." });
      }
      if (path === "/api/stream") {
        if (streams.size >= maxStreams) {
          res.writeHead(503, { "retry-after": "30", "content-security-policy": CSP });
          return void res.end("Too many live viewers right now.");
        }
        let mine = 0;
        for (const o of streamOwner.values()) if (o === key) mine++;
        if (mine >= perClient) {
          res.writeHead(429, { "retry-after": "30", "content-security-policy": CSP });
          return void res.end("Too many open live views from this connection.");
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "content-security-policy": CSP,
          "x-content-type-options": "nosniff",
        });
        res.write(`retry: 3000\nevent: change\ndata: ${last}\n\n`);
        streams.add(res);
        streamOwner.set(res, key);
        req.on("close", () => {
          streams.delete(res);
          streamOwner.delete(res);
        });
        return;
      }
      if (path === "/") return send(req, res, 200, pages.get("index")!);
      if (/^\/agent\/[^/]+$/.test(path)) return send(req, res, 200, pages.get("agent")!);
      if (["/privacy", "/terms", "/launch", "/how", "/docs", "/treasury", "/live", "/burns"].includes(path))
        return send(req, res, 200, pages.get(path.slice(1))!);
      const dyn = d.dapp?.get(path, url.searchParams);
      if (dyn) {
        dyn
          .then((r) => {
            if ("redirect" in r) {
              // Only ever a same-site path built by connect-routes.
              res.writeHead(302, { location: r.redirect, "cache-control": "no-store", "content-security-policy": CSP });
              return void res.end();
            }
            return "type" in r
              ? send(req, res, r.status, { type: r.type, body: r.body }, "public, max-age=3600")
              : json(req, res, r.status, r.body);
          })
          .catch(() => {
            if (!res.headersSent) json(req, res, 500, { error: "Something went wrong on our side." });
          });
        return;
      }
      const asset = assets.get(path);
      if (asset)
        return send(
          req,
          res,
          200,
          asset,
          path.startsWith("/fonts/") ? "public, max-age=31536000, immutable" : "no-cache",
        );
      notFound(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-security-policy": CSP });
      res.end("Something went wrong on our side. Try again in a moment.");
    }
  });
  return {
    server,
    streams: () => streams.size,
    close() {
      clearInterval(poll);
      clearInterval(beat);
      clearInterval(sweep);
      buckets.clear();
      for (const s of streams) s.end();
      streams.clear();
      streamOwner.clear();
      server.close();
      server.closeAllConnections();
    },
  };
}
