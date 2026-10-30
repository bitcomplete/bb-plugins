import { describe, expect, it } from "vitest";
import { readEqualHeadTrees } from "./advance-host.js";
import type { GhRunner } from "./ghactions.js";

const url = "https://github.com/example/widget/pull/42";

describe("equal head trees", () => {
  it("reuses identical commit trees only while the same open PR still has the expected head", async () => {
    const old = "c".repeat(40), fresh = "d".repeat(40), tree = "e".repeat(40);
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push([...args]);
      const sha = args.at(-1)!.split("/").at(-1)!;
      return { ok: true, stdout: JSON.stringify(args[0] === "api" ? { sha, tree: { sha: tree } } :
        { url, state: "OPEN", headRefOid: fresh }) };
    };
    expect(await readEqualHeadTrees(run, url, old, fresh)).toEqual({ ok: true, priorTreeOid: tree, currentTreeOid: tree });
    expect(calls.filter((args) => args[0] === "api")).toHaveLength(2);
    expect(await readEqualHeadTrees(run, url, old, fresh)).toMatchObject({ ok: true });
    expect(calls.filter((args) => args[0] === "api")).toHaveLength(2);
    expect(calls.filter((args) => args[1] === "view")).toHaveLength(2);
  });

  it("fails closed on a changed tree, incomplete commit read, or a head race", async () => {
    for (const [reason, oldDigit, freshDigit] of [["tree", "f", "1"], ["missing", "7", "8"], ["head", "9", "a"]] as const) {
      const old = oldDigit.repeat(40), fresh = freshDigit.repeat(40);
      const calls: string[][] = [];
      const run: GhRunner = async (args) => {
        calls.push([...args]);
        if (args[0] !== "api") return { ok: true, stdout: JSON.stringify({ url, state: "OPEN", headRefOid: reason === "head" ? old : fresh }) };
        const sha = args.at(-1)!.split("/").at(-1)!;
        return { ok: true, stdout: JSON.stringify(reason === "missing" ? {} : { sha,
          tree: { sha: sha === old ? "2".repeat(40) : reason === "tree" ? "3".repeat(40) : "2".repeat(40) } }) };
      };
      expect(await readEqualHeadTrees(run, url, old, fresh)).toEqual({ ok: false });
      expect(calls.filter((args) => args[0] === "api")).toHaveLength(2);
      expect(calls.filter((args) => args[1] === "view")).toHaveLength(reason === "head" ? 1 : 0);
    }
  });

  it("uses an enterprise host flag without putting the hostname in the REST repository path", async () => {
    const old = "4".repeat(40), fresh = "5".repeat(40), enterprise = "https://github.example.test/acme/widget/pull/42";
    const calls: string[][] = [];
    const run: GhRunner = async (args) => { calls.push([...args]);
      const sha = args.at(-1)!.split("/").at(-1)!;
      return { ok: true, stdout: JSON.stringify(args[0] === "api" ? { sha, tree: { sha: "6".repeat(40) } } :
        { url: enterprise, state: "OPEN", headRefOid: fresh }) };
    };
    expect(await readEqualHeadTrees(run, enterprise, old, fresh)).toMatchObject({ ok: true });
    expect(calls.filter((args) => args[0] === "api")).toEqual([
      ["api", "--hostname", "github.example.test", `repos/acme/widget/git/commits/${old}`],
      ["api", "--hostname", "github.example.test", `repos/acme/widget/git/commits/${fresh}`],
    ]);
  });
});
