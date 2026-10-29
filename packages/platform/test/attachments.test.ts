import { describe, expect, it } from "vitest";
import { FakeClock } from "@devagent/core";
import { createAgent, migrate, openDb } from "@devagent/db";
import { ATTACH, bindAttachments, listAttachments, saveAttachment } from "../src/attachments";

// Creator uploads are untrusted bytes: the type comes from the content, names are cleaned, text is secret scanned.
const setup = () => {
  const clock = new FakeClock(Date.UTC(2026, 9, 29));
  const db = openDb(":memory:");
  migrate(db, clock);
  return { clock, db };
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from("%PDF-1.7\n%...");

describe("creator attachments", () => {
  it("accepts screenshots, PDFs and text docs, typed by their bytes, with clean names", () => {
    const { db, clock } = setup();
    const shot = saveAttachment(db, clock, "My Screen Shot (1).PNG", PNG);
    expect(shot).toMatchObject({ ok: true, name: "my-screen-shot-1.png", mime: "image/png", kind: "image" });
    expect(saveAttachment(db, clock, "spec.pdf", PDF)).toMatchObject({ ok: true, mime: "application/pdf", kind: "binary" });
    expect(saveAttachment(db, clock, "notes.md", Buffer.from("# Notes\nBuild a todo app."))).toMatchObject({ ok: true, kind: "text" });
    expect(saveAttachment(db, clock, "../../etc/passwd.txt", Buffer.from("hi"))).toMatchObject({ ok: true, name: "passwd.txt" });
  });

  it("refuses files whose bytes do not match an allowed type", () => {
    const { db, clock } = setup();
    expect(saveAttachment(db, clock, "shot.png", Buffer.from("not an image")).ok).toBe(false);
    expect(saveAttachment(db, clock, "app.exe", Buffer.from("MZ\x90\x00")).ok).toBe(false);
    expect(saveAttachment(db, clock, "page.html", Buffer.from("<script>alert(1)</script>")).ok).toBe(false);
    expect(saveAttachment(db, clock, "x.svg", Buffer.from("<svg onload=alert(1)>")).ok).toBe(false);
    expect(saveAttachment(db, clock, "bin.txt", Buffer.from([0x61, 0x00, 0x62])).ok).toBe(false); // NUL: not text
    expect(saveAttachment(db, clock, "empty.md", Buffer.alloc(0)).ok).toBe(false);
  });

  it("enforces size limits and refuses text that holds a secret", () => {
    const { db, clock } = setup();
    expect(saveAttachment(db, clock, "big.md", Buffer.alloc(ATTACH.maxTextBytes + 1, 0x61)).ok).toBe(false);
    expect(saveAttachment(db, clock, "big.png", Buffer.concat([PNG, Buffer.alloc(ATTACH.maxBinaryBytes)])).ok).toBe(false);
    const leak = saveAttachment(db, clock, "env.txt", Buffer.from("token ghp_" + "a".repeat(36)));
    expect(leak).toMatchObject({ ok: false });
  });

  it("binds uploads to one agent once, with a count limit, and lists them", () => {
    const { db, clock } = setup();
    const a = createAgent(db, clock, { name: "a", model: "opus", lockedPrompt: "x".repeat(30) }).id;
    const b = createAgent(db, clock, { name: "b", model: "opus", lockedPrompt: "x".repeat(30) }).id;
    const ids = [1, 2].map((i) => (saveAttachment(db, clock, `n${i}.md`, Buffer.from("hello")) as { id: string }).id);
    expect(bindAttachments(db, a, ids)).toEqual({ ok: true });
    expect(bindAttachments(db, b, ids).ok).toBe(false); // already taken by agent a
    expect(listAttachments(db, a).map((f) => f.name)).toEqual(["n1.md", "n2.md"]);
    const many = Array.from({ length: ATTACH.maxFiles + 1 }, (_, i) => (saveAttachment(db, clock, `m${i}.md`, Buffer.from("x")) as { id: string }).id);
    expect(bindAttachments(db, b, many).ok).toBe(false);
    expect(bindAttachments(db, b, ["nope"]).ok).toBe(false);
  });

  it("keeps duplicate names apart within one agent", () => {
    const { db, clock } = setup();
    const a = createAgent(db, clock, { name: "a", model: "opus", lockedPrompt: "x".repeat(30) }).id;
    const ids = [1, 2].map(() => (saveAttachment(db, clock, "shot.png", PNG) as { id: string }).id);
    bindAttachments(db, a, ids);
    expect(listAttachments(db, a).map((f) => f.name)).toEqual(["shot.png", "shot-2.png"]);
  });
});
