import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createWebServer } from "../src/server";
import { seed } from "./seed";

// Scaled soak: many live viewers while data keeps changing. SOAK_SECONDS=3600 runs the full hour (pnpm soak).
const seconds = Number(process.env.SOAK_SECONDS) || 5;
const VIEWERS = 300;

describe("soak", () => {
  it(
    `${VIEWERS} viewers for ${seconds}s: everyone gets updates, nothing leaks`,
    async () => {
      const s = await seed();
      const web = createWebServer({
        db: s.db,
        treasury: s.treasury,
        pollMs: 100,
        maxStreams: 1000,
        maxStreamsPerClient: 1000,
      });
      await new Promise<void>((r) => web.server.listen(0, "127.0.0.1", r));
      const port = (web.server.address() as AddressInfo).port;
      const counts = new Array<number>(VIEWERS).fill(0);
      const reqs = Array.from({ length: VIEWERS }, (_, i) => {
        const q = request({ host: "127.0.0.1", port, path: "/api/stream" }, (res) => {
          res.setEncoding("utf8");
          res.on("data", (c: string) => (counts[i]! += (c.match(/event: change/g) ?? []).length));
        });
        q.end();
        return q;
      });
      const t0 = Date.now();
      while (web.streams() < VIEWERS && Date.now() - t0 < 5000)
        await new Promise((r) => setTimeout(r, 20));
      expect(web.streams()).toBe(VIEWERS);
      if (global.gc) global.gc();
      const heap0 = process.memoryUsage().heapUsed;
      let writes = 0;
      const end = Date.now() + seconds * 1000;
      while (Date.now() < end) {
        s.treasury.topUp(s.good, 1, `soak${writes++}`);
        await new Promise((r) => setTimeout(r, 50));
        // regular readers, like page loads
        if (writes % 10 === 0)
          await fetch(`http://127.0.0.1:${port}/api/agents`).then((r) => r.text());
      }
      await new Promise((r) => setTimeout(r, 400));
      expect(Math.min(...counts)).toBeGreaterThan(Math.min(writes / 4, 5));
      for (const q of reqs) q.destroy();
      const t1 = Date.now();
      while (web.streams() > 0 && Date.now() - t1 < 5000)
        await new Promise((r) => setTimeout(r, 20));
      expect(web.streams()).toBe(0);
      if (global.gc) global.gc();
      const growthMb = (process.memoryUsage().heapUsed - heap0) / 1e6;
      expect(growthMb).toBeLessThan(60);
      web.close();
    },
    (seconds + 30) * 1000 + 3_600_000 * (seconds > 600 ? 1 : 0),
  );
});
