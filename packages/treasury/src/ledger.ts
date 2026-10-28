import { ulid, type Clock } from "@devagent/core";
import type { Db } from "@devagent/db";

export type Unit = "lamports" | "usdc_micro" | "usd_cents";
export interface Entry {
  account: string;
  direction: "debit" | "credit";
  amount: number;
}
export interface Txn {
  agentId: string;
  unit: Unit;
  entries: Entry[];
  refType?: string;
  refId?: string;
  operatorId?: string;
}

export class LedgerError extends Error {}

/** Double entry: debits must equal credits. All rows of a transaction are written atomically. */
export function postTxn(db: Db, clock: Clock, t: Txn): string {
  if (t.entries.length < 2) throw new LedgerError("a transaction needs at least two entries");
  let debit = 0;
  let credit = 0;
  for (const e of t.entries) {
    if (!Number.isInteger(e.amount) || e.amount <= 0)
      throw new LedgerError("amounts must be positive integers");
    if (e.direction === "debit") debit += e.amount;
    else credit += e.amount;
  }
  if (debit !== credit)
    throw new LedgerError(`unbalanced transaction: debit ${debit} credit ${credit}`);
  const txnId = ulid(clock.now());
  const ins = db.prepare(
    "INSERT INTO ledger (id, ts, txn_id, agent_id, account, amount, unit, direction, ref_type, ref_id, operator_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  db.exec("BEGIN");
  try {
    for (const e of t.entries)
      ins.run(
        ulid(clock.now()),
        clock.now(),
        txnId,
        t.agentId,
        e.account,
        e.amount,
        t.unit,
        e.direction,
        t.refType ?? null,
        t.refId ?? null,
        t.operatorId ?? null,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return txnId;
}

/** Debit-normal accounts (assets, expenses) count debits minus credits; the rest count credits minus debits. */
export function balance(db: Db, agentId: string, account: string, unit: Unit): number {
  const r = db
    .prepare(
      "SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END),0) AS net FROM ledger WHERE agent_id=? AND account=? AND unit=?",
    )
    .get(agentId, account, unit) as { net: number };
  const debitNormal = account.startsWith("asset:") || account.startsWith("expense:");
  return debitNormal ? r.net : -r.net;
}

/** Sanity check used by tests and the dashboard: every transaction balances. */
export function unbalancedTxns(db: Db): string[] {
  return (
    db
      .prepare(
        "SELECT txn_id FROM ledger GROUP BY txn_id, unit HAVING SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END) != 0",
      )
      .all() as { txn_id: string }[]
  ).map((r) => r.txn_id);
}
