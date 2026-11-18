import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { join } from "node:path";
export default defineConfig({ cacheDir: join(tmpdir(), "self-improve-vite"), test: { include: ["test/**/*.test.{ts,tsx}"], testTimeout: 10000 } });
