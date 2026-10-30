import { describe, expect, it } from "vitest";
import { workContextIndex, type WorkThreadLink } from "./work-context.js";

const first = "https://github.com/inkwell/folio/pull/42";
const second = "https://github.com/inkwell/folio/pull/43";

describe("shared work context", () => {
  it("keeps one thread's two PR histories and their provenance without turning a controller into direct activity", () => {
    const context = workContextIndex({
      remotes: [{ url: first, stale: false, value: "First" }, { url: second, stale: false, value: "Second" }],
      locals: [],
      links: [
        { prUrl: first, threadId: "thread", source: "metadata", role: "pr", title: "PR thread", tier: "started" },
        { prUrl: first.toUpperCase() + "/", threadId: "thread", source: "run", role: "pr", title: "Earlier action", tier: "started" },
        { prUrl: second, threadId: "thread", source: "advance", role: "pr", title: "Advance", tier: "started" },
        { prUrl: second, threadId: "controller", source: "repo", role: "repo", title: "Repository", tier: "started", contextual: true },
      ],
    });
    expect(context.prUrlsForThread("thread")).toEqual([first, second]);
    expect(context.linksForPr(first)[0]).toMatchObject({ threadId: "thread", sources: ["metadata", "run"], direct: true });
    expect(context.directThreadIds(second)).toEqual(["thread"]);
    expect(context.linksForPr(second).map((link) => link.threadId)).toEqual(["thread", "controller"]);
    expect(context.prUrlsForThread("controller")).toEqual([]);
  });

  it("preserves conflicting exact owners while connecting a PR with two tickets", () => {
    const context = workContextIndex({
      remotes: [{ url: first, stale: false, tickets: ["INK-1", "INK-2"], value: "Shared PR" },
        { url: second, stale: false, tickets: ["INK-2"], value: "Sibling PR" }],
      locals: [{ url: first, path: "/p/folio", tickets: ["INK-1"], value: "Checkout" }],
      links: [],
      ownerOf: (kind, id) => kind === "prUrl" && id === first ? { id: "pr-owner", key: "pr-owner", name: "PR effort" }
        : kind === "ticket" && id === "INK-1" ? { id: "ticket-owner", key: "ticket-owner", name: "Ticket effort" }
          : kind === "checkoutPath" ? { id: "path-owner", key: "path-owner", name: "Checkout effort" } : null,
    });
    expect(context.connectedTickets(["INK-1"])).toEqual(["INK-1", "INK-2"]);
    expect(context.items.get(first)?.paths).toEqual(["/p/folio"]);
    expect(context.owner("prUrl", first)?.key).toBe("pr-owner");
    expect(context.owner("ticket", "INK-1")?.key).toBe("ticket-owner");
    expect(context.owner("checkoutPath", "/p/folio")?.key).toBe("path-owner");
    expect(context.ownerForPr(first)?.key).toBe("pr-owner");
    expect(context.ownerForPr(second)).toBeNull();
  });

  it("does not choose a controller from conflicting ticket owners, but honors an exact PR owner", () => {
    const ambiguous = "https://github.com/inkwell/folio/pull/44";
    const context = workContextIndex({
      remotes: [first, ambiguous].map((url) => ({ url, stale: false, tickets: ["INK-1", "INK-2"], value: url })),
      locals: [],
      ownerOf: (kind, id) => kind === "prUrl" && id === first ? { id: "exact", key: "exact", name: "Exact effort" }
        : kind === "ticket" && id === "INK-1" ? { id: "one", key: "one", name: "First effort" }
          : kind === "ticket" && id === "INK-2" ? { id: "two", key: "two", name: "Second effort" } : null,
      links: ({ items, ownerForPr }) => [...items.keys()].flatMap((url): WorkThreadLink[] => {
        const owner = ownerForPr(url);
        return owner ? [{ prUrl: url, threadId: `controller-${owner.id}`, source: "repo", role: "repo",
          title: "Repository controller", tier: "started", contextual: true }] : [];
      }),
    });
    expect(context.ownerForPr(first)?.key).toBe("exact");
    expect(context.linksForPr(first).map((link) => link.threadId)).toEqual(["controller-exact"]);
    expect(context.ownerForPr(ambiguous)).toBeNull();
    expect(context.linksForPr(ambiguous)).toEqual([]);
    expect(context.directThreadIds(first)).toEqual([]);
  });
});
