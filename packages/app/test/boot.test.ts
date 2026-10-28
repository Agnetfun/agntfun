import { describe, expect, it } from "vitest";
import { ConfigError } from "@devagent/core";
import { boot } from "../src/boot";

describe("boot", () => {
  it("migrates the database, records a boot event and logs ready", () => {
    const lines: string[] = [];
    const app = boot({ DB_PATH: ":memory:" }, { write: (s) => void lines.push(s) });
    const ev = app.db.prepare("SELECT type FROM events").all();
    expect(ev.map((r) => r.type)).toEqual(["orchestrator.boot"]);
    expect(lines.join("")).toContain("orchestrator ready");
    app.close();
  });

  it("fails fast when config is missing, before touching the database", () => {
    expect(() => boot({})).toThrow(ConfigError);
  });
});
