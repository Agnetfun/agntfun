import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("parses a valid env and applies defaults", () => {
    const c = loadConfig({ DB_PATH: "./x.db" });
    expect(c).toMatchObject({
      nodeEnv: "development",
      logLevel: "info",
      dbPath: "./x.db",
      solanaCluster: "devnet",
      heartbeatSeconds: 30,
      llm: { mode: "mock", anthropic: { modelId: "claude-opus-5-5", effort: "medium" } },
    });
  });

  it("treats empty values as unset and requires a key in real mode", () => {
    expect(
      loadConfig({ DB_PATH: "x", ANTHROPIC_API_KEY: "" }).llm.anthropic.apiKey,
    ).toBeUndefined();
    expect(() => loadConfig({ DB_PATH: "x", LLM_MODE: "real" })).toThrow(
      /needs ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY/,
    );
    expect(loadConfig({ DB_PATH: "x", LLM_MODE: "real", OPENAI_API_KEY: "k" }).llm.mode).toBe(
      "real",
    );
  });

  it("allows mainnet only with REAL_MONEY=1", () => {
    expect(() => loadConfig({ DB_PATH: "x", SOLANA_CLUSTER: "mainnet-beta" })).toThrow(/REAL_MONEY=1/);
    expect(loadConfig({ DB_PATH: "x", SOLANA_CLUSTER: "mainnet-beta", REAL_MONEY: "1" }).solanaCluster).toBe(
      "mainnet-beta",
    );
  });

  it("fails fast on a missing required value and names it", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DB_PATH: missing/);
  });

  it("reports every problem at once", () => {
    try {
      loadConfig({ LOG_LEVEL: "loud", HEARTBEAT_SECONDS: "0" });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/DB_PATH/);
      expect(msg).toMatch(/LOG_LEVEL/);
      expect(msg).toMatch(/HEARTBEAT_SECONDS/);
    }
  });

  it("refuses mainnet before Phase 6", () => {
    expect(() => loadConfig({ DB_PATH: "x", SOLANA_CLUSTER: "mainnet-beta" })).toThrow(
      /SOLANA_CLUSTER/,
    );
  });

  it("never echoes values in the error", () => {
    const secretish = "sk-" + "a".repeat(40);
    try {
      loadConfig({ DB_PATH: "x", LOG_LEVEL: secretish });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(secretish);
    }
  });
});
