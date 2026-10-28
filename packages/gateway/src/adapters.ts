import type { Db } from "@devagent/db";
import { systemClock } from "@devagent/core";
import { GitCliHost, GitHubRemote, LocalGitRemote } from "./git-host";
import { appsFromEnv } from "./oauth";
import { LocalSocial, XMentionsSource, XSocial } from "./social";
import { MockSocial, MockVcsHost, type GitPush, type Social, type VcsHost } from "./types";
import { AUTH_FAILURE, SealedVault, TokenSource, hasCredential, markCredentialError, markCredentialOk } from "./vault";

export type VcsMode = "auto" | "mock" | "local" | "github";
export type SocialMode = "auto" | "mock" | "local" | "x";

export interface Adapters {
  vcs: VcsHost;
  social: Social;
  vcsMode: VcsMode;
  socialMode: SocialMode;
  /** Community sources for one agent beyond the website form (its X mentions when X is in use). */
  sourcesFor(agentId: string): XMentionsSource[];
}

/**
 * Picks where each agent's work goes. Default "auto": an agent with a connected GitHub account pushes to its own
 * GitHub repo, one with a connected X account posts on X; everything else stays local (bare git repos under
 * data/remotes, posts in data/outbox/x.jsonl). "github"/"x" force the real service (shared GITHUB_TOKEN /
 * X_ACCESS_TOKEN as fallbacks); "local"/"mock" never touch the network.
 * Tokens are read from the sealed vault and refreshed by TokenSource; only this (gateway) process can open them.
 */
export function adaptersFromEnv(db: Db, env: Record<string, string | undefined> = process.env): Adapters {
  const vcsMode = (env.VCS_MODE || "auto") as VcsMode;
  const socialMode = (env.SOCIAL_MODE || "auto") as SocialMode;
  if (!["auto", "mock", "local", "github"].includes(vcsMode)) throw new Error("VCS_MODE must be auto, mock, local or github");
  if (!["auto", "mock", "local", "x"].includes(socialMode)) throw new Error("SOCIAL_MODE must be auto, mock, local or x");
  const priv = env.SEAL_PRIVATE_KEY;
  const pub = env.SEAL_PUBLIC_KEY;
  if ((vcsMode === "github" || socialMode === "x") && !priv) throw new Error("real GitHub or X mode needs SEAL_PRIVATE_KEY");
  const tokens =
    priv && pub ? new TokenSource(db, systemClock, new SealedVault(db, priv), pub, appsFromEnv(env)) : undefined;
  const ghToken = async (id: string) => (await tokens?.get(id, "github")) ?? env.GITHUB_TOKEN;
  const xToken = async (id: string) => (await tokens?.get(id, "x")) ?? env.X_ACCESS_TOKEN;
  const connected = (id: string, kind: "github" | "x") => !!tokens && hasCredential(db, id, kind);

  // Every real call reports back: success marks the connection healthy, an auth failure flags "needs reconnect".
  async function tracked<T>(agentId: string, kind: "github" | "x", call: () => Promise<T>): Promise<T> {
    try {
      const out = await call();
      if (hasCredential(db, agentId, kind)) markCredentialOk(db, systemClock, agentId, kind);
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (AUTH_FAILURE.test(msg) && hasCredential(db, agentId, kind)) markCredentialError(db, systemClock, agentId, kind, msg);
      throw e;
    }
  }

  const local = new LocalGitRemote();
  // Work an agent did before GitHub was connected lives in its old local repo; it seeds the new GitHub repo.
  const seedFor = (repo: string) => {
    const r = db.prepare("SELECT repo_prev FROM agents WHERE repo=?").get(repo) as { repo_prev: string | null } | undefined;
    return r?.repo_prev ? local.url(r.repo_prev) : undefined;
  };
  const localHost = new GitCliHost(local);
  const githubHost = new GitCliHost(new GitHubRemote(ghToken, seedFor));
  const vcs: VcsHost =
    vcsMode === "mock"
      ? new MockVcsHost()
      : vcsMode === "local"
        ? localHost
        : vcsMode === "github"
          ? { push: (i: GitPush) => tracked(i.agentId, "github", () => githubHost.push(i)) }
          : {
              push: (i: GitPush) =>
                connected(i.agentId, "github")
                  ? tracked(i.agentId, "github", () => githubHost.push(i))
                  : localHost.push(i),
            };

  const outbox = new LocalSocial();
  const xPoster = new XSocial(xToken);
  const social: Social =
    socialMode === "mock"
      ? new MockSocial()
      : socialMode === "local"
        ? outbox
        : socialMode === "x"
          ? { post: (id: string, text: string) => tracked(id, "x", () => xPoster.post(id, text)) }
          : {
              post: (id: string, text: string) =>
                connected(id, "x") ? tracked(id, "x", () => xPoster.post(id, text)) : outbox.post(id, text),
            };
  const mentionsEveryMs = (Number(env.X_MENTIONS_EVERY_MINUTES) || 15) * 60_000;

  const sources = new Map<string, XMentionsSource>();
  return {
    vcs,
    social,
    vcsMode,
    socialMode,
    sourcesFor(agentId) {
      const useX = socialMode === "x" || (socialMode === "auto" && connected(agentId, "x"));
      if (!useX) return [];
      if (!sources.has(agentId)) {
        const src = new XMentionsSource(() => xToken(agentId), fetch, mentionsEveryMs);
        const read = src.fetch.bind(src);
        src.fetch = () => tracked(agentId, "x", read);
        sources.set(agentId, src);
      }
      return [sources.get(agentId)!];
    },
  };
}
