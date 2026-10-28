import type { LlmConfig, ModelChoice } from "@devagent/core";
import { AnthropicProvider } from "./anthropic";
import { developerScript, MockProvider, type MockScript } from "./mock";
import { OpenAiProvider } from "./openai";
import type { FetchLike, LlmProvider } from "./types";

export interface ProviderOverrides {
  mockScript?: MockScript;
  fetch?: FetchLike;
}

/** One place that maps the developer's choice (opus or astra) to a concrete provider. */
export function createProvider(
  choice: ModelChoice,
  cfg: LlmConfig,
  o: ProviderOverrides = {},
): LlmProvider {
  if (cfg.mode === "mock") {
    return new MockProvider(`mock-${choice}`, o.mockScript ?? developerScript);
  }
  if (choice === "opus") {
    if (!cfg.anthropic.apiKey)
      throw new Error("ANTHROPIC_API_KEY is not set (needed for the opus model)");
    return new AnthropicProvider({
      apiKey: cfg.anthropic.apiKey,
      modelId: cfg.anthropic.modelId,
      effort: cfg.anthropic.effort,
      fetch: o.fetch,
    });
  }
  if (!cfg.openai.apiKey) throw new Error("OPENAI_API_KEY is not set (needed for the astra model)");
  return new OpenAiProvider({
    apiKey: cfg.openai.apiKey,
    modelId: cfg.openai.modelId,
    baseUrl: cfg.openai.baseUrl,
    fetch: o.fetch,
  });
}
