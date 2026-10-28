export interface Finding {
  rule: string;
  start: number;
  end: number;
}

// Order matters only for the rule name reported; redaction merges overlaps.
const RULES: Array<{ name: string; re: RegExp }> = [
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-style-key", re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "github-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "x-bearer", re: /\bA{15,}[A-Za-z0-9%]{30,}/g },
  { name: "solana-secret-base58", re: /\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g },
  { name: "solana-keypair-array", re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g },
  {
    name: "generic-assignment",
    re: /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|seed[_-]?phrase|mnemonic)\b\s*[:=]\s*["']?(?!process\.env|env\.|\$\{)(?=[A-Za-z0-9/+_.=-]*\d)[A-Za-z0-9/+_.=-]{16,}/gi,
  },
];

// TODO(phase 2): seed phrase detection and entropy check for unknown key formats.

export function scanText(text: string): Finding[] {
  const out: Finding[] = [];
  for (const { name, re } of RULES) {
    for (const m of text.matchAll(re)) {
      out.push({ rule: name, start: m.index, end: m.index + m[0].length });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

export function redactSecrets(text: string, mask = "[REDACTED]"): string {
  const found = scanText(text);
  if (found.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const f of found) {
    if (f.end <= cursor) continue; // fully inside a previous match
    out += text.slice(cursor, Math.max(cursor, f.start)) + mask;
    cursor = f.end;
  }
  return out + text.slice(cursor);
}
