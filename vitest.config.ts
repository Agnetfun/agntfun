import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{packages,apps,scripts}/**/test/**/*.test.ts"],
    // The pump.fun SDK pulls CommonJS anchor packages that Node's native ESM loader cannot name-import.
    server: { deps: { inline: [/@pump-fun/, /@coral-xyz/] } },
  },
});
