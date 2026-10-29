import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "@devagent/core";
import type { Db } from "@devagent/db";
import { ATTACH, getAttachment, listAttachments, saveAttachment } from "@devagent/platform";

/**
 * Creator docs and screenshots: upload before deploy (raw body, name in a header), list per agent, download.
 * Downloads are inert: text always goes out as text/plain, PDFs as downloads, and every response is sandboxed,
 * so an uploaded file can never run script on this site.
 */
type Json = (req: IncomingMessage, res: ServerResponse, status: number, v: unknown) => void;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function createAttachmentRoutes(d: { db: Db; clock: Clock }) {
  return {
    path: "/api/attachment",
    rule: [40, 3_600_000] as [number, number],

    async upload(req: IncomingMessage, res: ServerResponse, json: Json) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host)
        return json(req, res, 403, { error: "Cross site requests are not allowed." });
      let name = "";
      try {
        name = decodeURIComponent(String(req.headers["x-file-name"] ?? "")).slice(0, 200);
      } catch {
        /* falls through to the empty name check */
      }
      if (!name) return json(req, res, 400, { error: "Missing file name." });
      const parts: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size <= ATTACH.maxBinaryBytes + 1) parts.push(c as Buffer);
      }
      if (size > ATTACH.maxBinaryBytes) return json(req, res, 413, { error: "That file is over 3 MB." });
      const out = saveAttachment(d.db, d.clock, name, Buffer.concat(parts));
      return out.ok ? json(req, res, 201, out) : json(req, res, 400, { error: out.reason });
    },

    /** GET handler for /files/:id and /api/agents/:id/files. Returns false when the path is not ours. */
    get(req: IncomingMessage, res: ServerResponse, path: string, json: Json): boolean {
      const list = /^\/api\/agents\/([0-9A-HJKMNP-TV-Z]{26})\/files$/.exec(path);
      if (list) {
        json(req, res, 200, { files: listAttachments(d.db, list[1]!).map((f) => ({ ...f, url: `/files/${f.id}` })) });
        return true;
      }
      const one = /^\/files\/([^/]+)$/.exec(path);
      if (!one) return false;
      const f = ULID.test(one[1]!) ? getAttachment(d.db, one[1]!) : undefined;
      if (!f || !f.agentId) {
        json(req, res, 404, { error: "File not found." }); // unbound uploads stay private until their agent exists
        return true;
      }
      const image = f.mime.startsWith("image/");
      res.writeHead(200, {
        "content-type": image || f.mime === "application/pdf" ? f.mime : "text/plain; charset=utf-8",
        "content-disposition": `${image ? "inline" : f.mime === "application/pdf" ? "attachment" : "inline"}; filename="${f.name}"`,
        "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=3600",
        "referrer-policy": "no-referrer",
      });
      res.end(req.method === "HEAD" ? undefined : f.bytes);
      return true;
    },
  };
}
export type AttachmentRoutes = ReturnType<typeof createAttachmentRoutes>;
