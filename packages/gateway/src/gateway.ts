import { scanText, ulid, type Clock } from "@devagent/core";
import { getAgent, sha256, type Db } from "@devagent/db";
import { checkOutbound, checkPost, type KillSwitch } from "@devagent/safety";
import { badPath, inspectPatch } from "./patch";
import { take, type Bucket } from "./ratelimit";
import {
  Intent,
  type Decision,
  type GatewayClient,
  type GitPush,
  type PostUpdate,
  type Social,
  type Stage,
  type VcsHost,
} from "./types";

export interface GatewayOptions {
  allowedLinkHosts: string[];
  maxPatchBytes: number;
  maxFiles: number;
  pushBucket: Bucket;
  postBucket: Bucket;
  maxPostChars: number;
}

export const DEFAULT_OPTIONS: GatewayOptions = {
  allowedLinkHosts: ["github.com"],
  maxPatchBytes: 200_000,
  maxFiles: 40,
  pushBucket: { capacity: 6, refillPerSec: 6 / 3600 },
  postBucket: { capacity: 4, refillPerSec: 1 / 1800 },
  maxPostChars: 280,
};

const SESSION_BRANCH = /^session\/[0-9A-HJKMNP-TV-Z]{26}$/;

type Deny = { stage: Stage; reason: string };

export class ActionGateway implements GatewayClient {
  private opts: GatewayOptions;
  constructor(
    private db: Db,
    private clock: Clock,
    private kill: KillSwitch,
    private vcs: VcsHost,
    private social: Social,
    opts: Partial<GatewayOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  async submit(raw: unknown): Promise<Decision> {
    const hash = sha256(JSON.stringify(raw) ?? "null");
    const kindGuess = (raw as { kind?: unknown } | null)?.kind;
    const agentGuess = (raw as { agentId?: unknown } | null)?.agentId;
    const kind = typeof kindGuess === "string" ? kindGuess.slice(0, 32) : "unknown";
    const agentId = typeof agentGuess === "string" ? agentGuess.slice(0, 64) : null;

    // Stage order: kill, schema, allowlist, limits, secrets, content, execute.
    if (this.kill.isHalted(agentId ?? undefined))
      return this.deny(agentId, kind, hash, { stage: "kill", reason: "halted" });
    const parsed = Intent.safeParse(raw);
    if (!parsed.success)
      return this.deny(agentId, kind, hash, { stage: "schema", reason: "invalid intent" });
    const i = parsed.data;
    const d = i.kind === "git_push" ? this.checkPush(i) : this.checkPost(i);
    if (d) return this.deny(i.agentId, i.kind, hash, d);
    try {
      const { ref } =
        i.kind === "git_push" ? await this.vcs.push(i) : await this.social.post(i.agentId, i.text);
      this.audit(i.agentId, i.kind, hash, "allow", undefined, undefined, ref);
      return { allowed: true, ref };
    } catch (e) {
      return this.deny(i.agentId, i.kind, hash, {
        stage: "execute",
        reason: e instanceof Error ? e.message.slice(0, 200) : "failed",
      });
    }
  }

  private checkPush(i: GitPush): Deny | undefined {
    const agent = getAgent(this.db, i.agentId);
    if (!agent) return { stage: "allowlist", reason: "unknown agent" };
    if (!agent.repo || agent.repo !== i.repo)
      return { stage: "allowlist", reason: "repo not allowed for agent" };
    const mainOk = i.branch === "main" && i.merge;
    if (!SESSION_BRANCH.test(i.branch) && !mainOk)
      return { stage: "allowlist", reason: "branch not allowed" };
    if (i.merge && !i.testReport.passed)
      return { stage: "allowlist", reason: "merge requires passing tests" };
    if (i.branch === "main" && !i.merge)
      return { stage: "allowlist", reason: "direct push to main" };
    // The starter files of a new remote pass the same path, symlink and secret checks as the session's own patch.
    if (i.base) {
      const b = inspectPatch(i.base);
      if (b.symlink) return { stage: "allowlist", reason: "symlinks not allowed" };
      for (const f of b.files) {
        const bad = badPath(f);
        if (bad) return { stage: "allowlist", reason: bad };
      }
      if (scanText(i.base).length) return { stage: "secrets", reason: "secret-like content" };
    }
    const info = inspectPatch(i.patch);
    for (const f of info.files) {
      const bad = badPath(f);
      if (bad) return { stage: "allowlist", reason: bad };
    }
    if (info.symlink) return { stage: "allowlist", reason: "symlinks not allowed" };
    if (info.bytes > this.opts.maxPatchBytes) return { stage: "limits", reason: "patch too large" };
    if (info.files.length > this.opts.maxFiles)
      return { stage: "limits", reason: "too many files" };
    if (!take(this.db, this.clock, i.agentId, "git_push", this.opts.pushBucket))
      return { stage: "limits", reason: "rate limited" };
    if (scanText(i.patch).length || scanText(i.commitMessage).length)
      return { stage: "secrets", reason: "secret-like content" };
    const c = checkOutbound(i.commitMessage);
    if (!c.ok) return { stage: "content", reason: `commit message: ${c.rule}` };
    return undefined;
  }

  private checkPost(i: PostUpdate): Deny | undefined {
    const agent = getAgent(this.db, i.agentId);
    if (!agent) return { stage: "allowlist", reason: "unknown agent" };
    if (i.text.length > this.opts.maxPostChars) return { stage: "limits", reason: "post too long" };
    const links = i.text.match(/https?:\/\/\S+/gi) ?? [];
    if (links.length > 1) return { stage: "allowlist", reason: "more than one link" };
    for (const l of links) {
      let host: string;
      try {
        host = new URL(l).hostname;
      } catch {
        return { stage: "allowlist", reason: "malformed link" };
      }
      if (!this.opts.allowedLinkHosts.includes(host))
        return { stage: "allowlist", reason: `link host ${host} not allowed` };
    }
    if (!take(this.db, this.clock, i.agentId, "post_update", this.opts.postBucket))
      return { stage: "limits", reason: "rate limited" };
    if (scanText(i.text).length) return { stage: "secrets", reason: "secret-like content" };
    const c = checkPost(i.text);
    if (!c.ok) return { stage: "content", reason: c.rule };
    return undefined;
  }

  private deny(agentId: string | null, kind: string, hash: string, d: Deny): Decision {
    this.audit(agentId, kind, hash, "deny", d.stage, d.reason);
    return { allowed: false, ...d };
  }

  private audit(
    agentId: string | null,
    kind: string,
    hash: string,
    decision: "allow" | "deny",
    stage?: Stage,
    reason?: string,
    ref?: string,
  ) {
    this.db
      .prepare(
        "INSERT INTO gateway_audit (id, ts, agent_id, intent_kind, request_hash, decision, stage, reason, result_ref) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ulid(this.clock.now()),
        this.clock.now(),
        agentId && getAgent(this.db, agentId) ? agentId : null,
        kind,
        hash,
        decision,
        stage ?? null,
        reason ?? null,
        ref ?? null,
      );
  }
}
