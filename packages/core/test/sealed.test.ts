import { describe, expect, it } from "vitest";
import { SealError, generateSealKeys, openSealed, seal } from "../src/sealed";

describe("sealed boxes", () => {
  const k = generateSealKeys();
  it("round trips with the private key", () => {
    const s = seal(k.publicKey, Buffer.from("secret value"));
    expect(openSealed(k.privateKey, s).toString()).toBe("secret value");
  });
  it("never repeats ciphertext for the same input", () => {
    expect(seal(k.publicKey, Buffer.from("x"))).not.toBe(seal(k.publicKey, Buffer.from("x")));
  });
  it("refuses another private key", () => {
    const s = seal(k.publicKey, Buffer.from("x"));
    expect(() => openSealed(generateSealKeys().privateKey, s)).toThrow(SealError);
  });
  it("refuses tampered ciphertext", () => {
    const parts = seal(k.publicKey, Buffer.from("hello world")).split(".");
    const body = Buffer.from(parts[4]!, "base64");
    body[0] = body[0]! ^ 1;
    parts[4] = body.toString("base64");
    expect(() => openSealed(k.privateKey, parts.join("."))).toThrow(SealError);
  });
  it("refuses garbage", () => {
    expect(() => openSealed(k.privateKey, "nope")).toThrow(SealError);
    expect(() => seal("not-a-key", Buffer.from("x"))).toThrow(SealError);
  });
});
