export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: ChatMsg[];
  maxTokens: number;
}

export interface LlmResult {
  text: string;
  usage: { inTok: number; outTok: number };
  provider: string;
  model: string;
  latencyMs: number;
}

/** Provider agnostic. No native tool calling: agents answer with JSON actions (see runner). */
export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResult>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;
