import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import entry from "./host.js";

vi.mock("@get-bb/plugin-sdk/host", () => ({ experimental_defineHostEntry: (entry: unknown) => entry }));
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, homedir: () => process.env.WORKSTREAMS_TEST_HOME ?? actual.homedir() };
});

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

it("creates distinct durable non-Git context directories outside BB's managed storage", async () => {
  const home = await mkdtemp(join(tmpdir(), "inkwell-workstreams-home-"));
  homes.push(home);
  vi.stubEnv("WORKSTREAMS_TEST_HOME", home);
  const dataDir = join(home, ".bb", "plugins", "workstreams", "host-data");
  const context = { experimental_paths: { dataDir, tempDir: join(home, ".bb", "plugins", "workstreams", "host-temp") } };
  {
    const first = await entry.handlers.contextWorkspace({}, context as never);
    const second = await entry.handlers.contextWorkspace({}, context as never);
    const root = join(await realpath(home), ".local", "share", "bb-workstreams", "contexts");
    for (const { path } of [first, second]) {
      expect(path).toBe(await realpath(path));
      expect(relative(root, path)).toMatch(/^[0-9a-f-]{36}$/u);
      expect(path.startsWith(`${join(await realpath(home), ".bb")}/`)).toBe(false);
      expect((await stat(path)).isDirectory()).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o700);
      await expect(stat(join(path, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(first.path).not.toBe(second.path);
  }
});
