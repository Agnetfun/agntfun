export interface PatchInfo {
  files: string[];
  symlink: boolean;
  bytes: number;
  /** True when some file header could not be read with certainty (quoted path, odd prefix): the patch is refused. */
  unparsed: boolean;
}

/**
 * Minimal unified-diff reader: file paths, symlink modes, size. It fails closed: git quotes paths with non-ASCII or
 * special characters ("a/\303\251.yml"), and a path this reader cannot see is a path the allowlist cannot check,
 * so any header it does not fully understand marks the patch unparsed. `---`/`+++` are only read in a file's header
 * (before its first hunk), where they are headers, never inside hunks, where they are changed lines.
 */
export function inspectPatch(patch: string): PatchInfo {
  const files = new Set<string>();
  let symlink = false;
  let unparsed = false;
  let inHeader = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m || line.includes('"')) unparsed = true;
      else {
        files.add(m[1]!);
        files.add(m[2]!);
      }
      continue;
    }
    if (!inHeader) continue;
    if (line.startsWith("@@")) {
      inHeader = false;
      continue;
    }
    if (/^(?:new file|deleted file|new|old) mode 120000/.test(line)) symlink = true;
    const hp = /^(?:\+\+\+|---) (.*)$/.exec(line);
    if (hp) {
      const v = hp[1]!;
      if (v === "/dev/null") continue;
      const ab = /^(?:a|b)\/(.+)$/.exec(v);
      if (!ab || v.includes('"')) unparsed = true;
      else files.add(ab[1]!);
      continue;
    }
    const rc = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line);
    if (rc) {
      if (rc[1]!.startsWith('"')) unparsed = true;
      else files.add(rc[1]!);
    }
  }
  return { files: [...files], symlink, bytes: Buffer.byteLength(patch), unparsed };
}

const BLOCKED: RegExp[] = [
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.github\//,
  /(^|\/)\.githooks\//,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /(^|\/)(\.npmrc|\.netrc|credentials\.json|keypair\.json)$/,
];

export function badPath(path: string): string | undefined {
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return `absolute path ${path}`;
  if (path.split("/").includes("..")) return `path traversal ${path}`;
  if (path.includes("\0")) return "null byte in path";
  if (BLOCKED.some((r) => r.test(path))) return `blocked path ${path}`;
  return undefined;
}
