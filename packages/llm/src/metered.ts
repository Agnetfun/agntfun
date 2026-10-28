import type { Clock } from "@devagent/core";
import { costMicroUsd, type Price } from "./prices";
import type { LlmProvider, LlmRequest, LlmResult } from "./types";

export type CapReason = "tokens" | "cost" | "time" | "steps" | "killed";

export class BudgetExceeded extends Error {
  constructor(readonly reason: CapReason) {
    super(`budget exceeded: ${reason}`);
    this.name = "BudgetExceeded";
  }
}

export interface BudgetLimits {
  maxTokens: number;
  maxMicroUsd: number;
  maxMs: number;
  maxSteps: number;
}

/** Per session limits. Checked before every step and every model call. */
export class SessionBudget {
  tokensIn = 0;
  tokensOut = 0;
  microUsd = 0;
  steps = 0;
  private startedAt: number;

  constructor(
    private limits: BudgetLimits,
    private clock: Clock,
    private isHalted: () => boolean = () => false,
  ) {
    this.startedAt = clock.now();
  }

  get tokens(): number {
    return this.tokensIn + this.tokensOut;
  }

  check(): void {
    if (this.isHalted()) throw new BudgetExceeded("killed");
    if (this.clock.now() - this.startedAt >= this.limits.maxMs) throw new BudgetExceeded("time");
    if (this.tokens >= this.limits.maxTokens) throw new BudgetExceeded("tokens");
    if (this.microUsd >= this.limits.maxMicroUsd) throw new BudgetExceeded("cost");
    if (this.steps >= this.limits.maxSteps) throw new BudgetExceeded("steps");
  }

  step(): void {
    this.check();
    this.steps++;
  }

  charge(inTok: number, outTok: number, micro: number): void {
    this.tokensIn += inTok;
    this.tokensOut += outTok;
    this.microUsd += micro;
  }

  remainingTokens(): number {
    return Math.max(0, this.limits.maxTokens - this.tokens);
  }
}

export interface CallRecord {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  latencyMs: number;
}

/** Wraps any provider: enforces the budget before the call and records usage and cost after. */
export class MeteredProvider implements LlmProvider {
  constructor(
    private inner: LlmProvider,
    private budget: SessionBudget,
    private price: Price,
    private onCall: (r: CallRecord) => void,
  ) {}
  get id() {
    return this.inner.id;
  }
  get model() {
    return this.inner.model;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.budget.check();
    const capped = { ...req, maxTokens: Math.min(req.maxTokens, this.budget.remainingTokens()) };
    const res = await this.inner.complete(capped);
    const micro = costMicroUsd(this.price, res.usage.inTok, res.usage.outTok);
    this.budget.charge(res.usage.inTok, res.usage.outTok, micro);
    this.onCall({
      provider: res.provider,
      model: res.model,
      tokensIn: res.usage.inTok,
      tokensOut: res.usage.outTok,
      costMicroUsd: micro,
      latencyMs: res.latencyMs,
    });
    return res;
  }
}
