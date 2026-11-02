import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalWorkspace } from "../src";

// A diff whose last line is a blank context line (" ") must reach the gateway intact, or git apply calls it corrupt.
describe("session patch tail", () => {
  it("keeps a final single-space context line, and the patch applies cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tail-"));
    const ws = await LocalWorkspace.open(dir);
    await ws.writeFile("notes.txt", "one\ntwo\nthree\nfour\n\n");
    await ws.commitAll("base");
    await ws.startBranch("session/t");
    await ws.writeFile("notes.txt", "one\nTWO\nthree\nfour\n\n"); // three lines above the blank line
    await ws.commitAll("edit");
    const patch = await ws.patchSinceMain();
    expect(patch.endsWith("\n \n")).toBe(true); // the blank source line survives as " "
    // Apply it to a fresh copy of main the way the gateway does.
    const other = mkdtempSync(join(tmpdir(), "apply-"));
    execFileSync("git", ["init", "-q", other]);
    writeFileSync(join(other, "notes.txt"), "one\ntwo\nthree\nfour\n\n");
    writeFileSync(join(other, "p.patch"), patch);
    expect(() => execFileSync("git", ["apply", "--check", "p.patch"], { cwd: other })).not.toThrow();
  });
});
