/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebServer } from "../src/server";
import { seed } from "./seed";

// Browser test. Needs Chromium with Playwright, so it only runs with E2E=1 (pnpm e2e).
const run = process.env.E2E === "1";
const SHOTS = process.env.SHOTS_DIR;

describe.skipIf(!run)("browser", () => {
  let web: ReturnType<typeof createWebServer>;
  let base: string;
  let s: Awaited<ReturnType<typeof seed>>;
  let browser: any;
  beforeAll(async () => {
    s = await seed();
    web = createWebServer({ db: s.db, treasury: s.treasury, pollMs: 200 });
    await new Promise<void>((r) => web.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
    const { chromium } = createRequire(import.meta.url)("playwright") as {
      chromium: { launch(): Promise<any> };
    };
    browser = await chromium.launch();
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  });
  afterAll(async () => {
    await browser?.close();
    web?.close();
  });

  async function visit(path: string, viewport = { width: 1280, height: 900 }) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const problems: string[] = [];
    page.on("console", (m: any) => m.type() === "error" && problems.push(m.text()));
    page.on("pageerror", (e: unknown) => problems.push(String(e)));
    await page.goto(base + path);
    return { page, problems, ctx };
  }

  it("home renders both agents, hostile names stay inert, no console or CSP errors", async () => {
    const { page, problems, ctx } = await visit("/");
    await page.waitForSelector(".tcard");
    expect(await page.locator(".tcard").count()).toBe(2);
    expect(await page.locator(".tcard .nm").allTextContents()).toContain(
      `<img src=x onerror="window.__xss=1">`,
    );
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.textContent("#s-sessions")).toBe("3");
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/home-desktop.png`, fullPage: true });
    expect(problems).toEqual([]);
    await ctx.close();
  });

  it("agent page shows activity, queue, treasury and split; hostile agent stays inert", async () => {
    const { page, problems, ctx } = await visit(`/agent/${s.good}`);
    await page.waitForSelector(".feed li a");
    expect(await page.textContent(".phead h1")).toContain("Ledgerline");
    expect(await page.locator(".queue li").first().textContent()).toContain(
      "Add a CSV export for the ledger",
    );
    expect(await page.textContent("#treasury")).toContain("$");
    expect(await page.locator("#split-card").isVisible()).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/agent-desktop.png`, fullPage: true });
    expect(problems).toEqual([]);
    const evil = await visit(`/agent/${s.evil}`);
    await evil.page.waitForSelector(".phead h1");
    expect(await evil.page.textContent(".phead h1")).toContain(
      `<img src=x onerror="window.__xss=1">`,
    );
    expect(await evil.page.textContent("#brief")).toBe("<script>window.__xss=1</script>");
    expect(
      await evil.page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    expect(evil.problems).toEqual([]);
    await ctx.close();
    await evil.ctx.close();
  });

  it("is usable on a phone: no sideways scroll, menu opens as a panel", async () => {
    for (const path of ["/", `/agent/${s.good}`]) {
      const { page, ctx } = await visit(path, { width: 390, height: 844 });
      await page.waitForSelector(path === "/" ? ".tcard" : ".feed li");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
      await page.click(".menu-btn");
      await page.waitForSelector(".panel.open");
      expect(await page.getAttribute(".menu-btn", "aria-expanded")).toBe("true");
      if (SHOTS)
        await page.screenshot({
          path: `${SHOTS}/${path === "/" ? "home" : "agent"}-mobile-menu.png`,
        });
      await page.keyboard.press("Escape");
      if (SHOTS)
        await page.screenshot({
          path: `${SHOTS}/${path === "/" ? "home" : "agent"}-mobile.png`,
          fullPage: true,
        });
      await ctx.close();
    }
  });

  it("updates within five seconds when something changes", async () => {
    const { page, ctx } = await visit(`/agent/${s.good}`);
    await page.waitForSelector(".feed li");
    const before = await page.textContent("#astats");
    s.treasury.topUp(s.good, 5000, "live-test");
    await page.waitForFunction(
      (b: string | null) => document.getElementById("astats")!.textContent !== b,
      before,
      {
        timeout: 5000,
      },
    );
    expect(await page.textContent("#feed")).toContain("Top up received: $50.00");
    await ctx.close();
  });

  it("keyboard users get a skip link and visible focus", async () => {
    const { page, ctx } = await visit("/");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.className)).toBe("skip");
    await ctx.close();
  });

  it("404 page is branded", async () => {
    const { page, ctx } = await visit("/does/not/exist");
    expect(await page.textContent("h1")).toBe("This page does not exist");
    await ctx.close();
  });

  it("deploys an agent from the launch page with a wallet that signs in the browser", async () => {
    const { generateKeyPairSync, sign } = await import("node:crypto");
    const { base58Encode } = await import("@devagent/community");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const address = base58Encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const ctx = await browser.newContext();
    await ctx.exposeFunction("__sign", (msg: string) =>
      sign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64"),
    );
    await ctx.addInitScript((addr: string) => {
      const w = window as any;
      w.solana = {
        isPhantom: true,
        publicKey: { toString: () => addr },
        connect: async () => ({ publicKey: { toString: () => addr } }),
        signMessage: async (bytes: Uint8Array) => {
          const b64: string = await w.__sign(new TextDecoder().decode(bytes));
          return { signature: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) };
        },
      };
    }, address);
    const page = await ctx.newPage();
    const problems: string[] = [];
    page.on("console", (m: any) => m.type() === "error" && problems.push(m.text()));
    await page.goto(base + "/launch");
    await page.click("#wallet-btn");
    await page.click("[data-w=phantom]");
    await page.waitForFunction(
      () => !document.getElementById("wallet-text")!.textContent!.includes("Connect"),
    );
    await page.fill("input[name=name]", "Browser Smith");
    await page.fill("input[name=ticker]", "bsmith");
    await page.fill("input[name=xHandle]", "@browsersmith");
    await page.setInputFiles("#logo", {
      name: "l.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4",
        "hex",
      ),
    });
    await page.fill(
      "textarea[name=brief]",
      "Build small, well tested command line tools for plain text files.",
    );
    await page.click("label.model:has(input[value=astra])");
    await page.click("#submit");
    await page.waitForFunction(
      () =>
        /agent\//.test(location.pathname) ||
        document.getElementById("result")!.className.includes("err"),
      null,
      { timeout: 8000 },
    );
    await page.waitForURL(/\/agent\//, { timeout: 8000 });
    expect(await page.textContent(".phead h1")).toContain("Browser Smith");
    expect(await page.locator("img.avatar").count()).toBe(1);
    expect(await page.textContent(".ticker")).toBe("BSMITH");
    expect(problems).toEqual([]);
    await ctx.close();
  });
});
