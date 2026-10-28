import { describe, expect, it } from "vitest";
import { redactSecrets, scanText } from "../src/secrets";

// Fixtures are assembled at runtime so this file never contains a literal key.
const a = (n: number, c = "a") => c.repeat(n);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fixtures: Record<string, string> = {
  "anthropic-key": "sk-" + "ant-" + a(40),
  "openai-style-key": "sk-" + "proj-" + a(40),
  "github-token": "gh" + "p_" + a(36, "A"),
  "github-fine-grained": "github" + "_pat_" + a(30, "B"),
  "aws-access-key": "AK" + "IA" + a(16, "Q"),
  "slack-token": "xo" + "xb-" + a(20, "1"),
  "private-key-block": "-----BEGIN " + "RSA PRIVATE KEY-----",
  "x-bearer": a(20, "A") + a(40, "z"),
  "solana-secret-base58": B58.repeat(2).slice(0, 88),
  "solana-keypair-array": "[" + Array.from({ length: 64 }, (_, i) => String(i * 3)).join(",") + "]",
  "generic-assignment": "api_" + "key = " + "k9".repeat(12),
};

describe("scanText", () => {
  for (const [rule, text] of Object.entries(fixtures)) {
    it(`detects ${rule}`, () => {
      const rules = scanText(`prefix ${text} suffix`).map((f) => f.rule);
      expect(rules).toContain(rule);
    });
  }

  it("ignores ordinary text, hashes and env references", () => {
    const benign = [
      "Fixed the retry bug and added 12 tests.",
      "prompt hash: " + a(64, "e"), // sha256 shown publicly must not trip the scanner
      "const token = process.env.GITHUB_TOKEN_NAME_FOR_GATEWAY",
      "tokens_in = 1200, maxTokens = 50000",
      "apiKey: v.ANTHROPIC_API_KEY, token = config.someLongIdentifierName",
      "commit 3f2a9c1e5b7d4e8a9c217d4e5f6a8b90c1d2e3f4",
    ].join("\n");
    expect(scanText(benign)).toEqual([]);
  });
});

describe("redactSecrets", () => {
  it("masks every finding and leaves the rest", () => {
    const out = redactSecrets(
      `ok ${fixtures["github-token"]} and ${fixtures["aws-access-key"]} end`,
    );
    expect(out).toBe("ok [REDACTED] and [REDACTED] end");
  });

  it("merges overlapping matches into one mask", () => {
    const out = redactSecrets(fixtures["anthropic-key"]!);
    expect(out).toBe("[REDACTED]");
  });

  it("is idempotent", () => {
    const once = redactSecrets(fixtures["slack-token"]!);
    expect(redactSecrets(once)).toBe(once);
  });
});
