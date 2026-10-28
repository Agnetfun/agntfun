import { z } from "zod";

const int = (def: number, min = 1) => z.coerce.number().int().min(min).default(def);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    DB_PATH: z.string().min(1),
    // mainnet-beta moves real money, so it also needs REAL_MONEY=1 (see superRefine).
    SOLANA_CLUSTER: z.enum(["devnet", "localnet", "mainnet-beta"]).default("devnet"),
    REAL_MONEY: z.enum(["0", "1"]).default("0"),
    HEARTBEAT_SECONDS: int(30),

    // LLM. Keep LLM_MODE=mock until you add keys; then switch to real.
    LLM_MODE: z.enum(["mock", "real"]).default("mock"),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_MODEL_ID: z.string().min(1).default("claude-opus-5-5"),
    ANTHROPIC_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
    OPENAI_API_KEY: z.string().min(1).optional(),
    // TODO(verify): base URL and the Astra model id against OpenAI's own docs.
    OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
    ASTRA_MODEL_ID: z.string().min(1).default("gpt-6-astra"),

    // Per session caps.
    SESSION_MAX_TOKENS: int(60000, 1000),
    SESSION_MAX_CENTS: int(200),
    SESSION_MAX_SECONDS: int(600, 10),
    SESSION_MAX_STEPS: int(40),
  })
  .superRefine((v, ctx) => {
    if (v.SOLANA_CLUSTER === "mainnet-beta" && v.REAL_MONEY !== "1") {
      ctx.addIssue({
        code: "custom",
        path: ["SOLANA_CLUSTER"],
        message: "mainnet-beta needs REAL_MONEY=1 (launches and agent wallets use real SOL)",
      });
    }
    if (v.LLM_MODE === "real" && !v.ANTHROPIC_API_KEY && !v.OPENAI_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["LLM_MODE"],
        message: "real mode needs ANTHROPIC_API_KEY or OPENAI_API_KEY",
      });
    }
  });

export type Effort = "low" | "medium" | "high";

export interface LlmConfig {
  mode: "mock" | "real";
  anthropic: { apiKey?: string; modelId: string; effort: Effort };
  openai: { apiKey?: string; baseUrl: string; modelId: string };
}

export interface SessionLimits {
  maxTokens: number;
  maxCents: number;
  maxSeconds: number;
  maxSteps: number;
}

export interface Config {
  nodeEnv: "development" | "test" | "production";
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  dbPath: string;
  solanaCluster: "devnet" | "localnet" | "mainnet-beta";
  heartbeatSeconds: number;
  llm: LlmConfig;
  session: SessionLimits;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Empty values in .env (KEY=) count as not set.
  const clean = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const r = schema.safeParse(clean);
  if (!r.success) {
    // Names and reasons only. Values are never included, so a mistyped secret cannot leak.
    const lines = r.error.issues.map((i) => {
      const key = i.path.join(".") || "(root)";
      if (i.code === "custom") return `  ${key}: ${i.message}`; // our own text, no values
      const missing = i.code === "invalid_type" && clean[key] === undefined;
      return `  ${key}: ${missing ? "missing" : "invalid"}`;
    });
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const v = r.data;
  return {
    nodeEnv: v.NODE_ENV,
    logLevel: v.LOG_LEVEL,
    dbPath: v.DB_PATH,
    solanaCluster: v.SOLANA_CLUSTER,
    heartbeatSeconds: v.HEARTBEAT_SECONDS,
    llm: {
      mode: v.LLM_MODE,
      anthropic: {
        apiKey: v.ANTHROPIC_API_KEY,
        modelId: v.ANTHROPIC_MODEL_ID,
        effort: v.ANTHROPIC_EFFORT,
      },
      openai: { apiKey: v.OPENAI_API_KEY, baseUrl: v.OPENAI_BASE_URL, modelId: v.ASTRA_MODEL_ID },
    },
    session: {
      maxTokens: v.SESSION_MAX_TOKENS,
      maxCents: v.SESSION_MAX_CENTS,
      maxSeconds: v.SESSION_MAX_SECONDS,
      maxSteps: v.SESSION_MAX_STEPS,
    },
  };
}
