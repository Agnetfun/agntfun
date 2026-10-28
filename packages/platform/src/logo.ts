import type { Clock } from "@devagent/core";
import { ulid } from "@devagent/core";
import type { Db } from "@devagent/db";

// Big enough for any coin logo (pump.fun shows them small); stored in SQLite, so keep it bounded.
export const MAX_LOGO_BYTES = 5 * 1024 * 1024;
export const MAX_LOGO_TEXT = "5 MB";
export type LogoMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/**
 * Decides the type from the file's own first bytes, never from the name or the header the browser sent.
 * SVG is refused on purpose: it can carry script. Only four raster formats are accepted.
 */
export function sniffImage(b: Uint8Array): LogoMime | undefined {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length < 16) return undefined;
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61)
    return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

export type LogoResult = { ok: true; id: string } | { ok: false; reason: string };

export function saveLogo(db: Db, clock: Clock, bytes: Uint8Array): LogoResult {
  if (bytes.length > MAX_LOGO_BYTES) return { ok: false, reason: `The image is over ${MAX_LOGO_TEXT}.` };
  const mime = sniffImage(bytes);
  if (!mime) return { ok: false, reason: "Use a PNG, JPG, WebP or GIF image." };
  const id = ulid(clock.now());
  db.prepare("INSERT INTO logos (id, mime, bytes, created_at) VALUES (?,?,?,?)").run(
    id,
    mime,
    bytes,
    clock.now(),
  );
  return { ok: true, id };
}

export function getLogo(db: Db, id: string): { mime: LogoMime; bytes: Buffer } | undefined {
  const r = db.prepare("SELECT mime, bytes FROM logos WHERE id=?").get(id) as
    { mime: LogoMime; bytes: Uint8Array } | undefined;
  return r ? { mime: r.mime, bytes: Buffer.from(r.bytes) } : undefined;
}
