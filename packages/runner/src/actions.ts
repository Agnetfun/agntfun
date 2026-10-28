import { z } from "zod";

const path = z.string().min(1).max(300);

export const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read_file"), path }),
  z.object({ action: z.literal("write_file"), path, content: z.string().max(200_000) }),
  z.object({ action: z.literal("list_dir"), path: path.default(".") }),
  z.object({ action: z.literal("run_tests") }),
  z.object({ action: z.literal("commit"), message: z.string().min(1).max(200) }),
  z.object({ action: z.literal("finish"), summary: z.string().min(1).max(1000) }),
]);

export type Action = z.infer<typeof ActionSchema>;

/** Finds the first balanced JSON object in model output (tolerates fences and chatter). */
export function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function parseAction(
  text: string,
): { ok: true; action: Action } | { ok: false; error: string } {
  const json = extractJson(text);
  if (!json) return { ok: false, error: "no JSON object found" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const r = ActionSchema.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  return { ok: true, action: r.data };
}
