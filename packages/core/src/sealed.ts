import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

/**
 * Sealed boxes (x25519 + AES-256-GCM). Anyone holding the public key can seal; only the private key opens.
 * The web server holds the public key only, so it can create agent wallets and store tokens it can never read back.
 * The private key lives in the gateway process (orchestrator) and the operator CLI.
 */
export interface SealKeys {
  publicKey: string;
  privateKey: string;
}
export class SealError extends Error {}

const der = (k: KeyObject) => k.export({ type: "spki", format: "der" });
const pub = (b64: string) =>
  createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });

export function generateSealKeys(): SealKeys {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: der(publicKey).toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

const kdf = (shared: Buffer, eph: Buffer, recipient: Buffer) =>
  createHash("sha256")
    .update("devagent-seal:v1")
    .update(shared)
    .update(eph)
    .update(recipient)
    .digest();

export function seal(publicKey: string, plain: Uint8Array): string {
  let recipient: KeyObject;
  try {
    recipient = pub(publicKey);
  } catch {
    throw new SealError("invalid seal public key");
  }
  const e = generateKeyPairSync("x25519");
  const eph = der(e.publicKey);
  const key = kdf(diffieHellman({ privateKey: e.privateKey, publicKey: recipient }), eph, der(recipient));
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return ["v1", eph, iv, c.getAuthTag(), body].map((x) => (typeof x === "string" ? x : x.toString("base64"))).join(".");
}

export function openSealed(privateKey: string, sealed: string): Buffer {
  const [v, eph, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !eph || !iv || !tag || body === undefined) throw new SealError("bad sealed value");
  try {
    const p = createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
    const ephBytes = Buffer.from(eph, "base64");
    const shared = diffieHellman({ privateKey: p, publicKey: pub(eph) });
    const key = kdf(shared, ephBytes, der(createPublicKey(p)));
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]);
  } catch {
    throw new SealError("cannot open sealed value (wrong key or tampered)");
  }
}

/** Seal keys from the environment. The private half is optional: only the gateway side has it. */
export function sealKeysFromEnv(env: Record<string, string | undefined> = process.env) {
  return { publicKey: env.SEAL_PUBLIC_KEY || undefined, privateKey: env.SEAL_PRIVATE_KEY || undefined };
}
