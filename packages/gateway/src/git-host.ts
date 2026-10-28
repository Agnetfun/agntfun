import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ulid } from "@devagent/core";
import type { GitPush, VcsHost } from "./types";

const run = promisify(execFile);

/**
 * Applies gateway approved patches to a real git remote with the git CLI. Runs in the gateway process only.
 * The remote is either a local bare repository (no account needed, for testing) or GitHub.
 * Every push starts from the remote's main, so a patch can never touch history.
 */
export interface GitRemote {
  url(repo: string): string;
  /** Extra env for git (auth headers). Never put tokens in argv. */
  env(repo: string, agentId: string): Record<string, string> | Promise<Record<string, string>>;
  ensure(repo: string, agentId: string): Promise<void>;
  /** A local repository whose main seeds a brand new remote (work done before GitHub was connected). */
  seed?(repo: string, agentId: string): string | undefined;
}

export class GitCliHost implements VcsHost {
  constructor(
    private remote: GitRemote,
    private workRoot = join("data", "gateway", "git-work"),
    private author = { name: "DevAgent", email: "agent@devagent.local" },
  ) {}

  private async git(dir: string, env: Record<string, string>, ...args: string[]) {
    const { stdout } = await run(
      "git",
      ["-c", `user.name=${this.author.name}`, "-c", `user.email=${this.author.email}`, ...args],
      { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, maxBuffer: 20_000_000 },
    );
    return stdout.trim();
  }

  async push(i: GitPush): Promise<{ ref: string }> {
    await this.remote.ensure(i.repo, i.agentId);
    const env = await this.remote.env(i.repo, i.agentId);
    mkdirSync(this.workRoot, { recursive: true });
    const dir = resolve(this.workRoot, i.repo.replace(/[^A-Za-z0-9._-]/g, "__"));
    if (!existsSync(join(dir, ".git"))) {
      rmSync(dir, { recursive: true, force: true });
      await this.git(this.workRoot, env, "clone", "--quiet", this.remote.url(i.repo), dir);
    }
    await this.git(dir, env, "fetch", "--quiet", "--prune", "origin");
    const heads = await this.git(dir, env, "ls-remote", "--heads", "origin", "main");
    if (!heads) {
      const seed = this.remote.seed?.(i.repo, i.agentId);
      if (seed && existsSync(seed)) {
        // Carry the history built before this remote existed, so patches since main apply cleanly.
        await this.git(dir, env, "fetch", "--quiet", seed, "main:refs/remotes/seed/main");
        await this.git(dir, env, "push", "--quiet", "origin", "refs/remotes/seed/main:refs/heads/main");
      } else {
        await this.git(dir, env, "checkout", "--quiet", "--orphan", "main");
        await this.git(dir, env, "commit", "--quiet", "--allow-empty", "-m", "Initial commit");
        await this.git(dir, env, "push", "--quiet", "origin", "main");
      }
      await this.git(dir, env, "fetch", "--quiet", "origin");
    }
    const target = i.merge ? "main" : i.branch;
    await this.git(dir, env, "checkout", "--quiet", "-B", target, "origin/main");
    await this.git(dir, env, "reset", "--quiet", "--hard", "origin/main");
    await this.git(dir, env, "clean", "-fdq");
    const patchFile = join(this.workRoot, `${ulid()}.patch`);
    writeFileSync(patchFile, i.patch);
    try {
      await this.git(dir, env, "apply", "--index", "--whitespace=nowarn", patchFile);
    } finally {
      rmSync(patchFile, { force: true });
    }
    const msg = i.commitMessage || (i.merge ? `Merge session ${i.sessionId}` : `Session ${i.sessionId}`);
    await this.git(dir, env, "commit", "--quiet", "--allow-empty", "-m", msg);
    const sha = await this.git(dir, env, "rev-parse", "HEAD");
    await this.git(dir, env, "push", "--quiet", ...(i.merge ? [] : ["--force"]), "origin", `HEAD:refs/heads/${target}`);
    return { ref: `${target}@${sha.slice(0, 12)}` };
  }
}

/** Bare repositories on this machine, created on first push. Browse them with any git client. */
export class LocalGitRemote implements GitRemote {
  constructor(private root = join("data", "remotes")) {}
  url(repo: string) {
    return resolve(this.root, `${repo}.git`);
  }
  env() {
    return {};
  }
  async ensure(repo: string) {
    const p = this.url(repo);
    if (existsSync(p)) return;
    mkdirSync(p, { recursive: true });
    await run("git", ["init", "--quiet", "--bare", "-b", "main", p]);
  }
}

/**
 * GitHub over HTTPS. The token goes into git through GIT_CONFIG_* env (not argv, not the remote URL).
 * Repositories are created under the owner on first push.
 * Endpoints per docs.github.com REST: GET /repos/{owner}/{repo}, POST /orgs/{org}/repos, POST /user/repos.
 */
export class GitHubRemote implements GitRemote {
  constructor(
    private token: (agentId: string) => Promise<string | undefined> | string | undefined,
    private seedFor?: (repo: string, agentId: string) => string | undefined,
    private fetchFn: typeof fetch = fetch,
  ) {}
  private async tok(agentId: string) {
    const t = await this.token(agentId);
    if (!t) throw new Error("no GitHub token for this agent");
    return t;
  }
  url(repo: string) {
    return `https://github.com/${repo}.git`;
  }
  seed(repo: string, agentId: string) {
    return this.seedFor?.(repo, agentId);
  }
  async env(_repo: string, agentId: string) {
    const basic = Buffer.from(`x-access-token:${await this.tok(agentId)}`).toString("base64");
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
  }
  async ensure(repo: string, agentId: string) {
    const headers = {
      authorization: `Bearer ${await this.tok(agentId)}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "devagent-gateway",
    };
    const got = await this.fetchFn(`https://api.github.com/repos/${repo}`, { headers });
    if (got.ok) return;
    if (got.status !== 404) throw new Error(`github repo check failed: ${got.status}`);
    const [owner, name] = repo.split("/");
    // The agent's own account owns its repos (POST /user/repos); a shared org token uses POST /orgs/{org}/repos.
    const me = await this.fetchFn("https://api.github.com/user", { headers });
    const login = me.ok ? ((await me.json()) as { login?: string }).login : undefined;
    const url =
      login && login.toLowerCase() === owner?.toLowerCase()
        ? "https://api.github.com/user/repos"
        : `https://api.github.com/orgs/${owner}/repos`;
    const made = await this.fetchFn(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name, private: false, auto_init: false, description: "Built by a DevAgent agent" }),
    });
    if (!made.ok) throw new Error(`github repo create failed: ${made.status}`);
  }
}
