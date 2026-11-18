import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { Store } from "../src/store.js";
import { stableJson } from "../src/domain/shared.js";
import { defaultConfig } from "../src/config.js";
import { solution } from "./domain/fixtures.js";
import type { PublicationSummary } from "../src/publication-view.js";
import type { PublicationObservation } from "../src/publication-state.js";
import type { PerformancePoint } from "../src/ui/types.js";
const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../src/publish.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/publish.js")>(), githubTransport: () => transport }));
import plugin from "../server.js";

async function fixture() {
  transport.call.mockReset();
  const {bb,harness} = createFakePluginHost({pluginId:"self-improve",settings:{config:JSON.stringify({...defaultConfig(),publicationRepositories:["org/repo"]})}});
  await plugin(bb);
  const store = new Store(bb.storage.database());
  store.put("solutions", "canonical", {...solution("canonical"),aliases:["old"]});
  store.put("solutions", "other", solution("other"));
  return {store,harness};
}

describe("post-preview ledger wiring", () => {
  it("includes retained aliases in performance reads while preserving original rows and cost snapshots", async () => {
    const {store,harness} = await fixture();
    try {
      for (const [id,solutionId] of [["previous","old"],["current","canonical"],["outside","other"]]) {
        store.put("performance", id!, {id,solutionId,before:{endMs:100,votes:4,sessions:8},after:{endMs:200,votes:1,sessions:0},confounders:["historical fixture"],costs:[{currency:"USD",reportedMicros:7,estimatedMicros:3,unknownAttempts:1}]});
      }
      const original = store.entries("performance");
      const read = (solutionId:string) => harness.behavior.callRpc("performance",{solutionId}) as Promise<{points:PerformancePoint[]}>;
      const canonical = await read("canonical"), old = await read("old");
      expect(old).toEqual(canonical);
      expect(new Set(canonical.points.map(p=>p.solutionId))).toEqual(new Set(["old","canonical"]));
      expect(canonical.points.filter(p=>p.phase==="after").every(p=>p.rate===null)).toBe(true);
      expect(canonical.points.every(p=>p.costs[0]!.unknownAttempts===1)).toBe(true);
      expect(store.entries("performance")).toEqual(original);
      await expect(read("missing")).rejects.toThrow("unknown solution");
      expect(transport.call).not.toHaveBeenCalled();
    } finally { await harness.lifecycle.dispose(); }
  });

  it("loads publication history locally, checks only on request, and never calls a draft PR published", async () => {
    const {store,harness} = await fixture();
    try {
      const files = [{path:"README.md",content:"A measured instruction\n"}];
      const bundleSha256 = createHash("sha256").update(stableJson(files)).digest("hex");
      store.put("export-drafts","draft",{id:"draft",solutionId:"old",revision:"r1",files,bundleSha256});
      store.put("publications","publication",{id:"publication",draftId:"draft",repository:"org/repo",directory:"plugins/fix",bundleSha256,url:"https://github.com/org/repo/pull/7",status:"published"});
      const read = () => harness.behavior.callRpc("publications",{solutionId:"canonical"}) as Promise<{publications:PublicationSummary[]}>;
      const initial = await read();
      expect(initial.publications).toMatchObject([{solutionId:"old",submission:"submitted-for-review",latest:null}]);
      expect(await harness.behavior.callRpc("publicationHistory",{publicationId:"publication"})).toEqual({observations:[]});
      expect(transport.call).not.toHaveBeenCalled();
      transport.call.mockResolvedValue({number:7,state:"open",merged:false,head:{sha:"a".repeat(40)},merge_commit_sha:null});
      const observation = await harness.behavior.callRpc("reconcilePublication",{publicationId:"publication"}) as PublicationObservation;
      expect(transport.call.mock.calls).toEqual([["GET","repos/org/repo/pulls/7"]]);
      expect(observation).toMatchObject({review:{state:"open"},repository:{state:"unconfirmed"},release:{state:"not-requested"}});
      expect((await read()).publications[0]!.latest).toEqual(observation);
      expect(await harness.behavior.callRpc("publicationHistory",{publicationId:"publication"})).toEqual({observations:[observation]});
      expect(store.get<{status:string}>("publications","publication")?.status).toBe("published");
    } finally { await harness.lifecycle.dispose(); }
  });
});
