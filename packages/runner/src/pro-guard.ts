import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Pro coding mode gives the model real file tools (Claude Agent SDK). This guard runs before EVERY tool call
 * (a PreToolUse hook, which also covers calls the SDK would auto approve) and is the boundary that keeps the agent
 * inside its own repository: no shell, no web, no path outside the repo, no secrets or git internals inside it.
 */
export const PRO_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"] as const;
export const TEST_TOOL = "mcp__devagent__run_tests";

export type GuardResult = { ok: true } | { ok: false; reason: string };

const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.netrc)$/i;
const deny = (reason: string): GuardResult => ({ ok: false, reason });

/** The real location of a path, following links on its nearest existing parent (a new file has no realpath yet). */
function realOf(p: string): string {
  let cur = p;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return p;
    tail.unshift(basename(cur));
    cur = up;
  }
  return resolve(realpathSync(cur), ...tail);
}

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function checkPath(root: string, raw: unknown, optional: boolean): GuardResult {
  if (raw === undefined && optional) return { ok: true };
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return deny("invalid path");
  if (/^[A-Za-z]:(?![\\/])/.test(raw)) return deny("invalid path"); // "C:foo" resolves against a per drive folder
  const realRoot = realOf(resolve(root));
  const abs = resolve(realRoot, raw);
  if (!inside(realRoot, abs) || !inside(realRoot, realOf(abs))) return deny("path is outside the repository");
  const parts = relative(realRoot, realOf(abs)).split(sep);
  if (parts.includes(".git")) return deny("git internals are off limits");
  if (parts.some((p) => SECRET_NAME.test(p))) return deny("secret files are off limits");
  return { ok: true };
}

/** A glob may not climb out of the repo or start from an absolute path. */
function checkPattern(raw: unknown, optional: boolean): GuardResult {
  if (raw === undefined && optional) return { ok: true };
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return deny("invalid pattern");
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.split(/[\\/]/).includes("..")) return deny("pattern leaves the repository");
  return { ok: true };
}

export function checkToolCall(root: string, tool: string, input: unknown): GuardResult {
  if (tool === TEST_TOOL) return { ok: true };
  if (!(PRO_TOOLS as readonly string[]).includes(tool)) return deny(`${tool} is not available to this agent`);
  if (!input || typeof input !== "object") return deny("invalid input");
  const i = input as Record<string, unknown>;
  const steps: GuardResult[] =
    tool === "Glob"
      ? [checkPath(root, i.path, true), checkPattern(i.pattern, false)]
      : tool === "Grep"
        ? [checkPath(root, i.path, true), checkPattern(i.glob, true)]
        : [checkPath(root, i.file_path, false)];
  return steps.find((s) => !s.ok) ?? { ok: true };
}
