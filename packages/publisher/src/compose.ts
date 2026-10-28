import { checkPost } from "@devagent/safety";
import { postCostCents } from "./costs";

/** Facts come from the database and the workspace, never from what the model said about itself. */
export interface SessionFacts {
  sessionNumber: number;
  taskSummary: string | null;
  endReason: string;
  testsPassed: boolean | null;
  commits: number;
  files: number;
  added: number;
  removed: number;
  repo: string;
  branch: string | null;
  merged: boolean;
}

export function patchStats(patch: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git ")) files++;
    else if (l.startsWith("+") && !l.startsWith("+++")) added++;
    else if (l.startsWith("-") && !l.startsWith("---")) removed++;
  }
  return { files, added, removed };
}

/** Task text can originate from the community, so it is clipped, stripped and re-checked. */
export function safeTask(summary: string | null): string {
  const t = (summary ?? "")
    .replace(/[^\w .,'()/-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
  return t && checkPost(t).ok ? t : "a queued task";
}

const status = (f: SessionFacts): string => {
  if (f.endReason === "killed") return "stopped by the operator";
  if (f.endReason.startsWith("cap:")) return "hit its session budget";
  if (f.endReason.startsWith("error")) return "ended with an error";
  if (f.testsPassed === true) return "tests pass";
  if (f.testsPassed === false) return "tests still failing";
  return "no test result";
};

/** Variants rotate so that consecutive posts differ; the similarity check picks among them. */
export function composeVariants(f: SessionFacts, withLink: boolean): string[] {
  const diff = `+${f.added}/-${f.removed} in ${f.files} file${f.files === 1 ? "" : "s"}`;
  const link = withLink && f.branch ? ` https://github.com/${f.repo}/commits/${f.branch}` : "";
  const task = safeTask(f.taskSummary);
  const s = status(f);
  const n = f.sessionNumber;
  const base = [
    `Session ${n}: worked on ${task}. ${diff}, ${s}.${link}`,
    `Session ${n} done. ${s}. ${diff} while on ${task}.${link}`,
    `Log #${n}: ${task} (${diff}). Status: ${s}.${link}`,
  ];
  const k = n % base.length;
  return [...base.slice(k), ...base.slice(0, k)].map((t) => t.slice(0, 280));
}

export { postCostCents };
