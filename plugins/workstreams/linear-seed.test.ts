import { describe, expect, it } from "vitest";
import type { LinearDetail } from "./linear.js";
import { seedGoal, seedProposals } from "./linear-seed.js";

const detail = (identifier: string, project: LinearDetail["project"], source: LinearDetail["source"] = "key"): LinearDetail => ({ identifier, title: null,
  description: null, state: null, project, parent: null, labels: [], url: null, updatedAt: null, source });
const pr = (number: number, tickets: string[]) => ({ prUrl: `https://github.com/inkwell/folio/pull/${number}`, repo: "inkwell/folio", number, title: `PR ${number}`,
  tickets, effort: null });

describe("the Linear seed", () => {
  it("takes a goal from the project's first line, cut at a word to fit a card", () => {
    expect(seedGoal("Readers keep lists of books.\nMore below.")).toBe("Readers keep lists of books.");
    expect(seedGoal(null)).toBe("");
    const long = seedGoal(`${"Readers keep shared lists ".repeat(10)}end`);
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long).toMatch(/lists…$/u);
  });

  // A row the removed agent fetch cached names a project but not its id, and a seed must record which Linear project it came from.
  it("proposes nothing from a ticket whose project has no id", () => {
    const linear = new Map([["ABC-1", detail("ABC-1", { id: null, name: "Reading lists" }, "agent")], ["ABC-2", detail("ABC-2", { id: "proj-lists", name: "Reading lists" })]]);
    expect(seedProposals({ prs: [pr(1, ["ABC-1"]), pr(2, ["ABC-2"])], linear, efforts: [] }).map((proposal) => [proposal.projectId, proposal.prs.map((item) => item.number)]))
      .toEqual([["proj-lists", [2]]]);
  });
});
