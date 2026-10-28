import { describe, expect, it } from "vitest";
import { FakeClock, generateSealKeys } from "@devagent/core";
import { createAgent, migrate, openDb } from "@devagent/db";
import {
  AUTH_FAILURE,
  SealedVault,
  TokenSource,
  XMentionsSource,
  connectionHealth,
  markCredentialError,
  markCredentialOk,
  storeCredential,
} from "../src/index";

const app = { clientId: "cid", clientSecret: "sec", redirectUri: "http://127.0.0.1:3000/oauth/callback/x" };

function setup() {
  const clock = new FakeClock(1_000_000_000);
  const db = openDb(":memory:");
  migrate(db, clock);
  const a = createAgent(db, clock, { name: "Acct Bot", model: "opus", lockedPrompt: "x".repeat(30) });
  return { db, clock, id: a.id, keys: generateSealKeys() };
}
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

describe("agent account tokens", () => {
  it("hands out a fresh token without calling X while it is valid", async () => {
    const { db, clock, id, keys } = setup();
    storeCredential(db, clock, keys.publicKey, id, "x", JSON.stringify({ access: "a1", refresh: "r1", expiresAt: clock.now() + 3_600_000 }));
    let calls = 0;
    const src = new TokenSource(db, clock, new SealedVault(db, keys.privateKey), keys.publicKey, { x: app }, (async () => {
      calls++;
      return json({});
    }) as typeof fetch);
    expect(await src.get(id, "x")).toBe("a1");
    expect(calls).toBe(0);
  });

  it("refreshes before expiry, keeps the rotated refresh token, and stores it sealed", async () => {
    const { db, clock, id, keys } = setup();
    storeCredential(db, clock, keys.publicKey, id, "x", JSON.stringify({ access: "a1", refresh: "r1", expiresAt: clock.now() + 60_000 }));
    let body = "";
    const fake = (async (_u: string, init?: RequestInit) => {
      body = String(init?.body);
      return json({ access_token: "a2", refresh_token: "r2", expires_in: 7200 });
    }) as typeof fetch;
    const vault = new SealedVault(db, keys.privateKey);
    const src = new TokenSource(db, clock, vault, keys.publicKey, { x: app }, fake);
    expect(await src.get(id, "x")).toBe("a2");
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=r1");
    expect(JSON.parse(vault.get(id, "x")!)).toMatchObject({ access: "a2", refresh: "r2" });
    const raw = (db.prepare("SELECT sealed FROM agent_credentials WHERE agent_id=?").get(id) as { sealed: string }).sealed;
    expect(raw).not.toContain("a2");
  });

  it("refreshes once even when two callers ask at the same time", async () => {
    const { db, clock, id, keys } = setup();
    storeCredential(db, clock, keys.publicKey, id, "x", JSON.stringify({ access: "a1", refresh: "r1", expiresAt: clock.now() }));
    let calls = 0;
    const fake = (async () => {
      calls++;
      return json({ access_token: "a2", refresh_token: "r2", expires_in: 7200 });
    }) as typeof fetch;
    const src = new TokenSource(db, clock, new SealedVault(db, keys.privateKey), keys.publicKey, { x: app }, fake);
    await Promise.all([src.get(id, "x"), src.get(id, "x")]);
    expect(calls).toBe(1);
  });
});

describe("connection health", () => {
  it("flags needs reconnect on an auth failure and clears it on success or a new token", () => {
    const { db, clock, id, keys } = setup();
    storeCredential(db, clock, keys.publicKey, id, "github", "tok", "acct-bot");
    expect(connectionHealth(db, id).github).toMatchObject({ account: "acct-bot", needsReconnect: false });
    clock.advance(1000);
    markCredentialError(db, clock, id, "github", "github repo check failed: 401");
    expect(connectionHealth(db, id).github.needsReconnect).toBe(true);
    clock.advance(1000);
    markCredentialOk(db, clock, id, "github");
    expect(connectionHealth(db, id).github.needsReconnect).toBe(false);
    markCredentialError(db, clock, id, "github", "Bad credentials");
    storeCredential(db, clock, keys.publicKey, id, "github", "tok2");
    expect(connectionHealth(db, id).github.needsReconnect).toBe(false);
  });

  it("classifies auth failures but not ordinary errors", () => {
    for (const m of ["x post failed: 401", "github repo check failed: 403", "remote: Authentication failed", "x token request failed: invalid_grant", "no X token for this agent"])
      expect(AUTH_FAILURE.test(m)).toBe(true);
    for (const m of ["x post failed: 429", "x post failed: 503", "git apply failed"]) expect(AUTH_FAILURE.test(m)).toBe(false);
  });

  it("never stores a token-like string in the error text", () => {
    const { db, clock, id, keys } = setup();
    storeCredential(db, clock, keys.publicKey, id, "x", "t");
    markCredentialError(db, clock, id, "x", "401 for token abcdefghijklmnopqrstuvwxyz0123456789");
    const r = db.prepare("SELECT last_error e FROM agent_credentials WHERE agent_id=?").get(id) as { e: string };
    expect(r.e).toContain("[redacted]");
  });
});

describe("X mentions", () => {
  it("reads at most once per interval", async () => {
    let now = 0;
    let calls = 0;
    const fake = (async (u: string) => {
      calls++;
      return String(u).includes("/users/me") ? json({ data: { id: "1" } }) : json({ data: [], meta: {} });
    }) as typeof fetch;
    const src = new XMentionsSource(() => "t", fake, 15 * 60_000, () => now);
    await src.fetch();
    const after = calls;
    now = 60_000;
    await src.fetch();
    expect(calls).toBe(after);
    now = 15 * 60_000;
    await src.fetch();
    expect(calls).toBeGreaterThan(after);
  });
});
