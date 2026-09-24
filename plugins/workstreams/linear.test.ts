import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_CHARS,
  detailQuery,
  parseDetails,
  parseLinearKeys,
  parseWorkspace,
  planFetch,
  projectNameOf,
  routeTeams,
  ticketPrefix,
} from "./linear.js";
import { AGENT_FETCH_MAX, agentFetchPrompt, parseAgentAnswer, startLinearFetch } from "./linearagent.js";

describe("parseLinearKeys", () => {
  it("splits on commas and any whitespace, because a secret setting cannot be multi-line", () => {
    expect(parseLinearKeys("lin_api_a, lin_api_b\tlin_api_c  ,lin_api_d")).toEqual([
      "lin_api_a",
      "lin_api_b",
      "lin_api_c",
      "lin_api_d",
    ]);
  });

  it("merges the old single-key setting with the new list, so a key entered before the list existed keeps working", () => {
    expect(parseLinearKeys("lin_api_new", "lin_api_old")).toEqual(["lin_api_new", "lin_api_old"]);
  });

  it("drops duplicates and blanks, and reads a missing setting as no keys", () => {
    expect(parseLinearKeys("lin_api_a,,lin_api_a", "lin_api_a", undefined, "")).toEqual(["lin_api_a"]);
    expect(parseLinearKeys(undefined, "")).toEqual([]);
  });
});

describe("team routing", () => {
  const inkwell = { keyIndex: 0, name: "Inkwell", urlKey: "inkwell", teams: ["ABC", "OPS"] };
  const press = { keyIndex: 1, name: "Inkwell Press", urlKey: "inkwell-press", teams: ["WEB", "OPS"] };

  it("routes each ticket to the key whose workspace owns its prefix", () => {
    const { owner } = routeTeams([inkwell, press]);
    const plan = planFetch(["ABC-101", "WEB-7", "ABC-102"], owner);
    expect(plan.byKey.get(0)).toEqual(["ABC-101", "ABC-102"]);
    expect(plan.byKey.get(1)).toEqual(["WEB-7"]);
    expect(plan.unowned).toEqual([]);
  });

  it("leaves a prefix no key owns unowned rather than guessing a workspace, because a wrong workspace answers about a different ticket", () => {
    const { owner } = routeTeams([inkwell]);
    expect(planFetch(["SHOP-12"], owner)).toEqual({ byKey: new Map(), unowned: ["SHOP-12"] });
  });

  it("gives a team two keys claim to the first key, whatever order discovery finished in, and reports it once", () => {
    const forward = routeTeams([inkwell, press]);
    const backward = routeTeams([press, inkwell]);
    expect(forward.owner.get("OPS")).toBe(0);
    expect(backward.owner.get("OPS")).toBe(0);
    expect(forward.duplicates).toEqual(["OPS"]);
  });

  it("routes by the prefix before the last dash, uppercased", () => {
    expect(ticketPrefix("abc-101")).toBe("ABC");
  });

  it("reads a workspace response by key index and never needs the key itself", () => {
    const workspace = parseWorkspace(3, {
      data: { viewer: { organization: { name: "Inkwell", urlKey: "inkwell" } }, teams: { nodes: [{ key: "abc" }, { key: "OPS" }] } },
    });
    expect(workspace).toEqual({ keyIndex: 3, name: "Inkwell", urlKey: "inkwell", teams: ["ABC", "OPS"], teamNames: {} });
    expect(parseWorkspace(0, { errors: [{ message: "Authentication required" }] })).toBeNull();
  });
});

describe("the batched detail query", () => {
  it("aliases one issue per ticket in a single query, so a batch costs one request", () => {
    const query = detailQuery(["ABC-101", "ABC-102"]);
    expect(query).toContain('t0: issue(id: "ABC-101")');
    expect(query).toContain('t1: issue(id: "ABC-102")');
    expect(query.match(/issue\(/gu)).toHaveLength(2);
    for (const field of ["title", "description", "state { name type }", "project { id name }", "parent { identifier title }", "labels { nodes { name } }", "url", "updatedAt"]) {
      expect(query).toContain(field);
    }
  });

  it("reads every field, caps the description, and caches a missing issue as null so it is not re-asked every scan", () => {
    const details = parseDetails(["ABC-101", "ABC-404"], {
      data: {
        t0: {
          identifier: "ABC-101",
          title: "Gift card balances",
          description: "x".repeat(2_000),
          state: { name: "In Progress", type: "started" },
          project: { id: "p1", name: "Checkout polish" },
          parent: { identifier: "ABC-100", title: "Gift cards" },
          labels: { nodes: [{ name: "frontend" }] },
          url: "https://linear.app/inkwell/issue/ABC-101",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        t1: null,
      },
    });
    const found = details?.get("ABC-101");
    expect(found?.title).toBe("Gift card balances");
    expect(found?.description).toHaveLength(DESCRIPTION_CHARS);
    expect(found?.project).toEqual({ id: "p1", name: "Checkout polish" });
    expect(found?.parent).toEqual({ identifier: "ABC-100", title: "Gift cards" });
    expect(found?.labels).toEqual(["frontend"]);
    expect(found?.source).toBe("key");
    expect(details?.get("ABC-404")).toBeNull();
    expect(parseDetails(["ABC-1"], { errors: [] })).toBeNull();
  });

  it("does not treat missing, invalid, or errored aliases as nonexistent issues", () => {
    const partial = parseDetails(["ABC-1", "ABC-2", "ABC-3", "ABC-4"], {
      data: {
        t0: { identifier: "ABC-1", title: "Valid" },
        t1: null,
        t2: { identifier: "OTHER-3", title: "Wrong issue" },
      },
      errors: [{ message: "Temporary resolver failure", path: ["t1"] }],
    });
    expect([...partial!]).toEqual([["ABC-1", expect.objectContaining({ title: "Valid" })]]);
    expect(parseDetails(["ABC-1"], {
      data: { t0: { identifier: "ABC-1", title: "Partial" } },
      errors: [{ message: "Project failed", path: ["t0", "project"] }],
    })?.size).toBe(0);
    expect(parseWorkspace(0, {
      data: { viewer: { organization: { name: "Example", urlKey: "example" } }, teams: { nodes: [] } },
      errors: [{ message: "Partial discovery" }],
    })).toBeNull();
  });

  it("names a ticket by its project, else its parent's title, exactly as the old single-key path did", () => {
    const base = parseDetails(["ABC-1"], { data: { t0: { identifier: "ABC-1", parent: { identifier: "ABC-0", title: "Gift cards" } } } })?.get("ABC-1");
    expect(projectNameOf(base)).toBe("Gift cards");
    expect(projectNameOf(null)).toBeNull();
  });
});

describe("the agent fallback", () => {
  it("asks for exactly one json block of the fields the cache keeps, and says what to do without Linear tools", () => {
    const prompt = agentFetchPrompt(["SHOP-12", "SHOP-13"]);
    expect(prompt).toContain("SHOP-12, SHOP-13");
    expect(prompt).toContain("exactly one fenced ```json block");
    for (const field of ["identifier", "title", "state", "project", "parentIdentifier", "parentTitle", "url"]) expect(prompt).toContain(field);
    expect(prompt).toContain("empty array");
    expect(prompt).toContain("Do not change anything in Linear");
  });

  it("parses a valid answer into agent-sourced detail", () => {
    const text = 'Found both.\n```json\n[{"identifier":"SHOP-12","title":"Spine labels","state":"Todo","project":"Print run","parentIdentifier":"SHOP-10","parentTitle":"Bindery","url":"https://linear.app/inkwell/issue/SHOP-12"}]\n```';
    const parsed = parseAgentAnswer(text, ["SHOP-12"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.details).toEqual([
      expect.objectContaining({
        identifier: "SHOP-12",
        title: "Spine labels",
        project: { id: null, name: "Print run" },
        parent: { identifier: "SHOP-10", title: "Bindery" },
        source: "agent",
      }),
    ]);
  });

  it("takes the LAST json block, because earlier ones are the agent working it out", () => {
    const text = '```json\n[{"identifier":"SHOP-12","title":"draft"}]\n```\nOn reflection:\n```json\n[{"identifier":"SHOP-12","title":"Spine labels"}]\n```';
    const parsed = parseAgentAnswer(text, ["SHOP-12"]);
    expect(parsed.ok && parsed.details[0]?.title).toBe("Spine labels");
  });

  it("accepts an empty array as a real answer: the session had no Linear tools", () => {
    expect(parseAgentAnswer("No Linear tools here.\n```json\n[]\n```", ["SHOP-12"])).toEqual({ ok: true, details: [] });
  });

  it("fails with a short reason on invalid output, so nothing half-parsed is stored", () => {
    expect(parseAgentAnswer("no block at all", ["SHOP-12"])).toEqual({ ok: false, reason: "No json block in the final message." });
    expect(parseAgentAnswer("```json\n{not json\n```", ["SHOP-12"]).ok).toBe(false);
    expect(parseAgentAnswer('```json\n{"identifier":"SHOP-12"}\n```', ["SHOP-12"]).ok).toBe(false);
    expect(parseAgentAnswer(null, ["SHOP-12"]).ok).toBe(false);
  });

  it("stores only tickets it was asked about, so an agent cannot add rows to the cache", () => {
    const parsed = parseAgentAnswer('```json\n[{"identifier":"SHOP-12"},{"identifier":"ABC-999"}]\n```', ["SHOP-12"]);
    expect(parsed.ok && parsed.details.map((detail) => detail.identifier)).toEqual(["SHOP-12"]);
  });

  it("caps a run at a bounded number of tickets", () => {
    expect(AGENT_FETCH_MAX).toBeLessThanOrEqual(100);
  });
});

describe("starting the agent fallback", () => {
  function fakeSdk(projects: { id: string; sources: { hostId: string; path: string }[] }[]) {
    const spawned: unknown[] = [];
    return {
      spawned,
      sdk: {
        projects: { list: async () => projects },
        threads: {
          spawn: async (args: unknown) => {
            spawned.push(args);
            return { id: "thr-fetch-1" };
          },
        },
      },
    };
  }

  it("spawns ONE thread in the deepest project containing the scan root, so that project's Linear identity answers", async () => {
    const { sdk, spawned } = fakeSdk([
      { id: "prj-home", sources: [{ hostId: "host-a", path: "/Users/inkwell" }] },
      { id: "prj-inkwell", sources: [{ hostId: "host-a", path: "/Users/inkwell/checkouts" }] },
    ]);
    const result = await startLinearFetch(sdk, ["/Users/inkwell/checkouts"], ["SHOP-12", "SHOP-13"]);
    expect(result).toEqual({ ok: true, threadId: "thr-fetch-1", root: "/Users/inkwell/checkouts", asked: ["SHOP-12", "SHOP-13"] });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual(
      expect.objectContaining({
        projectId: "prj-inkwell",
        environment: { type: "host", hostId: "host-a", workspace: { type: "unmanaged", path: "/Users/inkwell/checkouts" } },
        prompt: agentFetchPrompt(["SHOP-12", "SHOP-13"]),
      }),
    );
  });

  it("spawns nothing when there is nothing to ask, or no project holds the checkouts", async () => {
    const empty = fakeSdk([{ id: "prj-inkwell", sources: [{ hostId: "host-a", path: "/Users/inkwell/checkouts" }] }]);
    expect((await startLinearFetch(empty.sdk, ["/Users/inkwell/checkouts"], [])).ok).toBe(false);
    const orphan = fakeSdk([{ id: "prj-other", sources: [{ hostId: "host-a", path: "/elsewhere" }] }]);
    expect((await startLinearFetch(orphan.sdk, ["/Users/inkwell/checkouts"], ["SHOP-12"])).ok).toBe(false);
    expect([...empty.spawned, ...orphan.spawned]).toEqual([]);
  });

  it("caps the tickets one run asks about", async () => {
    const { sdk } = fakeSdk([{ id: "prj-inkwell", sources: [{ hostId: "host-a", path: "/c" }] }]);
    const many = Array.from({ length: AGENT_FETCH_MAX + 10 }, (_, index) => `SHOP-${index + 1}`);
    const result = await startLinearFetch(sdk, ["/c"], many);
    expect(result.ok && result.asked).toHaveLength(AGENT_FETCH_MAX);
  });
});
