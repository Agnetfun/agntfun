import type { ModelChoice } from "@devagent/core";

/** USD per million tokens. A token times this number equals micro-USD exactly. */
export interface Price {
  inPerM: number;
  outPerM: number;
  verified: boolean;
}

// opus: Claude Opus 5.5 at $4 / $20, confirmed in Anthropic's model table and OpenRouter's model list (Oct 2026).
// TODO(verify): the astra row comes from third party listings, not from OpenAI's pricing page.
export const PRICES: Record<ModelChoice, Price> = {
  opus: { inPerM: 4, outPerM: 20, verified: true },
  astra: { inPerM: 10, outPerM: 50, verified: false },
};

/** OpenRouter's ":free" models cost nothing, so an agent testing on one is not charged Claude prices. */
export const isFreeModel = (modelId: string) => modelId.endsWith(":free");
export const FREE: Price = { inPerM: 0, outPerM: 0, verified: true };
export const priceFor = (choice: ModelChoice, modelId: string): Price => (isFreeModel(modelId) ? FREE : PRICES[choice]);

export const costMicroUsd = (p: Price, inTok: number, outTok: number): number =>
  Math.ceil(inTok * p.inPerM + outTok * p.outPerM);

export const microUsdToCents = (micro: number): number => Math.ceil(micro / 10_000);
