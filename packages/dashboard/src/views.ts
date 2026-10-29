import type { Db } from "@devagent/db";
import { COIN_SUPPLY, meetsQuorum, quorumFromEnv, rankQueue } from "@devagent/community";
import { agentWalletAddress, getLaunch, splitIsSet } from "@devagent/launch";
import { agentSeries, proofScore, rankAgents, type Sort } from "@devagent/platform";
import type { Treasury } from "@devagent/treasury";

/**
 * Public view models. Everything here is safe to publish: no raw community text, no author handles,
 * no operator ids, no keys. Text that did originate outside (posts, agent prompts, triaged summaries)
 * is still treated as untrusted by the UI, which only ever writes it with textContent.
 */
export interface AgentCard {
  id: string;
  name: string;
  model: "opus" | "astra";
  state: string;
  repo: string | null;
  mint: string | null;
  sessions: number;
  merged: number;
  lastActiveAt: number | null;
  runwayDays: number | null;
  balanceCents: number;
  nextWakeAt: number | null;
  deployer: string | null;
  proofScore: number;
  ticker: string;
  description: string;
  logo: string | null;
  createdAt: number;
  /** Daily activity for the last 14 days, oldest first. */
  spark: number[];
  /** SOL that reached the agent's wallet so far (fee share, supporters). */
  feesSol: number;
  /** Both of its own accounts are connected: GitHub and X. */
  verified: boolean;
}

type Row = Record<string, unknown>;

export function agentCards(
  db: Db,
  treasury: Treasury,
  sort: Sort = "new",
  now = Date.now(),
): AgentCard[] {
  const ids = rankAgents(db, now, sort, (id) => treasury.balanceCents(id));
  const out: AgentCard[] = [];
  for (const id of ids) {
    const a = db.prepare("SELECT * FROM agents WHERE id=?").get(id) as Row | undefined;
    if (a) out.push(card(db, treasury, a, now));
  }
  return out;
}

function card(db: Db, treasury: Treasury, a: Row, now = Date.now()): AgentCard {
  const id = a.id as string;
  const s = db
    .prepare(
      "SELECT COUNT(*) c, MAX(COALESCE(ended_at, started_at)) last FROM sessions WHERE agent_id=?",
    )
    .get(id) as { c: number; last: number | null };
  const merged = db
    .prepare(
      "SELECT COUNT(*) c FROM events WHERE agent_id=? AND type='session.published' AND json_extract(payload_json,'$.merged')=1",
    )
    .get(id) as { c: number };
  const sch = db.prepare("SELECT next_wake_at n FROM agent_schedule WHERE agent_id=?").get(id) as
    { n: number } | undefined;
  const runway = treasury.runwayDays(id);
  return {
    id,
    name: a.name as string,
    model: a.model as "opus" | "astra",
    state: a.state as string,
    repo: (a.repo as string | null) ?? null,
    mint: getLaunch(db, id)?.mint ?? null,
    sessions: s.c,
    merged: merged.c,
    lastActiveAt: s.last,
    runwayDays: Number.isFinite(runway) ? Math.round(runway * 10) / 10 : null,
    balanceCents: treasury.balanceCents(id),
    nextWakeAt: sch?.n ?? null,
    deployer:
      typeof a.deployer === "string" ? `${a.deployer.slice(0, 4)}…${a.deployer.slice(-4)}` : null,
    proofScore: proofScore(db, id, now),
    ticker:
      typeof a.ticker === "string" && a.ticker
        ? a.ticker
        : (a.name as string).slice(0, 5).toUpperCase(),
    description: typeof a.description === "string" ? a.description : "",
    logo: typeof a.logo_id === "string" ? `/logo/${a.logo_id}` : null,
    createdAt: a.created_at as number,
    spark: (() => {
      const x = agentSeries(db, id, now, 14);
      return x.merges.map((m, i) => m * 10 + (x.posts[i] ?? 0));
    })(),
    feesSol:
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE agent_id=? AND ref_type='creator_fee' AND direction='debit'",
          )
          .get(id) as { s: number }
      ).s / 1e9,
    verified:
      (
        db
          .prepare("SELECT COUNT(DISTINCT kind) c FROM agent_credentials WHERE agent_id=? AND kind IN ('github','x')")
          .get(id) as { c: number }
      ).c === 2,
  };
}

export interface FeedItem {
  ts: number;
  kind: "push" | "post" | "status" | "funds" | "launch";
  text: string;
  href: string | null;
}

export function feed(db: Db, agentId: string, repo: string | null, limit = 40): FeedItem[] {
  const items: FeedItem[] = [];
  const ev = db
    .prepare(
      "SELECT ts, type, payload_json p FROM events WHERE (agent_id=? OR (agent_id IS NULL AND type LIKE 'kill.%')) AND type IN ('session.published','agent.starved','kill.trip','kill.clear') ORDER BY ts DESC, id DESC LIMIT ?",
    )
    .all(agentId, limit) as { ts: number; type: string; p: string }[];
  for (const e of ev) {
    const p = JSON.parse(e.p) as Record<string, unknown>;
    if (e.type === "session.published") {
      const tests =
        p.testsPassed === true
          ? "tests pass"
          : p.testsPassed === false
            ? "tests failing"
            : "no test result";
      const sha = typeof p.headSha === "string" ? p.headSha.slice(0, 7) : "";
      items.push({
        ts: e.ts,
        kind: "push",
        text: `${p.merged ? "Merged" : p.pushed ? "Pushed a branch" : "Session ended without a push"}: +${p.added} / −${p.removed} in ${p.files} files, ${tests}${sha ? `, ${sha}` : ""}`,
        href:
          repo && sha && p.pushed
            ? `https://github.com/${repo}/commit/${p.headSha as string}`
            : null,
      });
    } else if (e.type === "agent.starved")
      items.push({
        ts: e.ts,
        kind: "status",
        text: "Sleeping until the treasury is topped up",
        href: null,
      });
    else if (e.type === "kill.trip")
      items.push({ ts: e.ts, kind: "status", text: "Stopped by the operator", href: null });
    else items.push({ ts: e.ts, kind: "status", text: "Resumed by the operator", href: null });
  }
  for (const r of db
    .prepare("SELECT ts, text FROM posts WHERE agent_id=? ORDER BY ts DESC LIMIT ?")
    .all(agentId, limit) as {
    ts: number;
    text: string;
  }[])
    items.push({ ts: r.ts, kind: "post", text: r.text, href: null });
  for (const r of db
    .prepare(
      "SELECT ts, account, SUM(amount) a, unit FROM ledger WHERE agent_id=? AND direction='credit' AND account IN ('income:creator_fees','income:topups') GROUP BY txn_id ORDER BY ts DESC LIMIT ?",
    )
    .all(agentId, limit) as { ts: number; account: string; a: number; unit: string }[]) {
    const what =
      r.account === "income:creator_fees"
        ? `Creator fees received: ${(r.a / 1e9).toFixed(3)} SOL`
        : `Top up received: $${(r.a / 100).toFixed(2)}`;
    items.push({ ts: r.ts, kind: "funds", text: what, href: null });
  }
  const l = getLaunch(db, agentId);
  if (l)
    items.push({
      ts: l.launchedAt,
      kind: "launch",
      text: `Token launched on pump.fun (${l.cluster})`,
      href: null,
    });
  return items.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export interface AgentDetail extends AgentCard {
  xHandle: string | null;
  promptHash: string | null;
  lockedPrompt: string;
  treasury: {
    cashCents: number;
    creditsCents: number;
    burnPerDayCents: number;
    spent24hCents: number;
  };
  queue: Array<{ id: string; summary: string; size: string | null; score: number; voters: number; ready: boolean }>;
  /** What an idea needs before the agent builds it. */
  quorum: { minVoters: number; minWeight: number; supply: number };
  recentSessions: Array<{ at: number; endReason: string; costCents: number; tokens: number }>;
  feed: FeedItem[];
  split: Array<{ role: string; shareBps: number }> | null;
  cluster: string | null;
  /** The agent's own Solana wallet (public address only). */
  walletAddress: string | null;
  /** Full deployer address, so the page can show the launch controls to the right wallet. */
  deployerAddress: string | null;
  splitSet: boolean;
  /** The agent's own GitHub account is connected, so its repo lives on github.com. */
  githubLinked: boolean;
}

export function agentDetail(db: Db, treasury: Treasury, id: string): AgentDetail | undefined {
  const a = db.prepare("SELECT * FROM agents WHERE id=?").get(id) as Row | undefined;
  if (!a || a.removed_at) return undefined;
  const c = card(db, treasury, a);
  const launch = getLaunch(db, id);
  const quorum = quorumFromEnv();
  return {
    ...c,
    xHandle: (a.x_handle as string | null) ?? null,
    promptHash: (a.prompt_hash as string | null) ?? null,
    lockedPrompt: a.locked_prompt as string,
    treasury: {
      cashCents: treasury.cashCents(id),
      creditsCents: treasury.creditsCents(id),
      burnPerDayCents: Math.round(treasury.burnPerDay(id)),
      spent24hCents: treasury.spentLastDay(id),
    },
    // Ideas the agent already finished leave the queue (their task is done).
    queue: rankQueue(db, id)
      .filter(
        (q) =>
          !db
            .prepare("SELECT 1 x FROM tasks WHERE agent_id=? AND summary=? AND status='done' LIMIT 1")
            .get(id, q.summary),
      )
      .slice(0, 10)
      .map((q) => ({
        id: q.id,
        summary: q.summary,
        size: q.size,
        score: q.score,
        voters: q.voters,
        ready: meetsQuorum(q, quorum),
      })),
    quorum: { ...quorum, supply: COIN_SUPPLY },
    recentSessions: (
      db
        .prepare(
          "SELECT COALESCE(ended_at, started_at) at, COALESCE(end_reason,'running') r, cost_cents c, tokens_in + tokens_out t FROM sessions WHERE agent_id=? ORDER BY started_at DESC, id DESC LIMIT 10",
        )
        .all(id) as { at: number; r: string; c: number; t: number }[]
    ).map((s) => ({ at: s.at, endReason: s.r, costCents: s.c, tokens: s.t })),
    feed: feed(db, id, c.repo),
    split: launch ? launch.split.map((s) => ({ role: s.role, shareBps: s.shareBps })) : null,
    cluster: launch?.cluster ?? null,
    walletAddress: agentWalletAddress(db, id) ?? null,
    deployerAddress: typeof a.deployer === "string" ? a.deployer : null,
    splitSet: launch ? launch.cluster === "mock" || splitIsSet(db, id) : false,
    githubLinked: !!db.prepare("SELECT 1 x FROM agent_credentials WHERE agent_id=? AND kind='github'").get(id),
  };
}

export function platformStats(db: Db) {
  const n = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    agents: n("SELECT COUNT(*) c FROM agents WHERE removed_at IS NULL"),
    sessions: n("SELECT COUNT(*) c FROM sessions"),
    merges: n(
      "SELECT COUNT(*) c FROM events WHERE type='session.published' AND json_extract(payload_json,'$.merged')=1",
    ),
    posts: n("SELECT COUNT(*) c FROM posts"),
  };
}

/** Changes whenever anything the dashboard shows changes. Cheap enough to poll every few seconds. */
export function version(db: Db): string {
  const r = db
    .prepare(
      "SELECT (SELECT COALESCE(MAX(rowid),0) FROM events) e, (SELECT COALESCE(MAX(rowid),0) FROM ledger) l, (SELECT COALESCE(MAX(rowid),0) FROM posts) p, (SELECT COALESCE(MAX(rowid),0) FROM sessions) s, (SELECT COALESCE(MAX(ended_at),0) FROM sessions) se, (SELECT COUNT(*) FROM suggestions WHERE status IN ('accepted','queued')) q, (SELECT COALESCE(MAX(rowid),0) FROM votes) v, (SELECT group_concat(state) FROM agents) st, (SELECT COUNT(*) FROM agents) na, (SELECT COUNT(*) FROM agents WHERE removed_at IS NOT NULL) rm",
    )
    .get() as Record<string, unknown>;
  return Object.values(r).join(".");
}

export interface TreasuryOverview {
  agents: number;
  balanceCents: number;
  spentCents: number;
  topUpsCents: number;
  creatorFeesLamports: number;
  rows: Array<{
    id: string;
    name: string;
    ticker: string;
    logo: string | null;
    balanceCents: number;
    burnPerDayCents: number;
    runwayDays: number | null;
    spent24hCents: number;
  }>;
}

/** Platform wide money view. Everything is read from the ledger and sessions, nothing is estimated. */
export function treasuryOverview(db: Db, treasury: Treasury): TreasuryOverview {
  const cards = agentCards(db, treasury, "funded");
  const sum = (sql: string) => (db.prepare(sql).get() as { v: number }).v;
  return {
    agents: cards.length,
    balanceCents: cards.reduce((a, c) => a + c.balanceCents, 0),
    spentCents: sum("SELECT COALESCE(SUM(cost_cents),0) v FROM sessions"),
    topUpsCents: sum(
      "SELECT COALESCE(SUM(amount),0) v FROM ledger WHERE account='income:topups' AND direction='credit' AND unit='usd_cents'",
    ),
    creatorFeesLamports: sum(
      "SELECT COALESCE(SUM(amount),0) v FROM ledger WHERE account='income:creator_fees' AND direction='credit' AND unit='lamports'",
    ),
    rows: cards.map((c) => ({
      id: c.id,
      name: c.name,
      ticker: c.ticker,
      logo: c.logo,
      balanceCents: c.balanceCents,
      burnPerDayCents: Math.round(treasury.burnPerDay(c.id)),
      runwayDays: c.runwayDays,
      spent24hCents: treasury.spentLastDay(c.id),
    })),
  };
}
