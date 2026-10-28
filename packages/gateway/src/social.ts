import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "@devagent/core";
import type { Social } from "./types";

/** Writes posts to a local outbox file instead of X. Lets the whole loop run with no X account. */
export class LocalSocial implements Social {
  constructor(private file = join("data", "outbox", "x.jsonl")) {}
  async post(agentId: string, text: string) {
    mkdirSync(dirname(this.file), { recursive: true });
    const ref = `local-x-${ulid()}`;
    appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), agentId, ref, text }) + "\n");
    return { ref };
  }
}

const X_API = "https://api.x.com/2";

/**
 * X API v2 with an OAuth 2.0 user access token per agent (scopes tweet.read tweet.write users.read).
 * POST /2/tweets {text} answers 201 {data:{id,text}}.
 * Tokens come from TokenSource, which refreshes them before they expire. TODO(verify): current X API pricing.
 */
export class XSocial implements Social {
  constructor(
    private token: (agentId: string) => Promise<string | undefined> | string | undefined,
    private fetchFn: typeof fetch = fetch,
  ) {}
  async post(agentId: string, text: string) {
    const t = await this.token(agentId);
    if (!t) throw new Error("no X token for this agent");
    const r = await this.fetchFn(`${X_API}/tweets`, {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(`x post failed: ${r.status}`);
    const j = (await r.json()) as { data?: { id?: string } };
    if (!j.data?.id) throw new Error("x post: no id in response");
    return { ref: `x:${j.data.id}` };
  }
}

/**
 * Mentions of the agent's X account as community suggestions (raw, untrusted; triage runs later).
 * GET /2/users/me, then GET /2/users/:id/mentions with since_id. Shape matches CommunitySource.
 */
export class XMentionsSource {
  readonly name = "x";
  private userId?: string;
  private sinceId?: string;
  private lastAt = 0;
  /**
   * @param minIntervalMs reads at most this often (X reads count against rate limits, about 180 per 15 minutes per
   *   user, and may be billed on your plan); calls in between return nothing.
   */
  constructor(
    private token: () => Promise<string | undefined> | string | undefined,
    private fetchFn: typeof fetch = fetch,
    private minIntervalMs = 15 * 60_000,
    private now: () => number = Date.now,
  ) {}
  private async get<T>(path: string, t: string): Promise<T> {
    const r = await this.fetchFn(`${X_API}${path}`, { headers: { authorization: `Bearer ${t}` } });
    if (!r.ok) throw new Error(`x read failed: ${r.status}`);
    return (await r.json()) as T;
  }
  async fetch() {
    if (this.now() - this.lastAt < this.minIntervalMs) return [];
    this.lastAt = this.now();
    const t = await this.token();
    if (!t) return [];
    this.userId ??= (await this.get<{ data: { id: string } }>("/users/me", t)).data.id;
    const q = new URLSearchParams({ max_results: "20", "tweet.fields": "author_id" });
    if (this.sinceId) q.set("since_id", this.sinceId);
    const j = await this.get<{ data?: { id: string; text: string; author_id?: string }[]; meta?: { newest_id?: string } }>(
      `/users/${this.userId}/mentions?${q}`,
      t,
    );
    if (j.meta?.newest_id) this.sinceId = j.meta.newest_id;
    return (j.data ?? []).map((m) => ({ externalId: m.id, author: m.author_id ?? "unknown", text: m.text }));
  }
}
