import { describe, expect, it } from "vitest";
import { planBuyback, type BuybackPlanInput } from "../src/buyback";

const SOL = 1_000_000_000;
const base: BuybackPlanInput = {
  buybackLamports: 2 * SOL,
  infraLamports: 5 * SOL,
  infraTargetLamports: 1 * SOL,
  keepLamports: 0.01 * SOL,
  minLamports: 0.05 * SOL,
  tokenMint: "Mint1111111111111111111111111111111111111111",
};

describe("buyback plan: infra first, then buy and burn", () => {
  it("does nothing below the minimum after keeping fee money", () => {
    expect(planBuyback({ ...base, buybackLamports: 0.05 * SOL })).toEqual({ action: "none", lamports: 0 });
  });

  it("fills the infra wallet up to its target before any buyback", () => {
    expect(planBuyback({ ...base, infraLamports: 0.3 * SOL })).toEqual({ action: "to_infra", lamports: 0.7 * SOL });
  });

  it("sends everything spendable to infra when that still does not reach the target", () => {
    expect(planBuyback({ ...base, buybackLamports: 0.5 * SOL, infraLamports: 0 })).toEqual({
      action: "to_infra",
      lamports: 0.49 * SOL,
    });
  });

  it("buys with everything spendable once infra is covered", () => {
    expect(planBuyback(base)).toEqual({ action: "buy", lamports: 1.99 * SOL });
  });

  it("saves up when the platform token does not exist yet", () => {
    expect(planBuyback({ ...base, tokenMint: undefined })).toEqual({ action: "none", lamports: 0 });
  });

  it("never spends the kept fee money or goes negative", () => {
    expect(planBuyback({ ...base, buybackLamports: 0 }).lamports).toBe(0);
    expect(planBuyback({ ...base, buybackLamports: 0.005 * SOL }).action).toBe("none");
  });
});
