import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanText } from "@devagent/core";
import { LocalWorkspace, WorkspaceError, dockerRunArgs } from "../src";

const ws = () => LocalWorkspace.open(mkdtempSync(join(tmpdir(), "sb-")));

describe("path safety", () => {
  it("blocks traversal, absolute paths and .git", async () => {
    const w = await ws();
    for (const p of [
      "../x",
      "/etc/passwd",
      ".git/config",
      "a/../../x",
      "sub/.GIT/hooks/pre-commit",
    ]) {
      await expect(w.writeFile(p, "x")).rejects.toThrow(WorkspaceError);
    }
    await expect(w.readFile("../../etc/passwd")).rejects.toThrow(WorkspaceError);
  });

  it("blocks reads and writes through a symlink that points outside", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    const w = await ws();
    // Agent code can create symlinks inside the workspace; simulate that.
    await w.writeFile("seed.txt", "x");
    const work = join((w as unknown as { work: string }).work);
    symlinkSync(outside, join(work, "link"));
    symlinkSync(join(outside, "does-not-exist"), join(work, "dangling"));
    await expect(w.writeFile("link/new.txt", "pwn")).rejects.toThrow(WorkspaceError);
    await expect(w.readFile("link")).rejects.toThrow(WorkspaceError);
    await expect(w.writeFile("dangling", "pwn")).rejects.toThrow(WorkspaceError);
  });

  it("keeps the git directory out of reach", async () => {
    const w = await ws();
    expect(await w.listDir(".")).not.toContain("gitdir/");
    await expect(w.readFile("../gitdir/config")).rejects.toThrow(WorkspaceError);
  });

  it("limits file size", async () => {
    const w = await ws();
    await expect(w.writeFile("big.txt", "x".repeat(300_000))).rejects.toThrow(/too large/);
  });
});

describe("test runner environment", () => {
  it("does not pass host secrets to agent code", async () => {
    process.env.FAKE_HOST_SECRET = "host-secret-value-1234567890";
    const w = await ws();
    await w.writeFile(
      "test/env.test.js",
      `const t=require("node:test");const a=require("node:assert");
t("env",()=>a.strictEqual(process.env.FAKE_HOST_SECRET,undefined));`,
    );
    const r = await w.runTests(20_000);
    delete process.env.FAKE_HOST_SECRET;
    expect(r.ok).toBe(true);
  });
});

describe("dockerRunArgs", () => {
  const args = dockerRunArgs({
    name: "n",
    image: "node:22-bookworm-slim",
    agentId: "A1",
    workDir: "/data/a1/work",
    uid: 0,
    gid: 0,
  });
  const has = (...p: string[]) => p.every((x) => args.includes(x));

  it("is locked down", () => {
    expect(
      has(
        "--read-only",
        "--cap-drop",
        "ALL",
        "--network",
        "none",
        "--security-opt",
        "no-new-privileges",
      ),
    ).toBe(true);
    expect(args[args.indexOf("--user") + 1]).not.toMatch(/^0/); // never root, even when the host user is root
  });

  it("never grants privileges or host access", () => {
    const joined = args.join(" ");
    expect(joined).not.toMatch(
      /--privileged|docker\.sock|--pid\b|--ipc\b|--network host|--env-file|--cap-add/,
    );
    const mounts = args.filter((_, i) => args[i - 1] === "-v");
    expect(mounts).toEqual(["/data/a1/work:/workspace:rw"]);
  });

  it("passes an explicit environment with no secrets", () => {
    const env = args.filter((_, i) => args[i - 1] === "-e");
    expect(env.sort()).toEqual(["CI=1", "HOME=/tmp", "NODE_ENV=test"]);
    expect(scanText(env.join("\n"))).toEqual([]);
  });

  it("applies resource limits", () => {
    expect(has("--pids-limit", "--memory", "--cpus")).toBe(true);
  });
});
