import { randomBytes } from "node:crypto";
import { GitWorkspace, run } from "./workspace";

export interface DockerRunSpec {
  name: string;
  image: string;
  agentId: string;
  /** Host directory mounted at /workspace. Never the git directory. */
  workDir: string;
  uid: number;
  gid: number;
  memory?: string;
  cpus?: string;
  pids?: number;
}

/**
 * The exact `docker run` arguments for an agent sandbox. Kept as a pure function so the
 * security properties can be unit tested without a Docker daemon.
 * - non root, read only root filesystem, all capabilities dropped, no new privileges
 * - no network at all (package installs are not supported until an egress proxy exists)
 * - explicit environment only: nothing is inherited from the host, no secrets
 * - only the workspace is mounted; no docker socket, no host paths, no privileged mode
 */
export function dockerRunArgs(s: DockerRunSpec): string[] {
  const user = s.uid === 0 ? "10001:10001" : `${s.uid}:${s.gid}`;
  return [
    "run",
    "-d",
    "--rm",
    "--name",
    s.name,
    "--label",
    `devagent.agent=${s.agentId}`,
    "--user",
    user,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--network",
    "none",
    "--pids-limit",
    String(s.pids ?? 128),
    "--memory",
    s.memory ?? "512m",
    "--cpus",
    s.cpus ?? "1",
    "-v",
    `${s.workDir}:/workspace:rw`,
    "-w",
    "/workspace",
    "-e",
    "CI=1",
    "-e",
    "HOME=/tmp",
    "-e",
    "NODE_ENV=test",
    s.image,
    "sleep",
    "infinity",
  ];
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

export interface DockerOptions {
  image: string;
  agentId: string;
}

export class DockerWorkspace extends GitWorkspace {
  private container: string | null = null;
  private constructor(
    work: string,
    gitDir: string,
    private o: DockerOptions,
  ) {
    super(work, gitDir);
  }

  static async open(dir: string, o: DockerOptions): Promise<DockerWorkspace> {
    const { work, gitDir, fresh } = await GitWorkspace.prepare(dir);
    const w = new DockerWorkspace(work, gitDir, o);
    if (fresh) await w.init();
    return w;
  }

  private async ensureContainer(): Promise<string> {
    if (this.container) return this.container;
    const name = `devagent-${this.o.agentId.toLowerCase()}-${randomBytes(4).toString("hex")}`;
    await run(
      "docker",
      dockerRunArgs({
        name,
        image: this.o.image,
        agentId: this.o.agentId,
        workDir: this.work,
        uid: process.getuid?.() ?? 10001,
        gid: process.getgid?.() ?? 10001,
      }),
    );
    this.container = name;
    return name;
  }

  async runTests(timeoutMs: number): Promise<{ ok: boolean; output: string }> {
    const name = await this.ensureContainer();
    try {
      const { stdout, stderr } = await run(
        "docker",
        ["exec", "-w", "/workspace", name, "node", "--test"],
        {
          timeout: timeoutMs,
          maxBuffer: 1_000_000,
        },
      );
      return { ok: true, output: (stdout + stderr).slice(-4000) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; killed?: boolean };
      const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.slice(-4000);
      if (err.killed) await this.destroy(); // a hung test must not keep running
      return {
        ok: false,
        output: err.killed ? `tests timed out after ${timeoutMs}ms\n${out}` : out,
      };
    }
  }

  async destroy(): Promise<void> {
    if (!this.container) return;
    const name = this.container;
    this.container = null;
    await run("docker", ["rm", "-f", name]).catch(() => {});
  }
}

/** Used by the kill switch: stops every sandbox container for an agent (or all agents). */
export async function killContainers(agentId?: string): Promise<number> {
  const filter = agentId ? `label=devagent.agent=${agentId}` : "label=devagent.agent";
  try {
    const { stdout } = await run("docker", ["ps", "-q", "--filter", filter]);
    const ids = stdout.split("\n").filter(Boolean);
    if (ids.length) await run("docker", ["rm", "-f", ...ids]);
    return ids.length;
  } catch {
    return 0;
  }
}
