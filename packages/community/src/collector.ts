import { ulid, type Clock } from "@devagent/core";
import type { Db } from "@devagent/db";

export interface RawItem {
  externalId: string;
  author: string;
  text: string;
}
export interface CommunitySource {
  readonly name: string;
  fetch(): Promise<RawItem[]>;
}

export class MockSource implements CommunitySource {
  readonly name = "mock";
  constructor(public items: RawItem[] = []) {}
  async fetch() {
    return this.items;
  }
}

// The real X mentions source lives in the gateway (it needs the agent's token): XMentionsSource.
export const MAX_RAW = 500;
// Control characters plus zero width and bidi override characters, which can hide text from reviewers.
/* eslint-disable no-control-regex */
const INVISIBLE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

/** Stores raw text as data only. Nothing here is ever shown to the agent. */
export async function collect(
  db: Db,
  clock: Clock,
  agentId: string,
  src: CommunitySource,
): Promise<number> {
  let added = 0;
  for (const it of await src.fetch()) {
    const text = it.text.replace(INVISIBLE, "").trim().slice(0, MAX_RAW);
    if (!text) continue;
    const r = db
      .prepare(
        "INSERT OR IGNORE INTO suggestions (id, agent_id, source, external_id, author_ref, raw_text, received_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        ulid(clock.now()),
        agentId,
        src.name,
        it.externalId.slice(0, 64),
        it.author.slice(0, 64),
        text,
        clock.now(),
      );
    added += Number(r.changes);
  }
  return added;
}

/** One idea typed on the website. Stored as untrusted raw text exactly like an X mention; triage decides later. */
export async function submitSuggestion(
  db: Db,
  clock: Clock,
  agentId: string,
  author: string,
  text: string,
): Promise<boolean> {
  const id = ulid(clock.now());
  const src: CommunitySource = { name: "web", fetch: async () => [{ externalId: id, author, text }] };
  return (await collect(db, clock, agentId, src)) === 1;
}
