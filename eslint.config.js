import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "skills", "data", "coverage", "**/dist"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    // Browser scripts served by apps/web.
    files: ["apps/web/public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        location: "readonly",
        fetch: "readonly",
        matchMedia: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        EventSource: "readonly",
        IntersectionObserver: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        btoa: "readonly",
        atob: "readonly",
        crypto: "readonly",
        navigator: "readonly",
        Event: "readonly",
        sessionStorage: "readonly",
        FileReader: "readonly",
        Date: "readonly",
      },
    },
  },
  {
    files: ["packages/core/**", "packages/db/**"],
    rules: {
      // core and db never import from apps
      "no-restricted-imports": ["error", { patterns: ["**/apps/**"] }],
    },
  },
);
