import { readFileSync } from "node:fs";
import type { Clock } from "@devagent/core";
import { upsertTask, type Db } from "@devagent/db";

/** Reads "- [ ] do a thing" lines from a markdown file into the task queue. Returns new task count. */
export function syncTasksFromFile(db: Db, clock: Clock, agentId: string, file: string): number {
  let added = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*[-*]\s*\[ \]\s+(.+?)\s*$/.exec(line);
    if (m && upsertTask(db, clock, { agentId, source: "file", summary: m[1]!.slice(0, 300) }))
      added++;
  }
  return added;
}
