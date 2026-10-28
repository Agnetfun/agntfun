import type { Db } from "@devagent/db";

const DAY = 86_400_000;
export interface Series {
  /** Start of each day, oldest first. */
  days: number[];
  merges: number[];
  posts: number[];
  spendCents: number[];
  /** End of day treasury balance (cash plus prepaid credits). */
  balanceCents: number[];
}

/** Daily numbers for the last `n` days. Everything comes from append only tables, nothing is estimated. */
export function agentSeries(db: Db, agentId: string, now: number, n = 30): Series {
  const end = Math.floor(now / DAY) * DAY + DAY;
  const start = end - n * DAY;
  const idx = (ts: number) => Math.floor((ts - start) / DAY);
  const zeros = () => Array.from({ length: n }, () => 0);
  const out: Series = {
    days: Array.from({ length: n }, (_, i) => start + i * DAY),
    merges: zeros(),
    posts: zeros(),
    spendCents: zeros(),
    balanceCents: zeros(),
  };
  const put = (arr: number[], ts: number, v: number) => {
    const i = idx(ts);
    if (i >= 0 && i < n) arr[i] = (arr[i] ?? 0) + v;
  };
  for (const r of db
    .prepare(
      "SELECT ts FROM events WHERE agent_id=? AND type='session.published' AND ts>=? AND json_extract(payload_json,'$.merged')=1",
    )
    .all(agentId, start) as { ts: number }[])
    put(out.merges, r.ts, 1);
  for (const r of db
    .prepare("SELECT ts FROM posts WHERE agent_id=? AND ts>=?")
    .all(agentId, start) as {
    ts: number;
  }[])
    put(out.posts, r.ts, 1);
  for (const r of db
    .prepare("SELECT started_at ts, cost_cents c FROM sessions WHERE agent_id=? AND started_at>=?")
    .all(agentId, start) as { ts: number; c: number }[])
    put(out.spendCents, r.ts, r.c);
  const open = db
    .prepare(
      "SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END),0) v FROM ledger WHERE agent_id=? AND unit='usd_cents' AND account IN ('asset:treasury_usd','asset:llm_credits') AND ts<?",
    )
    .get(agentId, start) as { v: number };
  const delta = zeros();
  for (const r of db
    .prepare(
      "SELECT ts, direction d, amount a FROM ledger WHERE agent_id=? AND unit='usd_cents' AND account IN ('asset:treasury_usd','asset:llm_credits') AND ts>=?",
    )
    .all(agentId, start) as { ts: number; d: string; a: number }[])
    put(delta, r.ts, r.d === "debit" ? r.a : -r.a);
  let run = open.v;
  for (let i = 0; i < n; i++) {
    run += delta[i] ?? 0;
    out.balanceCents[i] = run;
  }
  return out;
}
