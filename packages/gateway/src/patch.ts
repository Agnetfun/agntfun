export interface PatchInfo {
  files: string[];
  symlink: boolean;
  bytes: number;
}

/** Minimal unified-diff reader: file paths, symlink modes, size. */
export function inspectPatch(patch: string): PatchInfo {
  const files = new Set<string>();
  let symlink = false;
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (m) {
      files.add(m[1]!);
      files.add(m[2]!);
    }
    const p = /^(?:\+\+\+|---) (?:a|b)\/(.+)$/.exec(line);
    if (p) files.add(p[1]!);
    if (/^(?:new file|deleted file|new|old) mode 120000/.test(line)) symlink = true;
  }
  return { files: [...files], symlink, bytes: Buffer.byteLength(patch) };
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
