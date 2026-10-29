import { scanText, ulid, type Clock } from "@devagent/core";
import type { Db } from "@devagent/db";

/**
 * Files a creator attaches to an agent's brief: docs (text, committed to the agent's repo) and screenshots or PDFs
 * (kept beside the repo for the agent to open, shown on the agent page, never pushed). Uploads are untrusted: the type
 * comes from the bytes, not the name; names are cleaned; text must be UTF-8 and is secret scanned. Unbound uploads
 * expire after a day so the table cannot be filled from outside.
 */
export const ATTACH = {
  maxFiles: 10,
  maxTextBytes: 200_000,
  maxBinaryBytes: 3_000_000,
  maxTotalBytes: 15_000_000,
  unboundTtlMs: 24 * 3_600_000,
};

export type AttachmentKind = "text" | "image" | "binary";
export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
}
type Saved = ({ ok: true } & AttachmentMeta) | { ok: false; reason: string };

const TEXT_EXT: Record<string, string> = { md: "text/markdown", txt: "text/plain", json: "application/json", csv: "text/csv" };
const kindOf = (mime: string): AttachmentKind =>
  mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "binary" : "text";

/** The real type, from magic bytes for binaries and a strict UTF-8 check for text. */
function sniff(bytes: Buffer, ext: string): { mime: string; ext: string } | null {
  const head = (n: number) => bytes.subarray(0, n);
  if (head(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (head(3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: "image/jpeg", ext: "jpg" };
  if (head(4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (head(5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (!TEXT_EXT[ext] || bytes.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return { mime: TEXT_EXT[ext]!, ext };
}

/** Base name only, lower case, safe characters; the extension follows the real type. */
function cleanName(raw: string, ext: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "");
  const stem = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "file";
  return `${stem}.${ext}`;
}

export function saveAttachment(db: Db, clock: Clock, rawName: string, bytes: Buffer): Saved {
  db.prepare("DELETE FROM attachments WHERE agent_id IS NULL AND created_at < ?").run(clock.now() - ATTACH.unboundTtlMs);
  if (!bytes.length) return { ok: false, reason: "The file is empty." };
  const ext = (/\.([a-z0-9]+)$/i.exec(rawName)?.[1] ?? "").toLowerCase();
  const t = sniff(bytes, ext);
  if (!t) return { ok: false, reason: "Only PNG, JPG, WebP, PDF, Markdown, text, JSON or CSV files." };
  const kind = kindOf(t.mime);
  const max = kind === "text" ? ATTACH.maxTextBytes : ATTACH.maxBinaryBytes;
  if (bytes.length > max) return { ok: false, reason: `That file is over ${kind === "text" ? "200 KB" : "3 MB"}.` };
  if (kind === "text" && scanText(bytes.toString("utf8")).length)
    return { ok: false, reason: "That file looks like it contains a secret. Remove it." };
  const id = ulid(clock.now());
  const name = cleanName(rawName, t.ext);
  db.prepare("INSERT INTO attachments (id, agent_id, name, mime, bytes, created_at) VALUES (?,NULL,?,?,?,?)").run(
    id, name, t.mime, bytes, clock.now(),
  );
  return { ok: true, id, name, mime: t.mime, kind, size: bytes.length };
}

/** Attaches uploads to a new agent. Each upload can belong to one agent only; names are made unique per agent. */
export function bindAttachments(db: Db, agentId: string, ids: string[]): { ok: true } | { ok: false; reason: string } {
  const unique = [...new Set(ids)];
  if (unique.length > ATTACH.maxFiles) return { ok: false, reason: `At most ${ATTACH.maxFiles} files.` };
  const rows = unique.map(
    (id) => db.prepare("SELECT id, name, agent_id, length(bytes) size FROM attachments WHERE id=?").get(id) as
      { id: string; name: string; agent_id: string | null; size: number } | undefined,
  );
  if (rows.some((r) => !r || r.agent_id)) return { ok: false, reason: "An attached file was not found. Upload it again." };
  if (rows.reduce((t, r) => t + r!.size, 0) > ATTACH.maxTotalBytes) return { ok: false, reason: "The files are over 15 MB in total." };
  const taken = new Set(listAttachments(db, agentId).map((f) => f.name));
  for (const r of rows) {
    let name = r!.name;
    for (let n = 2; taken.has(name); n++) name = r!.name.replace(/(\.[a-z0-9]+)$/, `-${n}$1`);
    taken.add(name);
    db.prepare("UPDATE attachments SET agent_id=?, name=? WHERE id=?").run(agentId, name, r!.id);
  }
  return { ok: true };
}

export function listAttachments(db: Db, agentId: string): AttachmentMeta[] {
  return (
    db.prepare("SELECT id, name, mime, length(bytes) size FROM attachments WHERE agent_id=? ORDER BY rowid").all(agentId) as
      { id: string; name: string; mime: string; size: number }[]
  ).map((r) => ({ ...r, kind: kindOf(r.mime) }));
}

export function getAttachment(db: Db, id: string): { name: string; mime: string; bytes: Buffer; agentId: string | null } | undefined {
  const r = db.prepare("SELECT name, mime, bytes, agent_id FROM attachments WHERE id=?").get(id) as
    { name: string; mime: string; bytes: Uint8Array; agent_id: string | null } | undefined;
  return r && { name: r.name, mime: r.mime, bytes: Buffer.from(r.bytes), agentId: r.agent_id };
}
