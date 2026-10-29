import { scanText, ulid, MODEL_CHOICES, type Clock, type ModelChoice } from "@devagent/core";
import { createAgent, sha256, type Db } from "@devagent/db";
import { verifyWalletSignature } from "@devagent/community";
import { checkPost, checkPrompt } from "@devagent/safety";
import { ATTACH, bindAttachments } from "./attachments";

export interface DeployRequest {
  name: string;
  model: string;
  brief: string;
  wallet: string;
  signature: string;
  nonce: string;
  ts: number;
  ticker?: string;
  description?: string;
  xHandle?: string;
  logoId?: string;
  /** Uploaded docs and screenshots (see attachments.ts), bound to the agent on deploy. */
  attachmentIds?: string[];
}
/** A brief can be a full spec: up to 10,000 words. Only its start rides in every prompt; the rest is in BRIEF.md. */
export const BRIEF = { minChars: 20, maxChars: 60_000, maxWords: 10_000 };
export const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
export interface DeployOptions {
  /** GitHub organisation that holds agent repositories. Repository creation itself is the gateway's job (TODO(verify)). */
  org: string;
  maxPerWallet: number;
  maxAgeMs: number;
}
export const DEFAULT_DEPLOY: DeployOptions = {
  org: "devagent-agents",
  maxPerWallet: 3,
  maxAgeMs: 10 * 60_000,
};
export type DeployResult =
  { ok: true; agentId: string; repo: string } | { ok: false; reason: string };

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ]{1,30}[A-Za-z0-9]$/;
const RESERVED = [
  "devagent",
  "admin",
  "operator",
  "official",
  "support",
  "pump",
  "pumpfun",
  "anthropic",
  "openai",
];

/**
 * What the deployer signs. Binds the name, model, exact brief and (when present) the exact attached files, so none of
 * them can be swapped after signing.
 */
export const deployMessage = (
  r: Pick<DeployRequest, "name" | "model" | "brief" | "nonce" | "ts" | "attachmentIds">,
) =>
  `devagent-deploy:v1:${r.name}:${r.model}:${sha256(r.brief)}:${r.nonce}:${r.ts}` +
  (r.attachmentIds?.length ? `:files:${sha256(r.attachmentIds.join(","))}` : "");

export function deployAgent(
  db: Db,
  clock: Clock,
  r: DeployRequest,
  o: DeployOptions = DEFAULT_DEPLOY,
): DeployResult {
  const no = (reason: string): DeployResult => ({ ok: false, reason });
  if (typeof r.name !== "string" || !NAME.test(r.name.trim()))
    return no("Name must be 3 to 32 letters, numbers or spaces.");
  const name = r.name.trim();
  if (RESERVED.some((x) => name.toLowerCase().replace(/\s/g, "").includes(x)))
    return no("That name is reserved.");
  if (!checkPost(name).ok) return no("That name is not allowed.");
  if (!(MODEL_CHOICES as readonly string[]).includes(r.model))
    return no("Pick Claude Opus 5.5 or GPT 6 Astra.");
  if (typeof r.brief !== "string" || r.brief.trim().length < BRIEF.minChars || r.brief.length > BRIEF.maxChars)
    return no("The brief must be 20 to 60,000 characters.");
  if (wordCount(r.brief) > BRIEF.maxWords) return no("The brief is over 10,000 words.");
  const bad = checkPrompt(r.brief);
  if (!bad.ok) return no("The brief asks for something this platform does not allow.");
  if (scanText(r.brief).length) return no("The brief looks like it contains a secret. Remove it.");
  const ticker =
    (r.ticker ?? "").trim().toUpperCase() ||
    name
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 6)
      .toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(ticker)) return no("Ticker must be 2 to 10 letters or numbers.");
  const description = (r.description ?? "").trim();
  if (description.length > 280) return no("The description is over 280 characters.");
  if (description && (!checkPost(description).ok || scanText(description).length))
    return no("That description is not allowed.");
  const xHandle = (r.xHandle ?? "").trim().replace(/^@/, "");
  if (xHandle && !/^[A-Za-z0-9_]{1,15}$/.test(xHandle)) return no("That X handle is not valid.");
  if (r.logoId) {
    const l = db.prepare("SELECT 1 x FROM logos WHERE id=?").get(r.logoId);
    if (!l) return no("The logo upload was not found. Upload it again.");
    if (db.prepare("SELECT 1 x FROM agents WHERE logo_id=?").get(r.logoId))
      return no("That logo is already in use.");
  }
  const files = r.attachmentIds ?? [];
  if (files.length > ATTACH.maxFiles) return no(`At most ${ATTACH.maxFiles} files.`);
  for (const f of files)
    if (!db.prepare("SELECT 1 x FROM attachments WHERE id=? AND agent_id IS NULL").get(f))
      return no("An attached file was not found. Upload it again.");
  const now = clock.now();
  if (!Number.isFinite(r.ts) || now - r.ts > o.maxAgeMs || r.ts - now > 60_000)
    return no("The signed request is too old. Sign again.");
  if (typeof r.nonce !== "string" || !/^[A-Za-z0-9]{8,64}$/.test(r.nonce))
    return no("Missing or invalid nonce.");
  if (!verifyWalletSignature(r.wallet, deployMessage({ ...r, name }), r.signature))
    return no("The signature does not match this wallet.");
  const owned = db
    .prepare("SELECT COUNT(*) c FROM agents WHERE deployer=? AND removed_at IS NULL")
    .get(r.wallet) as { c: number };
  if (owned.c >= o.maxPerWallet) return no(`One wallet can run at most ${o.maxPerWallet} agents.`);
  if (db.prepare("SELECT 1 x FROM agents WHERE lower(name)=lower(?)").get(name))
    return no("That name is taken.");
  try {
    db.prepare("INSERT INTO deploy_nonces (nonce, ts) VALUES (?,?)").run(r.nonce, now);
  } catch {
    return no("This request was already used.");
  }
  const id = ulid(now);
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  const repo = `${o.org}/${slug}-${id.slice(-4).toLowerCase()}`;
  const a = createAgent(db, clock, {
    name,
    model: r.model as ModelChoice,
    lockedPrompt: r.brief.trim(),
    repo,
    xHandle: xHandle || undefined,
  });
  db.prepare("UPDATE agents SET deployer=?, ticker=?, description=?, logo_id=? WHERE id=?").run(
    r.wallet,
    ticker,
    description,
    r.logoId ?? null,
    a.id,
  );
  if (files.length) {
    const bound = bindAttachments(db, a.id, files);
    if (!bound.ok) return no(bound.reason); // checked above; only a race between two deploys lands here
  }
  return { ok: true, agentId: a.id, repo };
}
