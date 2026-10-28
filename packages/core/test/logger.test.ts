import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger";

function capture() {
  const lines: string[] = [];
  const log = createLogger({
    service: "test",
    level: "debug",
    destination: { write: (s: string) => void lines.push(s) },
  });
  return { log, out: () => lines.join("") };
}

const KEY = "sk-" + "ant-" + "a".repeat(40);

describe("logger redaction", () => {
  it("masks secret-looking values in messages", () => {
    const { log, out } = capture();
    log.info(`calling with ${KEY}`);
    expect(out()).not.toContain(KEY);
    expect(out()).toContain("[REDACTED]");
  });

  it("masks values under sensitive keys, at any depth", () => {
    const { log, out } = capture();
    log.info({ cfg: { accessToken: "short", nested: { apiKey: "x" } } }, "boot");
    expect(out()).not.toContain("short");
    expect(out()).toMatch(/accessToken":"\[REDACTED\]"/);
    expect(out()).toMatch(/apiKey":"\[REDACTED\]"/);
  });

  it("masks secrets inside error messages and stacks", () => {
    const { log, out } = capture();
    log.error({ err: new Error(`failed with ${KEY}`) }, "oops");
    expect(out()).not.toContain(KEY);
  });

  it("keeps harmless fields such as token counts", () => {
    const { log, out } = capture();
    log.info({ tokens_in: 1200, maxTokens: 5000 }, "usage");
    expect(out()).toContain('"tokens_in":1200');
    expect(out()).toContain('"maxTokens":5000');
  });
});
