import { describe, expect, it } from "vitest";
import { inventoryTicketEfforts } from "./effort-membership.js";
import { establishedEffortSchema } from "./effort-store.js";
import type { Pr } from "./contract.js";

const pattern = /([A-Z]+)-(\d+)/giu;
const entry = (number: number, title = "ABC-1: Reverse cancellation — backend", repo = "acme/api", state: Pr["state"] = "OPEN") => ({ repo, pr: { url: `https://github.com/${repo}/pull/${number}`, title, headRefName: "topic/abc-1", state } });
const pair = () => [entry(1), entry(2, "ABC-1: Reverse cancellation — admin UI", "acme/admin")];
const established = (tickets: string[], prUrls: string[]) => establishedEffortSchema.parse({ id: "saved", key: "effort:saved", name: "Saved outcome", goal: "", projectId: "project", coordinatorThreadId: null, coordinatorState: "ready", members: { tickets, prUrls }, createdAt: 0, updatedAt: 0 });

describe("remote ticket efforts", () => {
  it("groups exact open ticket siblings without creating checkout units", () => {
    expect(inventoryTicketEfforts(pair(), [], [], pattern)).toEqual([{
      key: "ticket:ABC-1", ticket: "ABC-1", name: "Reverse cancellation (ABC-1)",
      prUrls: pair().map((entry) => entry.pr.url).sort(), repoCount: 2,
    }]);
  });
  it("uses cached issue wording and remains stable across row order", () => {
    const titles = new Map([["ABC-1", "Restore member cancellation"]]);
    const result = inventoryTicketEfforts(pair(), [], [], pattern, titles);
    expect(result[0]!.name).toBe("Restore member cancellation (ABC-1)");
    expect(inventoryTicketEfforts(pair().reverse(), [], [], pattern, titles)).toEqual(result);
  });
  it("never replaces existing local or explicit membership, including ambiguous anchors", () => {
    const group = { key: "local", name: "Existing outcome", clusters: [{ ticket: "ABC-1", units: [] }] };
    expect(inventoryTicketEfforts(pair(), [group], [], pattern)).toEqual([]);
    expect(inventoryTicketEfforts(pair(), [group, { ...group, key: "other" }], [], pattern)).toEqual([]);
    expect(inventoryTicketEfforts(pair(), [], [established(["ABC-1"], [])], pattern)).toEqual([]);
    expect(inventoryTicketEfforts(pair(), [], [established([], [pair()[0]!.pr.url.toUpperCase()])], pattern)).toEqual([]);
  });
  it("does not manufacture a cohort from cloned, closed, merged, or ticketless PRs", () => {
    const one = entry(1);
    expect(inventoryTicketEfforts([one, { ...one, pr: { ...one.pr, url: one.pr.url.toUpperCase() + "/" } }, entry(2, undefined, undefined, "MERGED"), entry(3, undefined, undefined, "CLOSED")], [], [], pattern)).toEqual([]);
    expect(inventoryTicketEfforts(pair().map((entry) => ({ ...entry, pr: { ...entry.pr, title: "Improve cancellation", headRefName: "topic" } })), [], [], pattern)).toEqual([]);
  });
  it("leaves conflicting title and branch ticket references unresolved", () => {
    expect(inventoryTicketEfforts([entry(1), { ...entry(2), pr: { ...entry(2).pr, title: "ABC-2: Improve cancellation" } }], [], [], pattern)).toEqual([]);
  });
  it("does not group unrelated tickets merely because they share a team", () => {
    expect(inventoryTicketEfforts([entry(1), { ...entry(2), pr: { ...entry(2).pr, title: "ABC-2: Improve catalog", headRefName: "abc-2" } }], [], [], pattern)).toEqual([]);
  });
});
