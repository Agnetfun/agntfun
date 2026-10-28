import { redactSecrets } from "@devagent/core";
import {
  LlmError,
  type FetchLike,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
} from "./types";

export interface OpenAiOptions {
  apiKey: string;
  modelId: string;
  baseUrl: string;
  fetch?: FetchLike;
}

/**
 * GPT-6 Astra via an OpenAI style chat endpoint.
 * TODO(verify): Astra may require the Responses API instead of /chat/completions, and the
 * token limit field name. Contract tested with a fake fetch only; no live call has been made.
 */
export class OpenAiProvider implements LlmProvider {
  readonly id = "openai";
  readonly model: string;
  constructor(private o: OpenAiOptions) {
    this.model = o.modelId;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const doFetch = this.o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const started = Date.now();
    const res = await doFetch(`${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.o.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.o.modelId,
        max_completion_tokens: req.maxTokens,
        messages: [{ role: "system", content: req.system }, ...req.messages],
      }),
    });
    const raw = await res.text();
    if (!res.ok)
      throw new LlmError(`openai ${res.status}: ${redactSecrets(raw).slice(0, 300)}`, res.status);
    const j = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: j.choices?.[0]?.message?.content ?? "",
      usage: { inTok: j.usage?.prompt_tokens ?? 0, outTok: j.usage?.completion_tokens ?? 0 },
      provider: this.id,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }
}
