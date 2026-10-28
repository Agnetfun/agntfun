import pino from "pino";
import { redactSecrets } from "./secrets";

const SENSITIVE_KEY =
  /(api[_-]?key|token|secret|password|passwd|authorization|private[_-]?key|mnemonic|seed[_-]?phrase)$/i;
const MASK = "[REDACTED]";

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[TRUNCATED]";
  if (value instanceof Error) {
    return {
      type: value.name,
      message: redactSecrets(value.message),
      stack: value.stack ? redactSecrets(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? MASK : scrub(v, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  service: string;
  level: string;
  /** Defaults to stdout. Tests pass a capture stream. */
  destination?: { write(chunk: string): void };
}

export type Logger = pino.Logger;

export function createLogger(opts: LoggerOptions): Logger {
  const options: pino.LoggerOptions = {
    level: opts.level,
    base: { service: opts.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((a) => scrub(a)) as Parameters<typeof method>);
      },
    },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}
