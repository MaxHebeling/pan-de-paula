import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `server-only` lanza fuera de React Server Components; en tests lo neutralizamos.
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
