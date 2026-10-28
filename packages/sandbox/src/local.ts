import { GitWorkspace, run } from "./workspace";

/**
 * DEV ONLY. Runs tests as a plain child process with an empty environment but no isolation
 * beyond that. Production uses DockerWorkspace.
 */
export class LocalWorkspace extends GitWorkspace {
  static async open(dir: string): Promise<LocalWorkspace> {
    const { work, gitDir, fresh } = await GitWorkspace.prepare(dir);
    const w = new LocalWorkspace(work, gitDir);
    if (fresh) await w.init();
    return w;
  }

  async runTests(timeoutMs: number): Promise<{ ok: boolean; output: string }> {
    try {
      const { stdout, stderr } = await run("node", ["--test"], {
        cwd: this.work,
        timeout: timeoutMs,
        maxBuffer: 1_000_000,
        env: { PATH: process.env.PATH ?? "", HOME: this.work, CI: "1", NODE_ENV: "test" },
      });
      return { ok: true, output: (stdout + stderr).slice(-4000) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; killed?: boolean };
      const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.slice(-4000);
      return {
        ok: false,
        output: err.killed ? `tests timed out after ${timeoutMs}ms\n${out}` : out,
      };
    }
  }
}
