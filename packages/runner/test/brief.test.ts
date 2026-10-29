import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { createAgent, migrate, openDb } from "@devagent/db";
import { LocalWorkspace } from "@devagent/sandbox";
import { BRIEF_IN_PROMPT, briefForPrompt, syncBriefFiles } from "../src/brief";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("long brief and creator files in the repo", () => {
  it("writes BRIEF.md and docs, commits text, keeps screenshots out of git, and keeps the prompt short", async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 29));
    const db = openDb(":memory:");
    migrate(db, clock);
    const brief = "Build a markdown notes app. " + "Detail. ".repeat(3000);
    const agent = createAgent(db, clock, { name: "notes", model: "opus", lockedPrompt: brief }).id;
    const add = (name: string, mime: string, bytes: Buffer) =>
      db.prepare("INSERT INTO attachments (id, agent_id, name, mime, bytes, created_at) VALUES (?,?,?,?,?,?)").run(name, agent, name, mime, bytes, 1);
    add("spec.md", "text/markdown", Buffer.from("# Spec\nNotes have tags."));
    add("home.png", "image/png", PNG);

    const dir = mkdtempSync(join(tmpdir(), "brief-"));
    const ws = await LocalWorkspace.open(dir);
    await ws.startBranch("session/x");
    const f = await syncBriefFiles(db, agent, brief, ws);

    expect(f.docs).toEqual(["docs/spec.md", "docs/home.png"]);
    expect(await ws.readFile("BRIEF.md")).toContain("Detail. Detail.");
    expect(await ws.readFile("docs/spec.md")).toContain("Notes have tags.");
    await ws.commitAll("brief");
    const tracked = execFileSync("git", ["--git-dir", join(dir, "gitdir"), "ls-files"], { cwd: join(dir, "work"), encoding: "utf8" });
    expect(tracked).toContain("BRIEF.md");
    expect(tracked).toContain("docs/spec.md");
    expect(tracked).not.toContain("home.png"); // shown on the agent page, never pushed

    const p = briefForPrompt(brief, f);
    expect(p.length).toBeLessThan(BRIEF_IN_PROMPT + 400);
    expect(p).toContain("BRIEF.md");
    expect(p).toContain("docs/home.png");
    // A second sync changes nothing.
    await syncBriefFiles(db, agent, brief, ws);
    expect(await ws.hasChanges()).toBe(false);
  });
});
