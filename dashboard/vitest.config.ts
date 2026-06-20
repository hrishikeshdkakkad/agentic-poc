import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` throws when imported outside a Next server build; alias it
      // to an empty shim so server modules can be imported in the node test env.
      "server-only": path.resolve(__dirname, "src/test/server-only.ts"),
    },
  },
  test: { environment: "node" },
});
