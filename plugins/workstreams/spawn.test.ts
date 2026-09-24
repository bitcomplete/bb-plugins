// The spawn path, against a fake SDK: nothing here reaches a live BB.
import { describe, expect, it } from "vitest";
import { projectForPath, startThread, type SpawnSdk } from "./spawn.js";

const PROJECTS = [
  { id: "prj_shelf", sources: [{ hostId: "host_a", path: "/p" }] },
  { id: "prj_folio", sources: [{ hostId: "host_b", path: "/p/folio-abc-101/" }] },
  { id: "prj_other", sources: [{ hostId: "host_a", path: "/elsewhere" }] },
];

function fakeSdk(projects = PROJECTS) {
  const spawned: Parameters<SpawnSdk["threads"]["spawn"]>[0][] = [];
  const sdk: SpawnSdk = {
    projects: { list: async () => projects },
    threads: {
      spawn: async (args) => {
        spawned.push(args);
        return { id: "thr_new" };
      },
    },
  };
  return { sdk, spawned };
}

describe("projectForPath", () => {
  it("picks the deepest project source that contains the checkout", () => {
    expect(projectForPath(PROJECTS, "/p/folio-abc-101")).toEqual({ projectId: "prj_folio", hostId: "host_b" });
    expect(projectForPath(PROJECTS, "/p/margin-abc-101")).toEqual({ projectId: "prj_shelf", hostId: "host_a" });
  });

  it("respects path boundaries and returns null when nothing contains the checkout", () => {
    expect(projectForPath(PROJECTS, "/px/quill")).toBeNull();
  });
});

describe("startThread", () => {
  const unit = { path: "/p/folio-abc-101", ticket: "ABC-101" };

  it("spawns in the checkout itself, seeds the cluster ticket as metadata, and names no provider or model", async () => {
    const { sdk, spawned } = fakeSdk();
    const result = await startThread(sdk, unit, "  Pick up folio #47.  ");
    expect(result).toEqual({ ok: true, threadId: "thr_new", ticket: "ABC-101" });
    expect(spawned).toEqual([
      {
        projectId: "prj_folio",
        environment: { type: "host", hostId: "host_b", workspace: { type: "unmanaged", path: "/p/folio-abc-101" } },
        prompt: "Pick up folio #47.",
        pluginMetadata: { ticket: "ABC-101" },
      },
    ]);
    expect(spawned[0]).not.toHaveProperty("providerId");
    expect(spawned[0]).not.toHaveProperty("model");
  });

  it("refuses, without spawning, when no BB project contains the checkout, rather than guessing one", async () => {
    const { sdk, spawned } = fakeSdk([PROJECTS[2]!]);
    const result = await startThread(sdk, unit, "Pick up folio #47.");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("No BB project contains /p/folio-abc-101");
    expect(spawned).toEqual([]);
  });

  it("refuses a checkout the last scan did not see, because the client only names a path", async () => {
    const { sdk, spawned } = fakeSdk();
    expect((await startThread(sdk, undefined, "go")).ok).toBe(false);
    expect(spawned).toEqual([]);
  });

  it("refuses an empty prompt", async () => {
    const { sdk, spawned } = fakeSdk();
    expect((await startThread(sdk, unit, "   ")).ok).toBe(false);
    expect(spawned).toEqual([]);
  });
});
