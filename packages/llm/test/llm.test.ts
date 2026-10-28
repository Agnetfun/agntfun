import { describe, expect, it } from "vitest";
import { FakeClock, loadConfig } from "@devagent/core";
import {
  AnthropicProvider,
  BudgetExceeded,
  LlmError,
  MeteredProvider,
  MockProvider,
  OpenAiProvider,
  PRICES,
  SessionBudget,
  createProvider,
  developerScript,
  type FetchLike,
} from "../src";

const req = {
  system: "sys",
  messages: [{ role: "user" as const, content: "TASK: add sum" }],
  maxTokens: 500,
};
describe("providers", () => {
  it("mock is deterministic", async () => {
    const a = await new MockProvider("m", developerScript).complete(req);
    const b = await new MockProvider("m", developerScript).complete(req);
    expect(a.text).toBe(b.text);
    expect(a.usage).toEqual(b.usage);
  });

  it("anthropic sends the messages request and parses usage", async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
    const f: FetchLike = async (url, init) => {
      seen = { url, headers: init.headers, body: init.body };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 7, output_tokens: 3 },
          }),
      };
    };
    const r = await new AnthropicProvider({
      apiKey: "k",
      modelId: "claude-opus-5-5",
      fetch: f,
    }).complete(req);
    expect(r).toMatchObject({ text: "hi", usage: { inTok: 7, outTok: 3 } });
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen!.headers["x-api-key"]).toBe("k");
    expect(JSON.parse(seen!.body)).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 500,
      system: "sys",
    });
  });

  it("openai style sends bearer auth and parses usage", async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
    const f: FetchLike = async (url, init) => {
      seen = { url, headers: init.headers, body: init.body };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: "yo" } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
      };
    };
    const r = await new OpenAiProvider({
      apiKey: "k",
      modelId: "gpt-6-astra",
      baseUrl: "https://x/v1/",
      fetch: f,
    }).complete(req);
    expect(r).toMatchObject({ text: "yo", usage: { inTok: 5, outTok: 2 } });
    expect(seen!.url).toBe("https://x/v1/chat/completions");
    expect(seen!.headers.authorization).toBe("Bearer k");
    expect(JSON.parse(seen!.body).messages[0]).toEqual({ role: "system", content: "sys" });
  });

  it("errors never leak the key", async () => {
    const key = "sk-" + "ant-" + "a".repeat(40);
    const f: FetchLike = async () => ({
      ok: false,
      status: 401,
      text: async () => `bad key ${key}`,
    });
    const p = new AnthropicProvider({ apiKey: key, modelId: "m", fetch: f });
    await expect(p.complete(req)).rejects.toThrow(LlmError);
    await expect(p.complete(req)).rejects.not.toThrow(key);
  });

  it("factory maps the developer's choice and checks keys", () => {
    const cfg = loadConfig({ DB_PATH: "x", LLM_MODE: "real", OPENAI_API_KEY: "k" }).llm;
    expect(createProvider("astra", cfg).id).toBe("openai");
    expect(() => createProvider("opus", cfg)).toThrow(/ANTHROPIC_API_KEY/);
    const mock = loadConfig({ DB_PATH: "x" }).llm;
    expect(createProvider("opus", mock).model).toBe("mock-opus");
    expect(createProvider("astra", mock).model).toBe("mock-astra");
  });
});

describe("budget and metering", () => {
  const limits = { maxTokens: 1000, maxMicroUsd: 5000, maxMs: 10_000, maxSteps: 3 };
  const mk = (clock = new FakeClock(0), halted = () => false) =>
    new SessionBudget(limits, clock, halted);

  it("records cost in micro USD from the price table", async () => {
    const b = mk();
    const calls: number[] = [];
    const m = new MeteredProvider(
      new MockProvider("m", () => "x".repeat(40)),
      b,
      PRICES.astra,
      (r) => calls.push(r.costMicroUsd),
    );
    const res = await m.complete(req);
    expect(calls[0]).toBe(res.usage.inTok * 10 + res.usage.outTok * 50);
    expect(b.microUsd).toBe(calls[0]);
  });

  it("caps max_tokens to what is left and stops when empty", async () => {
    const b = new SessionBudget({ ...limits, maxMicroUsd: 1e9 }, new FakeClock(0));
    const seen: number[] = [];
    const inner = new MockProvider("m", (r) => (seen.push(r.maxTokens), "x".repeat(4000)));
    const m = new MeteredProvider(inner, b, PRICES.opus, () => {});
    await m.complete({ ...req, maxTokens: 4000 });
    expect(seen[0]).toBe(1000);
    await expect(m.complete(req)).rejects.toMatchObject({ reason: "tokens" });
  });

  it("each cap raises its own reason", () => {
    const clock = new FakeClock(0);
    const b = mk(clock);
    clock.advance(10_000);
    expect(() => b.check()).toThrow(BudgetExceeded);
    expect(() => mk(clock, () => true).check()).toThrowError(/killed/);
    const s = mk();
    s.step();
    s.step();
    s.step();
    expect(() => s.step()).toThrowError(/steps/);
    const c = mk();
    c.charge(1, 1, 5000);
    expect(() => c.check()).toThrowError(/cost/);
  });
});
