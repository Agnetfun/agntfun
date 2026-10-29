import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GitCliHost, LocalGitRemote } from "../src/git-host";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

// A real patch made by git itself: a new file on top of an empty main.
function makePatch(root: string): string {
  const src = join(root, "src-repo");
  execFileSync("git", ["init", "-q", "-b", "main", src]);
  const g = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: src, encoding: "utf8" });
  g("commit", "-q", "--allow-empty", "-m", "base");
  g("checkout", "-q", "-b", "session/x");
  writeFileSync(join(src, "hello.js"), "module.exports = () => 'hi';\n");
  g("add", "-A");
  g("commit", "-q", "-m", "add hello");
  return g("diff", "--binary", "main..HEAD");
}

describe.skipIf(!hasGit)("git host against a real local remote", () => {
  const root = mkdtempSync(join(tmpdir(), "devagent-git-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("pushes a session branch, then merges to main", async () => {
    const patch = makePatch(root);
    const remote = new LocalGitRemote(join(root, "remotes"));
    const host = new GitCliHost(remote, join(root, "work"));
    const base = {
      kind: "git_push" as const,
      agentId: "A",
      sessionId: "01M619E15F6HF9NN32SHCCEENZ",
      repo: "org/demo",
      headSha: "c33fed4",
      patch,
      base: "",
      testReport: { passed: true, summary: "" },
      commitMessage: "",
    };
    const pushed = await host.push({ ...base, branch: "session/01M619E15F6HF9NN32SHCCEENZ", merge: false });
    expect(pushed.ref).toMatch(/^session\//);
    const merged = await host.push({ ...base, branch: "main", merge: true });
    expect(merged.ref).toMatch(/^main@/);
    const files = execFileSync("git", ["--git-dir", remote.url("org/demo"), "ls-tree", "--name-only", "main"], {
      encoding: "utf8",
    });
    expect(files).toContain("hello.js");
  });

  it("applies a patch that lost its final newline, and seeds a new remote with the starter files", async () => {
    // The workspace captures diffs through a trimmed stdout: this is the exact shape that failed on GitHub.
    const patch = makePatch(join(root, "trim")).trimEnd();
    const starter = [
      "diff --git a/package.json b/package.json",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/package.json",
      "@@ -0,0 +1 @@",
      '+{"scripts":{"test":"node --test"}}',
    ].join("\n");
    const remote = new LocalGitRemote(join(root, "remotes2"));
    const host = new GitCliHost(remote, join(root, "work2"));
    await host.push({
      kind: "git_push",
      agentId: "A",
      sessionId: "01M619E15F6HF9NN32SHCCEENZ",
      repo: "org/fresh",
      headSha: "c33fed4",
      branch: "main",
      merge: true,
      patch,
      base: starter,
      testReport: { passed: true, summary: "" },
      commitMessage: "",
    });
    const ls = (ref: string) =>
      execFileSync("git", ["--git-dir", remote.url("org/fresh"), "ls-tree", "--name-only", ref], { encoding: "utf8" });
    expect(ls("main")).toContain("hello.js");
    expect(ls("main~1")).toContain("package.json"); // first commit holds the starter files
  });
});
