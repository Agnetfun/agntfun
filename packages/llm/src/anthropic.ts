import { redactSecrets } from "@devagent/core";
import {
  LlmError,
  type FetchLike,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
} from "./types";

export interface AnthropicOptions {
  apiKey: string;
  modelId: string;
  effort?: "low" | "medium" | "high";
  baseUrl?: string;
  /** OpenRouter takes its key as a Bearer token; Anthropic takes x-api-key. */
  bearer?: boolean;
  fetch?: FetchLike;
  /** Pauses before retrying a busy answer (429 rate limit, 503/529 overloaded). Free models hit these often. */
  retryDelaysMs?: number[];
}

/** Opus 5.5 via the Anthropic Messages API (directly, or through OpenRouter's Anthropic compatible endpoint). */
export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";
  readonly model: string;
  constructor(private o: AnthropicOptions) {
    this.model = o.modelId;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const doFetch = this.o.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const started = Date.now();
    const body = {
      model: this.o.modelId,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      // TODO(verify): the field name and placement for effort ("medium") on Opus 5.5.
      // It is deliberately NOT sent until confirmed against Anthropic's docs.
    };
    const send = () =>
      doFetch(`${this.o.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers: {
          ...(this.o.bearer ? { authorization: `Bearer ${this.o.apiKey}` } : { "x-api-key": this.o.apiKey }),
          // TODO(verify): anthropic-version value for current models.
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let res = await send();
    for (const wait of this.o.retryDelaysMs ?? [2000, 5000, 10000]) {
      if (![429, 503, 529].includes(res.status)) break;
      await new Promise((r) => setTimeout(r, wait));
      res = await send();
    }
    const raw = await res.text();
    if (!res.ok)
      throw new LlmError(
        `anthropic ${res.status}: ${redactSecrets(raw).slice(0, 300)}`,
        res.status,
      );
    const j = JSON.parse(raw) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (j.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return {
      text,
      usage: { inTok: j.usage?.input_tokens ?? 0, outTok: j.usage?.output_tokens ?? 0 },
      provider: this.id,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }
}
