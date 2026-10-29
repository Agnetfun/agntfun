import type { Clock } from "@devagent/core";
import { appendEvent, setAgentState, type Db } from "@devagent/db";
import { balance, postTxn, type Entry } from "./ledger";

export interface TreasuryPolicy {
  /** Hard ceiling on spend per rolling day, in cents. */
  dailyCapCents: number;
  /** Below this many days of runway the agent sleeps and stops spending. */
  minRunwayDays: number;
  /** Must be at least the largest possible session cost (LLM cap plus post), or balances can go negative. */
  sessionReserveCents: number;
}
export const DEFAULT_POLICY: TreasuryPolicy = {
  dailyCapCents: 500,
  minRunwayDays: 0.5,
  sessionReserveCents: 25,
};

export type SpendCategory = "llm" | "x_posts" | "infra";
export type Gate = { ok: true } | { ok: false; reason: "no_funds" | "daily_cap" | "low_runway" };

const DAY = 86_400_000;
const USD = "asset:treasury_usd";
const CREDITS = "asset:llm_credits";

export class OperatorError extends Error {}

export class Treasury {
  constructor(
    private db: Db,
    private clock: Clock,
    private operators: string[],
    private policy: TreasuryPolicy = DEFAULT_POLICY,
  ) {}

  /** Spendable money: cash plus prepaid LLM credits. */
  balanceCents(agentId: string): number {
    return this.cashCents(agentId) + this.creditsCents(agentId);
  }
  cashCents(agentId: string): number {
    return balance(this.db, agentId, USD, "usd_cents");
  }
  creditsCents(agentId: string): number {
    return balance(this.db, agentId, CREDITS, "usd_cents");
  }

  /** True when a ledger entry with this reference exists, which makes inflow booking idempotent. */
  hasRef(refType: string, ref: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 AS x FROM ledger WHERE ref_type=? AND ref_id=? LIMIT 1")
        .get(refType, ref) !== undefined
    );
  }

  /** Creator fees arrive in lamports. Booked at receipt; converted when an operator or a swap service sells them. */
  recordCreatorFee(agentId: string, lamports: number, ref: string): boolean {
    if (this.hasRef("creator_fee", ref)) return false;
    postTxn(this.db, this.clock, {
      agentId,
      unit: "lamports",
      refType: "creator_fee",
      refId: ref,
      entries: [
        { account: "asset:treasury_sol", direction: "debit", amount: lamports },
        { account: "income:creator_fees", direction: "credit", amount: lamports },
      ],
    });
    return true;
  }

  /** Books a conversion at a rate supplied by the caller (price source is TODO(verify), Phase 6). */
  convertSolToUsd(agentId: string, lamports: number, cents: number, ref: string): void {
    postTxn(this.db, this.clock, {
      agentId,
      unit: "lamports",
      refType: "convert",
      refId: ref,
      entries: [
        { account: "equity:fx", direction: "debit", amount: lamports },
        { account: "asset:treasury_sol", direction: "credit", amount: lamports },
      ],
    });
    postTxn(this.db, this.clock, {
      agentId,
      unit: "usd_cents",
      refType: "convert",
      refId: ref,
      entries: [
        { account: USD, direction: "debit", amount: cents },
        { account: "equity:fx", direction: "credit", amount: cents },
      ],
    });
    this.wakeIfFunded(agentId);
  }

  /** Top-up from the operator or a supporter (card or manual). */
  topUp(agentId: string, cents: number, ref: string): void {
    postTxn(this.db, this.clock, {
      agentId,
      unit: "usd_cents",
      refType: "topup",
      refId: ref,
      entries: [
        { account: USD, direction: "debit", amount: cents },
        { account: "income:topups", direction: "credit", amount: cents },
      ],
    });
    this.wakeIfFunded(agentId);
  }

  spend(agentId: string, category: SpendCategory, cents: number, ref: string): void {
    if (cents <= 0) return;
    // LLM costs draw on prepaid credits first, then cash.
    const fromCredits = category === "llm" ? Math.min(cents, this.creditsCents(agentId)) : 0;
    const entries: Entry[] = [
      { account: `expense:${category}`, direction: "debit", amount: cents },
    ];
    if (fromCredits > 0)
      entries.push({ account: CREDITS, direction: "credit", amount: fromCredits });
    if (cents - fromCredits > 0)
      entries.push({ account: USD, direction: "credit", amount: cents - fromCredits });
    postTxn(this.db, this.clock, {
      agentId,
      unit: "usd_cents",
      refType: category,
      refId: ref,
      entries,
    });
  }

  spentLastDay(agentId: string): number {
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE agent_id=? AND unit='usd_cents' AND direction='debit' AND account LIKE 'expense:%' AND ts > ?",
      )
      .get(agentId, this.clock.now() - DAY) as { s: number };
    return r.s;
  }

  /** Average daily burn over the last week of real spend (at least one day of history assumed). */
  burnPerDay(agentId: string): number {
    const since = this.clock.now() - 7 * DAY;
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) AS s, MIN(ts) AS first FROM ledger WHERE agent_id=? AND unit='usd_cents' AND direction='debit' AND account LIKE 'expense:%' AND ts > ?",
      )
      .get(agentId, since) as { s: number; first: number | null };
    if (!r.first) return 0;
    const days = Math.max(1, (this.clock.now() - r.first) / DAY);
    return r.s / days;
  }

  runwayDays(agentId: string): number {
    const burn = this.burnPerDay(agentId);
    return burn === 0 ? Infinity : Math.max(0, this.balanceCents(agentId)) / burn;
  }

  /** Asked before every session. Nothing spends money without passing this. */
  canRun(agentId: string): Gate {
    const bal = this.balanceCents(agentId);
    if (bal < this.policy.sessionReserveCents) return { ok: false, reason: "no_funds" };
    if (this.spentLastDay(agentId) + this.policy.sessionReserveCents > this.policy.dailyCapCents)
      return { ok: false, reason: "daily_cap" };
    if (this.runwayDays(agentId) < this.policy.minRunwayDays)
      return { ok: false, reason: "low_runway" };
    return { ok: true };
  }

  /** Operator only. The agent has no path to this method; an unknown operator id is refused. */
  withdraw(agentId: string, cents: number, operatorId: string, to: string): void {
    this.assertOperator(operatorId);
    if (cents > this.cashCents(agentId)) throw new OperatorError("insufficient cash");
    postTxn(this.db, this.clock, {
      agentId,
      unit: "usd_cents",
      refType: "withdraw",
      refId: to,
      operatorId,
      entries: [
        { account: "equity:operator_withdrawals", direction: "debit", amount: cents },
        { account: USD, direction: "credit", amount: cents },
      ],
    });
    appendEvent(this.db, this.clock, {
      type: "treasury.withdraw",
      agentId,
      payload: { cents, operatorId, to },
    });
  }

  /** Operator buys LLM credits with treasury money (the actual purchase happens in the provider console). */
  buyCredits(agentId: string, cents: number, operatorId: string, provider: string): void {
    this.assertOperator(operatorId);
    if (cents > this.cashCents(agentId)) throw new OperatorError("insufficient cash");
    postTxn(this.db, this.clock, {
      agentId,
      unit: "usd_cents",
      refType: "credit_purchase",
      refId: provider,
      operatorId,
      entries: [
        { account: CREDITS, direction: "debit", amount: cents },
        { account: USD, direction: "credit", amount: cents },
      ],
    });
    appendEvent(this.db, this.clock, {
      type: "treasury.buy_credits",
      agentId,
      payload: { cents, operatorId, provider },
    });
  }

  private assertOperator(id: string) {
    if (!id || !this.operators.includes(id)) throw new OperatorError("not an operator");
  }

  private wakeIfFunded(agentId: string) {
    const row = this.db.prepare("SELECT state FROM agents WHERE id=?").get(agentId) as
      { state: string } | undefined;
    if (row?.state === "starved" && this.canRun(agentId).ok)
      setAgentState(this.db, agentId, "sleeping");
  }
}
