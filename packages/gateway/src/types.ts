import { z } from "zod";

const id = z.string().min(1).max(64);

export const GitPushIntent = z.object({
  kind: z.literal("git_push"),
  agentId: id,
  sessionId: id,
  repo: z.string().min(3).max(100),
  branch: z.string().min(1).max(100),
  headSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  patch: z.string().max(2_000_000),
  /** The workspace's main as a patch from an empty tree: the first commit of a brand new remote (starter files). */
  base: z.string().max(200_000).default(""),
  testReport: z.object({ passed: z.boolean(), summary: z.string().max(500).default("") }),
  merge: z.boolean().default(false),
  commitMessage: z.string().max(300).default(""),
});

export const PostUpdateIntent = z.object({
  kind: z.literal("post_update"),
  agentId: id,
  sessionId: id,
  text: z.string().min(1).max(2000),
});

export const Intent = z.discriminatedUnion("kind", [GitPushIntent, PostUpdateIntent]);
export type Intent = z.infer<typeof Intent>;
export type GitPush = z.infer<typeof GitPushIntent>;
export type PostUpdate = z.infer<typeof PostUpdateIntent>;

export type Stage = "kill" | "schema" | "allowlist" | "limits" | "secrets" | "content" | "execute";
export type Decision =
  { allowed: true; ref: string } | { allowed: false; stage: Stage; reason: string };

/** What the orchestrator and runner see. The real tokens live only behind this interface. */
export interface GatewayClient {
  submit(intent: unknown): Promise<Decision>;
}

export interface VcsHost {
  push(i: GitPush): Promise<{ ref: string }>;
}
export interface Social {
  post(agentId: string, text: string): Promise<{ ref: string }>;
}

export class MockVcsHost implements VcsHost {
  pushes: GitPush[] = [];
  async push(i: GitPush) {
    this.pushes.push(i);
    return { ref: `mock-push-${this.pushes.length}` };
  }
}
export class MockSocial implements Social {
  posts: { agentId: string; text: string }[] = [];
  async post(agentId: string, text: string) {
    this.posts.push({ agentId, text });
    return { ref: `mock-post-${this.posts.length}` };
  }
}
