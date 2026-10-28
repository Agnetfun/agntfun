import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeClock, generateSealKeys } from "@devagent/core";
import { base58Encode } from "@devagent/community";
import { createAgent, migrate, openDb } from "@devagent/db";
import { connections } from "@devagent/gateway";
import { connectMessage, finishConnect, startConnect } from "../src/connect";

const app = { clientId: "cid", clientSecret: "secret", redirectUri: "http://127.0.0.1:3000/oauth/callback/x" };

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    address: base58Encode(raw),
    sign: (m: string) => sign(null, Buffer.from(m), privateKey).toString("base64"),
  };
}

function setup() {
  const clock = new FakeClock(Date.now());
  const db = openDb(":memory:");
  migrate(db, clock);
  const owner = wallet();
  const a = createAgent(db, clock, { name: "Conn Bot", model: "opus", lockedPrompt: "x".repeat(30), repo: "org/conn-bot" });
  db.prepare("UPDATE agents SET deployer=? WHERE id=?").run(owner.address, a.id);
  return { db, clock, owner, id: a.id, keys: generateSealKeys() };
}

const req = (id: string, w: ReturnType<typeof wallet>, clock: FakeClock, nonce = "abcdef123456") => {
  const ts = clock.now();
  return { agentId: id, kind: "x" as const, wallet: w.address, nonce, ts, signature: w.sign(connectMessage(id, "x", nonce, ts)) };
};

describe("connect an agent's own accounts", () => {
  it("only the creator wallet can start, with a fresh signature", () => {
    const { db, clock, owner, id } = setup();
    const other = wallet();
    expect(startConnect(db, clock, { x: app }, req(id, other, clock)).ok).toBe(false);
    const bad = { ...req(id, owner, clock), signature: other.sign("nope") };
    expect(startConnect(db, clock, { x: app }, bad).ok).toBe(false);
    const old = req(id, owner, clock);
    clock.advance(11 * 60_000);
    expect(startConnect(db, clock, { x: app }, old).ok).toBe(false);
  });

  it("refuses a reused nonce and an unconfigured provider", () => {
    const { db, clock, owner, id } = setup();
    expect(startConnect(db, clock, {}, req(id, owner, clock)).ok).toBe(false);
    expect(startConnect(db, clock, { x: app }, req(id, owner, clock, "nonce000001")).ok).toBe(true);
    expect(startConnect(db, clock, { x: app }, req(id, owner, clock, "nonce000001")).ok).toBe(false);
  });

  it("returns an authorize URL with PKCE, and the login state works once", async () => {
    const { db, clock, owner, id, keys } = setup();
    const s = startConnect(db, clock, { x: app }, req(id, owner, clock));
    if (!s.ok) throw new Error(s.reason);
    const url = new URL(s.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    const fakeFetch = (async (u: string) =>
      new Response(
        JSON.stringify(
          String(u).includes("oauth2/token")
            ? { access_token: "acc", refresh_token: "ref", expires_in: 7200 }
            : { data: { username: "conn_bot" } },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const done = await finishConnect(db, clock, { x: app }, keys.publicKey, "x", "code", state, fakeFetch);
    expect(done).toEqual({ ok: true, agentId: id, account: "conn_bot" });
    expect(connections(db, id).x).toBe("conn_bot");
    expect((db.prepare("SELECT x_handle h FROM agents WHERE id=?").get(id) as { h: string }).h).toBe("conn_bot");
    const again = await finishConnect(db, clock, { x: app }, keys.publicKey, "x", "code", state, fakeFetch);
    expect(again.ok).toBe(false);
  });

  it("an expired login state is refused", async () => {
    const { db, clock, owner, id, keys } = setup();
    const s = startConnect(db, clock, { x: app }, req(id, owner, clock));
    if (!s.ok) throw new Error(s.reason);
    clock.advance(16 * 60_000);
    const state = new URL(s.url).searchParams.get("state")!;
    expect((await finishConnect(db, clock, { x: app }, keys.publicKey, "x", "c", state)).ok).toBe(false);
  });
});
