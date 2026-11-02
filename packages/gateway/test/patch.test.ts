import { describe, expect, it } from "vitest";
import { badPath, inspectPatch } from "../src/patch";

// The path allowlist is only as good as the parser: any header it cannot read must fail closed.
const file = (path: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;

describe("patch inspection", () => {
  it("lists the paths of plain patches", () => {
    const i = inspectPatch(file("src/a.js") + file("test/a.test.js"));
    expect(i.files.sort()).toEqual(["src/a.js", "test/a.test.js"]);
    expect(i.unparsed).toBe(false);
  });

  it("fails closed on quoted paths, which git writes for non-ASCII or special names", () => {
    const quoted =
      'diff --git "a/.github/workflows/\\303\\251.yml" "b/.github/workflows/\\303\\251.yml"\nnew file mode 100644\n--- /dev/null\n+++ "b/.github/workflows/\\303\\251.yml"\n@@ -0,0 +1 @@\n+on: push\n';
    expect(inspectPatch(quoted).unparsed).toBe(true);
    expect(inspectPatch(file("src/a.js") + quoted).unparsed).toBe(true); // one bad file taints the patch
  });

  it("fails closed on --- / +++ headers with an unexpected prefix", () => {
    const odd = "diff --git a/x.js b/x.js\n--- a/x.js\n+++ c/.env\n@@ -1 +1 @@\n-a\n+b\n";
    expect(inspectPatch(odd).unparsed).toBe(true);
  });

  it("reads rename and copy targets, and fails closed when they are quoted", () => {
    const rename = "diff --git a/ok.js b/.env\nsimilarity index 100%\nrename from ok.js\nrename to .env\n";
    const i = inspectPatch(rename);
    expect(i.files).toContain(".env");
    expect(badPath(".env")).toBeTruthy();
    expect(inspectPatch('diff --git a/x b/y\ncopy from x\ncopy to "\\303\\251"\n').unparsed).toBe(true);
  });

  it("does not mistake changed lines that start with --- or +++ for headers", () => {
    const content = "diff --git a/n.md b/n.md\n--- a/n.md\n+++ b/n.md\n@@ -1,2 +1,2 @@\n--- old rule\n+++ new rule\n";
    const i = inspectPatch(content);
    expect(i.unparsed).toBe(false);
    expect(i.files).toEqual(["n.md"]);
  });

  it("still flags symlinks", () => {
    expect(inspectPatch("diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n").symlink).toBe(true);
  });
});
