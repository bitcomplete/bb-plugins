import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // app.tsx's "@/" imports, as tsconfig's paths map them, so a test can render its rows.
  resolve: { alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }] },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
