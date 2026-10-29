import { describe, expect, it } from "vitest";
import { loadConfig } from "@devagent/core";
import { AnthropicProvider, PRICES, costMicroUsd, createProvider, openRouterCreditsLeft, priceFor } from "../src";

// Claude through OpenRouter: chosen by config, Bearer auth on OpenRouter's Anthropic compatible endpoint.
describe("OpenRouter", () => {
  it("is used for Claude when only an OpenRouter key is set; Anthropic's own key wins when both are", () => {
    const or = loadConfig({ DB_PATH: "x", LLM_MODE: "real", OPENROUTER_API_KEY: "sk-or-1" }).llm.anthropic;
    expect(or).toMatchObject({ via: "openrouter", modelId: "anthropic/claude-opus-5.5", baseUrl: "https://openrouter.ai/api" });
    const both = loadConfig({ DB_PATH: "x", LLM_MODE: "real", OPENROUTER_API_KEY: "sk-or-1", ANTHROPIC_API_KEY: "sk-a" });
    expect(both.llm.anthropic).toMatchObject({ via: "anthropic", modelId: "claude-opus-5-5" });
  });

  it("sends the key as a Bearer token to openrouter.ai/api/v1/messages", async () => {
    const cfg = loadConfig({ DB_PATH: "x", LLM_MODE: "real", OPENROUTER_API_KEY: "sk-or-1" }).llm;
    let url = "";
    let headers: Record<string, string> = {};
    const p = createProvider("opus", cfg, {
      fetch: async (u, init) => {
        url = u;
        headers = init.headers;
        return { ok: true, status: 200, text: async () => JSON.stringify({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1 } }) };
      },
    });
    expect((await p.complete({ system: "s", messages: [{ role: "user", content: "x" }], maxTokens: 10 })).text).toBe("hi");
    expect(url).toBe("https://openrouter.ai/api/v1/messages");
    expect(headers.authorization).toBe("Bearer sk-or-1");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("reports credit left from total credits minus usage", async () => {
    const f = (async () => new Response(JSON.stringify({ data: { total_credits: 25, total_usage: 7.5 } }))) as typeof fetch;
    expect(await openRouterCreditsLeft("mk", f)).toBe(17.5);
    const bad = (async () => new Response("no", { status: 403 })) as typeof fetch;
    await expect(openRouterCreditsLeft("mk", bad)).rejects.toThrow("403");
  });

  it("charges nothing for a :free model, and Claude prices otherwise", () => {
    expect(costMicroUsd(priceFor("opus", "poolside/laguna-s-2.1:free"), 1_000_000, 1_000_000)).toBe(0);
    expect(priceFor("opus", "anthropic/claude-opus-5.5")).toBe(PRICES.opus);
  });
});

describe("busy answers", () => {
  it("retries a rate limited call before giving up", async () => {
    const cfg = loadConfig({ DB_PATH: "x", LLM_MODE: "real", OPENROUTER_API_KEY: "sk-or-1" }).llm;
    let n = 0;
    const answers = [429, 529, 200];
    const p = new AnthropicProvider({
      apiKey: "k",
      modelId: cfg.anthropic.modelId,
      bearer: true,
      retryDelaysMs: [0, 0, 0],
      fetch: async () => {
        const status = answers[n++]!;
        return { ok: status === 200, status, text: async () => JSON.stringify({ content: [{ type: "text", text: "done" }], usage: {} }) };
      },
    });
    expect((await p.complete({ system: "s", messages: [{ role: "user", content: "x" }], maxTokens: 5 })).text).toBe("done");
    expect(n).toBe(3);
    n = 0;
    answers.splice(0, 3, 429, 429, 429);
    answers.push(429);
    await expect(p.complete({ system: "s", messages: [{ role: "user", content: "x" }], maxTokens: 5 })).rejects.toThrow("429");
    expect(n).toBe(4); // first try plus three retries
  });
});
