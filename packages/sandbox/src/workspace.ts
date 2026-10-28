import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** Everything the agent can touch. */
export interface Workspace {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  runTests(timeoutMs: number): Promise<{ ok: boolean; output: string }>;
  startBranch(name: string): Promise<void>;
  hasChanges(): Promise<boolean>;
  /** Commits everything. Returns the short sha, or null when there was nothing to commit. */
  commitAll(message: string): Promise<string | null>;
  headSha(): Promise<string>;
  /** Unified diff of the current branch against main. This is what the gateway scans and pushes. */
  patchSinceMain(): Promise<string>;
  /** Fast forwards main to the current branch. Called after the gateway merged remotely. */
  mergeToMain(): Promise<void>;
  /** Stops anything still running (containers). The files and git history stay. */
  destroy(): Promise<void>;
}

export const MAX_FILE = 200_000;

/** Resolves a model supplied path inside root, or throws. Handles `..`, absolute paths, .git and symlinks. */
export function safePath(root: string, p: string): string {
  if (!p || p.includes("\0") || isAbsolute(p)) throw new WorkspaceError("path must be relative");
  const rootReal = realpathSync(root);
  const full = resolve(rootReal, p);
  const rel = relative(rootReal, full);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new WorkspaceError("path escapes the workspace");
  if (rel.split(sep).some((s) => s.toLowerCase() === ".git"))
    throw new WorkspaceError("path is not allowed");
  // The nearest existing ancestor must really live inside root. This also stops writes
  // that would go through a symlinked directory (or a dangling symlink) to somewhere else.
  let probe = full;
  for (;;) {
    try {
      lstatSync(probe);
      break;
    } catch {
      probe = dirname(probe);
    }
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    throw new WorkspaceError("path escapes the workspace");
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep))
    throw new WorkspaceError("path escapes the workspace");
  return full;
}

/**
 * Files live in `<dir>/work`; the git directory lives in `<dir>/gitdir` and is never exposed to
 * agent code, so code run in the workspace cannot plant git config or hooks that the host would execute.
 */
export abstract class GitWorkspace implements Workspace {
  protected constructor(
    protected work: string,
    protected gitDir: string,
  ) {}

  protected static async prepare(
    dir: string,
  ): Promise<{ work: string; gitDir: string; fresh: boolean }> {
    mkdirSync(dir, { recursive: true });
    const base = realpathSync(dir);
    const work = resolve(base, "work");
    const gitDir = resolve(base, "gitdir");
    const fresh = !existsSync(gitDir);
    mkdirSync(work, { recursive: true });
    return { work, gitDir, fresh };
  }

  protected async init(): Promise<void> {
    await this.git("init", "-q", "-b", "main");
    // Own package.json so a parent project's "type" setting cannot change how agent code runs.
    writeFileSync(resolve(this.work, "package.json"), '{ "private": true, "type": "commonjs" }\n');
    await this.git("add", "-A");
    await this.git("commit", "-q", "-m", "init");
  }

  protected gitEnv(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dirname(this.work),
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.work,
      GIT_AUTHOR_NAME: "devagent",
      GIT_AUTHOR_EMAIL: "agent@devagent.local",
      GIT_COMMITTER_NAME: "devagent",
      GIT_COMMITTER_EMAIL: "agent@devagent.local",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  protected async git(...args: string[]): Promise<string> {
    const { stdout } = await run("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: this.work,
      env: this.gitEnv(),
      maxBuffer: 8_000_000,
    });
    return stdout.trim();
  }

  async readFile(path: string): Promise<string> {
    return readFileSync(safePath(this.work, path)).subarray(0, MAX_FILE).toString("utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > MAX_FILE) throw new WorkspaceError("file too large");
    const full = safePath(this.work, path);
    mkdirSync(dirname(full), { recursive: true });
    safePath(this.work, path); // re-check after creating parents
    writeFileSync(full, content);
  }

  async listDir(path: string): Promise<string[]> {
    return readdirSync(safePath(this.work, path), { withFileTypes: true })
      .filter((d) => d.name !== ".git")
      .slice(0, 200)
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort();
  }

  abstract runTests(timeoutMs: number): Promise<{ ok: boolean; output: string }>;

  async startBranch(name: string): Promise<void> {
    await this.git("checkout", "-q", "main");
    await this.git("checkout", "-q", "-b", name);
  }

  async hasChanges(): Promise<boolean> {
    return (await this.git("status", "--porcelain")).length > 0;
  }

  async commitAll(message: string): Promise<string | null> {
    if (!(await this.hasChanges())) return null;
    await this.git("add", "-A");
    await this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "--short", "HEAD");
  }

  headSha(): Promise<string> {
    return this.git("rev-parse", "HEAD");
  }

  async patchSinceMain(): Promise<string> {
    return this.git("diff", "--no-color", "--no-ext-diff", "main", "HEAD");
  }

  async mergeToMain(): Promise<void> {
    const branch = await this.git("rev-parse", "--abbrev-ref", "HEAD");
    await this.git("checkout", "-q", "main");
    await this.git("merge", "-q", "--ff-only", branch);
  }

  async destroy(): Promise<void> {}
}
