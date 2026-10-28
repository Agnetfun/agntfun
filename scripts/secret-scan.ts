import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { scanText } from "../packages/core/src/secrets";

const staged = process.argv.includes("--staged");
const git = (args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const list = (args: string[]) => git(args).split("\n").filter(Boolean);

const files = staged
  ? list(["diff", "--cached", "--name-only", "--diff-filter=ACM"])
  : list(["ls-files"]);

const SKIP = (f: string) => f.startsWith("skills/") || f === "pnpm-lock.yaml";
const ENV_FILE = /(^|\/)\.env(\..+)?$/;

let bad = 0;
for (const f of files) {
  if (ENV_FILE.test(f) && !f.endsWith(".env.example")) {
    console.error(`${f}: env file must not be committed`);
    bad++;
    continue;
  }
  if (SKIP(f)) continue;
  let text: string;
  try {
    text = staged ? git(["show", `:${f}`]) : readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue; // binary
  for (const hit of scanText(text)) {
    const line = text.slice(0, hit.start).split("\n").length;
    console.error(`${f}:${line} possible secret (${hit.rule})`); // never print the value
    bad++;
  }
}

if (bad > 0) {
  console.error(`\nsecret-scan: ${bad} problem(s). Commit blocked.`);
  process.exit(1);
}
console.log(`secret-scan: ${files.length} file(s) clean`);
