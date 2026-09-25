import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePrList } from "./gh.js";
import { buildBoard, clusterInputHash, effortMemberHash } from "./workstreams.js";
import { candidatesFrom } from "./enrich.js";
import type { RawUnit } from "./contract.js";
import plugin from "./server.js";

const model = vi.hoisted(() => vi.fn());
vi.mock("@typesafe-ai/sdk", async (original) => {
  const actual = await original<typeof import("@typesafe-ai/sdk")>();
  return { ...actual, TypeSafeClient: class { systemOne = model; } };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); model.mockReset(); });

function unit(ticket: string, title: string, number: number): RawUnit {
  return {
    path: `/p/folio-${ticket}`, dirName: `folio-${ticket}`, repo: "folio", githubRepo: "inkwell/folio", branch: ticket,
    dirty: false, ahead: 0, behind: 0, lastCommitAt: null, defaultBranch: "main", shipped: null, changedPaths: [],
    pr: parsePrList(JSON.stringify([{ number, url: `https://github.com/inkwell/folio/pull/${number}`, title, state: "OPEN", headRefName: ticket }]))!.pr,
  };
}

async function setup(response: "valid" | "incomplete" | "invalid" = "valid") {
  let units = [unit("ABC-1", "Correct clinician matching in enrollment", 1), unit("ABC-2", "Capture international phone numbers", 2)];
  model.mockImplementation(async ({ questions }: { questions: Record<string, unknown> }) => ({
    answers: response === "incomplete" ? {} : Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "score", score: response === "invalid" ? 5 : 0.17, confidence: 0.96 }])),
    usage: { input_tokens: 100, output_tokens: 10 },
  }));
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p", typesafeApiKey: "synthetic-test-value" }, sdk: {
    system: { config: async () => ({ primaryHostId: "host-inkwell" }) as never },
    projects: { list: async () => [] },
    threads: { list: async () => [], events: { list: async () => [] }, getPluginMetadata: async () => ({}) as never },
  }, experimental_callHostRpc: ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units, warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: [], discoveryComplete: true, complete: true, repositories: [], warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb); cleanups.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  const clusters = buildBoard(units, { pattern: /([A-Z]+)-(\d+)/giu, overrides: {}, linearProjects: {} }).flatMap((group) => group.clusters);
  const legacy = candidatesFrom(clusters)[0]!.legacyLabel!;
  for (const cluster of clusters) db.prepare(`INSERT INTO cluster_decisions (hash, summary, label, fit, updated_at) VALUES (?, ?, ?, ?, ?)`).run(clusterInputHash(cluster), cluster.units[0]!.pr!.title, legacy, 1, 0);
  db.prepare(`INSERT INTO effort_names (member_hash, name, updated_at, level, cohesion, cohesion_reason) VALUES (?, ?, ?, ?, ?, ?)`).run(effortMemberHash(clusters), "Enrollment improvements", 0, "effort", "mixed", "Phone capture and clinician matching deliver separate outcomes.");
  const refresh = async () => {
    const result = await harness.runCli(["refresh"]);
    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
  };
  const repairs = () => db.prepare(`SELECT ticket, label, hash, evidence FROM grouping_repairs ORDER BY ticket`).all();
  return { refresh, repairs, db, changeStatus: () => { units = units.map((one) => ({ ...one, ahead: 2, pr: { ...one.pr!, state: "MERGED" } })); } };
}

describe("membership repair persistence through server refresh", () => {
  it("migrates legacy candidates without a full regroup, persists a split, and keeps unchanged/status scans zero-call", async () => {
    const { refresh, repairs, db, changeStatus } = await setup();
    await refresh();
    expect(model).toHaveBeenCalledTimes(1);
    expect(Object.keys(model.mock.calls[0]![0].questions)).toEqual(["p0_1"]);
    const saved = repairs() as { ticket: string; label: string; hash: string; evidence: string }[];
    expect(saved.map((row) => row.ticket)).toEqual(["ABC-1", "ABC-2"]);
    expect(new Set(saved.map((row) => row.label)).size).toBe(2);
    expect(saved.every((row) => row.evidence.length > 0)).toBe(true);
    expect((db.prepare(`SELECT label FROM cluster_decisions`).all() as { label: string }[]).every((row) => row.label.startsWith("seed:"))).toBe(true);
    await refresh();
    expect(model).toHaveBeenCalledTimes(1);
    expect(repairs()).toEqual(saved);
    changeStatus();
    await refresh();
    expect(model).toHaveBeenCalledTimes(1);
    expect(repairs()).toEqual(saved);
  });

  it.each(["incomplete", "invalid"] as const)("does not persist %s membership or cache a failed review as complete", async (response) => {
    const { refresh, repairs } = await setup(response);
    await refresh();
    expect(model).toHaveBeenCalledTimes(1);
    expect(repairs()).toEqual([]);
    await refresh();
    expect(model).toHaveBeenCalledTimes(2);
    expect(repairs()).toEqual([]);
  });
});
