import { redactSecrets, scanText, type Clock } from "@devagent/core";
import type { Db } from "@devagent/db";

/**
 * Frames for the public live agent screen. Only what the agent DID is shown (file contents it wrote, test output,
 * commits), never its raw model text, because model text can carry injected community content.
 * Everything is clipped and secret scanned before it is stored; a file that looks like it holds a secret is hidden.
 */
export type FrameKind = "start" | "recall" | "read" | "write" | "list" | "tests" | "commit" | "end";

const LIMITS = { file: 12_000, output: 3_000, small: 300 };
const KEEP_SESSIONS = 5;

const clean = (s: string, max: number) => {
  const c = s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
  return redactSecrets(c);
};

export class LiveScreen {
  private seq = 0;
  constructor(
    private db: Db,
    private clock: Clock,
    private agentId: string,
    private sessionId: string,
  ) {
    // Keep the newest sessions only; older replays are dropped.
    db.prepare(
      `DELETE FROM live_frames WHERE agent_id=? AND session_id NOT IN (
         SELECT id FROM sessions WHERE agent_id=? ORDER BY started_at DESC LIMIT ${KEEP_SESSIONS})`,
    ).run(agentId, agentId);
  }

  frame(kind: FrameKind, payload: Record<string, unknown>): void {
    try {
      this.db
        .prepare(
          "INSERT INTO live_frames (session_id, seq, agent_id, ts, kind, payload_json) VALUES (?,?,?,?,?,?)",
        )
        .run(this.sessionId, ++this.seq, this.agentId, this.clock.now(), kind, JSON.stringify(payload));
    } catch {
      /* the screen is a view; it must never break a session */
    }
  }

  /** The agent recalled this many past sessions from its memory. */
  recall(sessions: number) {
    this.frame("recall", { sessions });
  }
  start(task: string) {
    this.frame("start", { task: clean(task, LIMITS.small) });
  }
  read(path: string) {
    this.frame("read", { path: clean(path, LIMITS.small) });
  }
  list(path: string, entries: string) {
    this.frame("list", { path: clean(path, LIMITS.small), entries: clean(entries, LIMITS.output) });
  }
  write(path: string, content: string) {
    const hidden = scanText(content).length > 0;
    this.frame("write", {
      path: clean(path, LIMITS.small),
      content: hidden ? "// hidden: this file looked like it contained a secret" : clean(content, LIMITS.file),
      chars: content.length,
    });
  }
  tests(ok: boolean, output: string) {
    this.frame("tests", { ok, output: clean(output, LIMITS.output) });
  }
  commit(message: string, sha: string | null) {
    this.frame("commit", { message: clean(message, LIMITS.small), sha: sha ? sha.slice(0, 7) : null });
  }
  end(endReason: string, tests: string, commits: number) {
    this.frame("end", { endReason, tests, commits });
  }
}
