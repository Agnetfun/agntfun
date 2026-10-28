import type { ModelChoice } from "@devagent/core";

/** USD per million tokens. A token times this number equals micro-USD exactly. */
export interface Price {
  inPerM: number;
  outPerM: number;
  verified: boolean;
}

// TODO(verify): both rows come from third party listings (anotherwrapper.com, requesty.ai, Oct 2026),
// not from Anthropic or OpenAI. Confirm on each provider's pricing page before relying on cost caps.
export const PRICES: Record<ModelChoice, Price> = {
  opus: { inPerM: 4, outPerM: 20, verified: false },
  astra: { inPerM: 10, outPerM: 50, verified: false },
};

export const costMicroUsd = (p: Price, inTok: number, outTok: number): number =>
  Math.ceil(inTok * p.inPerM + outTok * p.outPerM);

export const microUsdToCents = (micro: number): number => Math.ceil(micro / 10_000);
