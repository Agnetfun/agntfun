import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TEST_TOOL, checkToolCall } from "../src/pro-guard";

// Pro coding mode hands real file tools to the model. This guard is the only thing keeping them inside the repo.
const base = mkdtempSync(join(tmpdir(), "devagent-guard-"));
const root = join(base, "work");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src", "a.js"), "x");
writeFileSync(join(base, "secret.txt"), "outside");
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ok = (tool: string, input: unknown) => expect(checkToolCall(root, tool, input)).toEqual({ ok: true });
const no = (tool: string, input: unknown) => expect(checkToolCall(root, tool, input).ok).toBe(false);

describe("pro coding guard", () => {
  it("allows the file tools inside the repo, relative or absolute", () => {
    ok("Read", { file_path: "src/a.js" });
    ok("Read", { file_path: join(root, "src", "a.js") });
    ok("Write", { file_path: "src/new/b.js", content: "y" });
    ok("Edit", { file_path: "src/a.js", old_string: "x", new_string: "z" });
    ok("Glob", { pattern: "**/*.js" });
    ok("Grep", { pattern: "todo", path: "src" });
    ok(TEST_TOOL, {});
  });

  it("blocks paths that leave the repo", () => {
    no("Read", { file_path: "../secret.txt" });
    no("Read", { file_path: join(base, "secret.txt") });
    no("Read", { file_path: "src/../../secret.txt" });
    no("Write", { file_path: "/etc/passwd", content: "" });
    no("Read", { file_path: String.raw`C:\Windows\win.ini` });
    no("Read", { file_path: "C:Windows" }); // drive relative: its meaning depends on the process folder
    no("Glob", { pattern: "**/*", path: ".." });
    no("Glob", { pattern: "../**/*" });
    no("Glob", { pattern: "/home/**" });
    no("Grep", { pattern: "KEY", path: base });
    no("Grep", { pattern: "KEY", glob: "../*" });
  });

  it("blocks secrets and git internals even inside the repo", () => {
    no("Read", { file_path: ".env" });
    no("Read", { file_path: "config/.env.local" });
    no("Write", { file_path: "keys/server.pem", content: "" });
    no("Read", { file_path: ".git/config" });
    no("Read", { file_path: "id_rsa" });
  });

  it("blocks every tool that is not on the list: no shell, no web", () => {
    for (const t of ["Bash", "WebFetch", "WebSearch", "Task", "NotebookEdit", "mcp__other__x", "KillShell"]) no(t, {});
  });

  it("rejects malformed input", () => {
    no("Read", {});
    no("Read", { file_path: 42 });
    no("Read", null);
    no("Read", { file_path: "src/a.js\u0000.txt" });
  });

  it("does not follow a symlink out of the repo", () => {
    try {
      symlinkSync(base, join(root, "escape"), "junction");
    } catch {
      return; // creating links needs extra rights on some systems
    }
    no("Read", { file_path: "escape/secret.txt" });
    no("Write", { file_path: "escape/new.txt", content: "" });
  });
});
