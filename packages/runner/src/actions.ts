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

/**
 * Some open models answer in their native tool call markup instead of JSON:
 * <tool_call>read_file<arg_key>path</arg_key><arg_value>a.js</arg_value></tool_call>
 * The first such call becomes the same plain object a JSON answer would give; the schema below still decides.
 */
export function extractToolCallMarkup(text: string): Record<string, string> | null {
  const m = /<tool_call>\s*([a-z_]+)([\s\S]*?)<\/tool_call>/.exec(text);
  if (!m) return null;
  const out: Record<string, string> = { action: m[1]! };
  for (const a of m[2]!.matchAll(/<arg_key>\s*([a-z_]+)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g))
    if (a[1] !== "action") out[a[1]!] = a[2]!;
  return out;
}

export function parseAction(
  text: string,
): { ok: true; action: Action } | { ok: false; error: string } {
  // Markup first: a write_file call's code holds braces that would fool the JSON finder.
  let raw: unknown = extractToolCallMarkup(text);
  const json = raw ? null : extractJson(text);
  if (!json && !raw) return { ok: false, error: "no JSON object found" };
  if (json)
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
