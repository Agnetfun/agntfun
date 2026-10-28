import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebServer, CSP } from "../src/server";
import { seed } from "./seed";

let web: ReturnType<typeof createWebServer>;
let base: string;
let ids: { good: string; evil: string };
async function start(
  extra: Parameters<typeof createWebServer>[0] extends infer T ? Partial<T> : never = {},
) {
  const s = await seed();
  ids = { good: s.good, evil: s.evil };
  web = createWebServer({ db: s.db, treasury: s.treasury, pollMs: 50, ...extra });
  await new Promise<void>((r) => web.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  return s;
}
beforeEach(() => start());
afterEach(() => web.close());

describe("pages and headers", () => {
  it("serves every page with a strict CSP and no inline scripts or styles", async () => {
    for (const p of [
      "/",
      `/agent/${ids.good}`,
      "/launch",
      "/how",
      "/docs",
      "/treasury",
      "/privacy",
      "/terms",
    ]) {
      const r = await fetch(base + p);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-security-policy")).toBe(CSP);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      const html = await r.text();
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/);
    }
  });
  it("branded 404 for unknown paths, 405 for writes, traversal goes nowhere", async () => {
    const nf = await fetch(base + "/nope");
    expect(nf.status).toBe(404);
    expect(await nf.text()).toContain("This page does not exist");
    expect((await fetch(base + "/", { method: "POST" })).status).toBe(405);
    for (const p of [
      "/../package.json",
      "/%2e%2e/package.json",
      "/fonts/../../package.json",
      "/..%2f..%2fetc/passwd",
      "/app.css/../../.env",
    ]) {
      const r = await fetch(base + p);
      expect([200, 404]).toContain(r.status);
      expect(await r.text()).not.toMatch(/"name": "@devagent|DB_PATH|root:/);
    }
  });
  it("serves the stylesheet, fonts and favicon", async () => {
    expect((await fetch(base + "/ui.css")).headers.get("content-type")).toContain("text/css");
    expect((await fetch(base + "/fonts/geist.woff2")).headers.get("content-type")).toBe(
      "font/woff2",
    );
    expect((await fetch(base + "/favicon.svg")).status).toBe(200);
  });
  it("visible copy has no hyphens inside words and no banned filler", async () => {
    const banned =
      /revolutioni[sz]e|supercharge|cutting[- ]edge|effortless|transform your workflow|next level|harness the power|world[- ]class/i;
    for (const p of [
      "/",
      `/agent/${ids.good}`,
      "/launch",
      "/how",
      "/treasury",
      "/privacy",
      "/terms",
      "/nope",
    ]) {
      const html = await (await fetch(base + p)).text();
      const text = html
        .replace(/<template[\s\S]*?<\/template>/g, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<svg[\s\S]*?<\/svg>/g, "")
        .replace(/<[^>]*>/g, " ");
      const after = text.replace(/^[\s\S]*<\/head>/, "");
      expect(after, p).not.toMatch(/\w-\w/);
      expect(after, p).not.toMatch(banned);
    }
  });
});

describe("api", () => {
  it("lists agents and details, hostile strings returned as inert JSON", async () => {
    const list = (await (await fetch(base + "/api/agents")).json()) as {
      stats: { agents: number };
      agents: { name: string }[];
    };
    expect(list.stats.agents).toBe(2);
    expect(list.agents.map((a) => a.name)).toContain(`<img src=x onerror="window.__xss=1">`);
    const d = (await (await fetch(`${base}/api/agents/${ids.good}`)).json()) as {
      sessions: number;
      merged: number;
      queue: { summary: string }[];
      feed: unknown[];
      split: unknown[];
    };
    expect(d.sessions).toBe(3);
    expect(d.merged).toBe(3);
    expect(d.queue[0]!.summary).toBe("Add a CSV export for the ledger");
    expect(d.split).toHaveLength(4);
    expect(d.feed.length).toBeGreaterThan(5);
    expect(JSON.stringify(d)).not.toMatch(/raw_text|author|operator/);
  });
  it("404 for bad and unknown ids, JSON content type, no caching", async () => {
    const r = await fetch(base + "/api/agents/not-an-id");
    expect(r.status).toBe(404);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toContain("application/json");
    expect((await fetch(base + "/api/agents/01ARZ3NDEKTSV4RRFFQ69G5FAV")).status).toBe(404);
  });
  it("rate limits api callers, not pages", async () => {
    web.close();
    await start({ rateLimit: 5 });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await fetch(base + "/api/agents")).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
    expect((await fetch(base + "/")).status).toBe(200);
  });
});

describe("live stream", () => {
  const open = (path: string) =>
    new Promise<{ chunks: string[]; close(): void }>((resolve) => {
      const chunks: string[] = [];
      const req = request(base + path, (res) => {
        res.setEncoding("utf8");
        res.on("data", (c: string) => chunks.push(c));
        resolve({ chunks, close: () => req.destroy() });
      });
      req.end();
    });
  const until = async (f: () => boolean, ms = 3000) => {
    const t = Date.now();
    while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 20));
    return f();
  };

  it("pushes a change event within a few seconds of new data and cleans up on disconnect", async () => {
    web.close();
    const s = await start();
    const live = await open("/api/stream");
    expect(await until(() => live.chunks.join("").includes("event: change"))).toBe(true);
    const count = () => (live.chunks.join("").match(/event: change/g) ?? []).length;
    expect(count()).toBe(1);
    s.treasury.topUp(s.good, 100, "later");
    expect(await until(() => count() === 2)).toBe(true);
    live.close();
    expect(await until(() => web.streams() === 0)).toBe(true);
  });

  it("refuses new streams past the cap", async () => {
    web.close();
    await start({ maxStreams: 2 });
    const a = await open("/api/stream");
    const b = await open("/api/stream");
    expect(await until(() => web.streams() === 2)).toBe(true);
    const r = await fetch(base + "/api/stream");
    expect(r.status).toBe(503);
    a.close();
    b.close();
  });
});

describe("market and treasury api", () => {
  it("serves labelled demo candles, holders and a treasury overview", async () => {
    const m = (await (await fetch(`${base}/api/agents/${ids.good}/market?tf=1h`)).json()) as {
      snapshot: { source: string; mcapUsd: number };
      candles: { o: number; h: number; l: number; c: number }[];
    };
    expect(m.snapshot.source).toBe("demo");
    expect(m.candles).toHaveLength(96);
    for (const c of m.candles) {
      expect(c.h).toBeGreaterThanOrEqual(Math.max(c.o, c.c));
      expect(c.l).toBeLessThanOrEqual(Math.min(c.o, c.c));
    }
    const again = (await (
      await fetch(`${base}/api/agents/${ids.good}/market?tf=1h`)
    ).json()) as typeof m;
    expect(again.candles[0]).toEqual(m.candles[0]);
    expect((await fetch(`${base}/api/agents/${ids.good}/market?tf=9x`)).status).toBe(400);
    expect((await fetch(`${base}/api/agents/01ARZ3NDEKTSV4RRFFQ69G5FAV/market`)).status).toBe(404);
    const hd = (await (await fetch(`${base}/api/agents/${ids.good}/holders`)).json()) as {
      holders: { pct: number }[];
    };
    expect(hd.holders).toHaveLength(10);
    const t = (await (await fetch(base + "/api/treasury")).json()) as {
      agents: number;
      rows: { name: string }[];
    };
    expect(t.agents).toBe(2);
    expect(t.rows.length).toBe(2);
  });
});

describe("write endpoints", () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, raw?: string) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: raw ?? JSON.stringify(body),
    });

  async function wallet() {
    const { generateKeyPairSync } = await import("node:crypto");
    const { base58Encode } = await import("@devagent/community");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return {
      address: base58Encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32)),
      key: privateKey,
    };
  }
  async function signed(w: Awaited<ReturnType<typeof wallet>>, o: Record<string, unknown> = {}) {
    const { sign } = await import("node:crypto");
    const { deployMessage } = await import("@devagent/platform");
    const b = {
      name: "Pixel Smith",
      model: "opus",
      brief: "Build small tested command line tools for plain text.",
      nonce: "abcdef123456",
      ts: Date.now(),
      ...o,
    };
    const signature = sign(null, Buffer.from(deployMessage(b as never)), w.key).toString("base64");
    return { ...b, wallet: w.address, signature };
  }

  it("deploys a signed agent that then shows up in the public list with its model", async () => {
    const w = await wallet();
    const r = await post("/api/deploy", await signed(w));
    expect(r.status).toBe(201);
    const { agentId } = (await r.json()) as { agentId: string };
    const d = (await (await fetch(`${base}/api/agents/${agentId}`)).json()) as {
      model: string;
      lockedPrompt: string;
      deployer: string;
    };
    expect(d.model).toBe("opus");
    expect(d.lockedPrompt).toContain("command line tools");
    const list = (await (await fetch(base + "/api/agents?sort=new")).json()) as {
      agents: { id: string }[];
    };
    expect(list.agents[0]!.id).toBe(agentId);
  });

  it("rejects bad input with a plain message and never a stack trace", async () => {
    web.close();
    await start({ rateLimit: 1000, deployPerHour: 100 });
    const w = await wallet();
    const bad = await post("/api/deploy", {
      ...(await signed(w)),
      model: "opus",
      brief: "swapped after signing but long enough",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/signature/);
    expect((await post("/api/deploy", {}, {}, "not json")).status).toBe(400);
    expect((await post("/api/deploy", {}, {}, "[1]")).status).toBe(400);
    expect(
      (
        await fetch(base + "/api/deploy", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "x",
        })
      ).status,
    ).toBe(415);
    expect((await post("/api/deploy", { brief: "x".repeat(20_000) })).status).toBe(413);
    expect((await post("/api/deploy", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/nope", {})).status).toBe(405);
  });

  it("limits deploy attempts per client", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post("/api/deploy", {})).status);
    expect(codes.filter((c) => c === 429).length).toBe(2);
  });

  it("reports pause an agent after five; a takedown then hides it with a 410", async () => {
    web.close();
    const s = await seed();
    const { KillSwitch } = await import("@devagent/safety");
    const { takedown } = await import("@devagent/platform");
    const kill = new KillSwitch(s.db, s.clock);
    web = createWebServer({
      db: s.db,
      treasury: s.treasury,
      kill,
      pollMs: 50,
      rateLimit: 1000,
      deployPerHour: 100,
    });
    await new Promise<void>((r) => web.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
    for (let i = 0; i < 5; i++)
      expect(
        (await post("/api/report", { agentId: s.good, reason: "scam", detail: "looks wrong" }))
          .status,
      ).toBe(i < 5 ? 201 : 429);
    expect(kill.isHalted(s.good)).toBe(true);
    expect((await post("/api/report", { agentId: s.good, reason: "nonsense" })).status).toBe(429);
    takedown(s.db, s.clock, kill, ["op"], s.good, "op", "confirmed scam");
    expect((await fetch(`${base}/api/agents/${s.good}`)).status).toBe(410);
    const list = (await (await fetch(base + "/api/agents")).json()) as {
      agents: { id: string }[];
      stats: { agents: number };
    };
    expect(list.agents.map((a) => a.id)).not.toContain(s.good);
    expect(list.stats.agents).toBe(1);
  });

  it("uploads a logo, serves it safely and shows it on the card with the ticker", async () => {
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4",
      "hex",
    );
    const up = await fetch(base + "/api/logo", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: png,
    });
    expect(up.status).toBe(201);
    const { id: logoId } = (await up.json()) as { id: string };
    const got = await fetch(`${base}/logo/${logoId}`);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    const bad = await fetch(base + "/api/logo", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: '<svg onload="alert(1)"></svg>........',
    });
    expect(bad.status).toBe(400);
    const big = await fetch(base + "/api/logo", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.alloc(5 * 1024 * 1024 + 10, 1),
    });
    expect(big.status).toBe(413);
    const w = await wallet();
    const out = await post("/api/deploy", {
      ...(await signed(w)),
      ticker: "pixl",
      description: "Tiny image tools.",
      xHandle: "@pixelsmith",
      logoId,
    });
    expect(out.status).toBe(201);
    const { agentId } = (await out.json()) as { agentId: string };
    const list = (await (await fetch(base + "/api/agents")).json()) as {
      agents: { id: string; ticker: string; logo: string | null; description: string }[];
    };
    const mine = list.agents.find((a) => a.id === agentId)!;
    expect(mine.ticker).toBe("PIXL");
    expect(mine.logo).toBe(`/logo/${logoId}`);
    const series = (await (await fetch(`${base}/api/agents/${agentId}/series`)).json()) as {
      days: number[];
    };
    expect(series.days).toHaveLength(30);
    const again = await post("/api/deploy", {
      ...(await signed(w, { name: "Second One" })),
      logoId,
    });
    expect(again.status).toBe(400);
  });

  it("voting needs a coin and a valid signature, then counts once", async () => {
    const s = await seed();
    web.close();
    const { MockBalances, voteMessage } = await import("@devagent/community");
    const w = await wallet();
    const mb = new MockBalances({ [w.address]: 5000 });
    web = createWebServer({
      db: s.db,
      treasury: s.treasury,
      pollMs: 50,
      balancesFor: (id) => (id === s.good ? mb : undefined),
    });
    await new Promise<void>((r) => web.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
    const q = (
      (await (await fetch(`${base}/api/agents/${s.good}`)).json()) as {
        queue: { id: string; summary: string }[];
      }
    ).queue.find((x) => x.summary.includes("date parser"))!;
    const { sign } = await import("node:crypto");
    const sig = sign(null, Buffer.from(voteMessage(s.good, q.id)), w.key).toString("base64");
    const body = { agentId: s.good, suggestionId: q.id, wallet: w.address, signature: sig };
    expect((await post("/api/vote", { ...body, agentId: s.evil })).status).toBe(400);
    expect((await post("/api/vote", { ...body, signature: "AAAA" })).status).toBe(400);
    const ok = await post("/api/vote", body);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { weight: number }).weight).toBe(5000);
    expect((await post("/api/vote", body)).status).toBe(400);
  });
});
