// The Linear seed on the server (plan amendment A16), against a FAKE Linear:
// global fetch is stubbed, so no test here reaches the network. Tickets,
// projects, and people are fictional Inkwell ones.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pr } from "./contract.js";
import { createEffortStore } from "./effort-store.js";
import { parsePrList } from "./gh.js";
import type { DeckView } from "./deck.js";
import type { InventoryView } from "./inventory-view.js";
import plugin from "./server.js";

const HOST = "host-inkwell";
const DAY = 86_400_000;
const KEY = "lin_api_inkwellfakekey";
const url = (number: number) => `https://github.com/inkwell/folio/pull/${number}`;
const pr = (number: number, title: string, branch = `reader/change${number}`): Pr => parsePrList(JSON.stringify([{ number, url: url(number), state: "OPEN", title,
  isDraft: false, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefName: branch, baseRefName: "main",
  headRefOid: "a".repeat(40), latestReviews: [], reviewRequests: [], statusCheckRollup: [{ conclusion: "SUCCESS" }], createdAt: "2026-09-21T15:00:00Z" }]))!.pr;

type Issue = { project?: { id: string; name: string; description?: string; targetDate?: string; initiatives?: string[] }; assignee?: string; state?: string };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

/** Your open PRs, a fake Linear workspace that owns team ABC and answers for `issues`, and one refresh. */
async function setup(authored: Pr[], issues: Record<string, Issue>) {
  const queries: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    expect(init.headers.authorization).toBe(KEY);
    const query = (JSON.parse(init.body) as { query: string }).query;
    queries.push(query);
    if (query.includes("viewer")) return { ok: true, status: 200, json: async () => ({ data: { viewer: { organization: { name: "Inkwell", urlKey: "inkwell" } },
      teams: { nodes: [{ key: "ABC", name: "Reader app" }] } } }) };
    const data: Record<string, unknown> = {};
    for (const match of query.matchAll(/(t\d+): issue\(id: "([^"]+)"\)/gu)) {
      const issue = issues[match[2]!];
      data[match[1]!] = issue ? { identifier: match[2], title: `Title of ${match[2]}`, state: { name: issue.state ?? "In Progress", type: "started" },
        url: `https://linear.app/inkwell/issue/${match[2]}`,
        assignee: issue.assignee ? { name: issue.assignee, displayName: issue.assignee.toLowerCase() } : null,
        project: issue.project ? { id: issue.project.id, name: issue.project.name, description: issue.project.description ?? null,
          targetDate: issue.project.targetDate ?? null, initiatives: { nodes: (issue.project.initiatives ?? []).map((name) => ({ id: `init-${name}`, name })) } } : null } : null;
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "workstreams", settings: { scanRoots: "/p", linearApiKeys: KEY }, sdk: {
    system: { config: async () => ({ primaryHostId: HOST }) as never },
    projects: { list: async () => [{ id: "project-folio", name: "Folio", sources: [{ hostId: HOST, path: "/p" }] }] as never },
    threads: { list: async () => [] as never, getPluginMetadata: async () => ({}) as never, events: { list: async () => [] } },
  }, experimental_callHostRpc: async ({ method }) => {
    if (method === "scan" || method === "inspectPaths") return { units: [], warnings: [] };
    if (method === "authoredPrs") return { owners: ["inkwell"], entries: authored.map((entry) => ({ repo: "inkwell/folio", pr: entry })), discoveryComplete: true,
      repositories: [{ repo: "inkwell/folio", complete: true }], complete: true, warnings: [] };
    throw new Error(`Unexpected host method ${method}`);
  } });
  await plugin(bb);
  cleanups.push(() => harness.lifecycle.dispose());
  expect((await harness.runCli(["refresh"])).exitCode).toBe(0);
  const call = (method: string, input: unknown) => harness.callRpc(method as never, input as never) as Promise<any>;
  const asked = () => queries.filter((query) => query.includes("issue(")).flatMap((query) => [...query.matchAll(/issue\(id: "([^"]+)"\)/gu)].map((match) => match[1]));
  const grouped = async () => Object.fromEntries((await call("inventory_get", {}) as InventoryView).groups
    .map((group) => [group.effort?.name ?? "No effort", group.rows.map((row) => row.number)]));
  return { bb, harness, call, asked, grouped, efforts: createEffortStore(bb.storage.database()) };
}

describe("Linear sync for your open PRs", () => {
  // The scan used to ask only about tickets in local checkouts, so a PR you opened from elsewhere never got its Linear project.
  it("reads Linear for tickets that appear only on your open PRs, and never sends one whose prefix no workspace owns", async () => {
    const env = await setup([pr(313, "ABC-350 Footer year"), pr(314, "Fix utf-8 names", "reader/abc-351-names")],
      { "ABC-350": { project: { id: "proj-footer", name: "Footer refresh" }, assignee: "Dana" }, "ABC-351": {} });
    expect(env.asked().sort()).toEqual(["ABC-350", "ABC-351"]);
    const stored = env.bb.storage.database().prepare("SELECT ticket, detail FROM linear_detail ORDER BY ticket").all() as { ticket: string; detail: string }[];
    expect(stored.map((row) => row.ticket)).toEqual(["ABC-350", "ABC-351"]);
    expect(JSON.parse(stored[0]!.detail)).toMatchObject({ project: { id: "proj-footer", name: "Footer refresh" }, assignee: "dana" });
  });

  // A ticket left the sync once its last PR merged, so Reconcile would read a state frozen before the merge. Effort members and the last 14
  // days' merges stay in; older merges keep their last read, and every ticket still waits out its 12-hour cache.
  it("also reads effort members' tickets and those of PRs merged in the last 14 days, but no older merge's, each once per 12 hours", async () => {
    const env = await setup([pr(313, "ABC-350 Footer year")], { "ABC-350": {}, "ABC-380": {}, "ABC-381": {}, "ABC-382": {}, "ABC-383": {}, "ABC-384": {} });
    expect(env.asked()).toEqual(["ABC-350"]);
    env.efforts.establish({ sourceKey: "ticket:ABC-380", name: "Shelf labels", goal: "", projectId: "project-folio", coordinatorState: "none",
      members: { tickets: ["ABC-380"], prUrls: [] } });
    const merged = env.bb.storage.database().prepare("INSERT INTO pr_merges (url, merged_at, title, head_ref) VALUES (?, ?, ?, ?)");
    merged.run(url(300), Date.now() - 2 * DAY, "ABC-381 Print shelf labels", "reader/abc-381");
    merged.run(url(301), Date.now() - DAY, "Label the returns cart", "reader/abc-383-returns");
    merged.run(url(302), Date.now() - 20 * DAY, "ABC-382 Old shelf labels", "reader/abc-382");
    const archived = env.efforts.establish({ sourceKey: "ticket:ABC-384", name: "Old labels", goal: "", projectId: "project-folio", coordinatorState: "none",
      members: { tickets: ["ABC-384"], prUrls: [] } });
    env.efforts.setArchived(archived.id, true);
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect(env.asked().slice(1).sort()).toEqual(["ABC-380", "ABC-381", "ABC-383"]);
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect(env.asked()).toHaveLength(4);
  });

  // A merged PR's ticket is read again after the merge, so the deck can say Linear still has it open.
  it("shows the deck an effort's ticket still open in Linear after its only PR merged, with its Linear page", async () => {
    const env = await setup([pr(313, "ABC-350 Footer year")], { "ABC-350": {}, "ABC-380": {} });
    const labels = env.efforts.establish({ sourceKey: "ticket:ABC-380", name: "Shelf labels", goal: "", projectId: "project-folio", coordinatorState: "none",
      members: { tickets: ["ABC-380"], prUrls: [] } });
    env.bb.storage.database().prepare("INSERT INTO pr_merges (url, merged_at, title, head_ref) VALUES (?, ?, ?, ?)")
      .run(url(300), Date.now() - 2 * DAY, "ABC-380 Print shelf labels", "reader/abc-380");
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    const card = (await env.call("deck_get", {}) as DeckView).active.find((item) => item.id === labels.id)!;
    expect(card.linear.reconcile).toEqual({ done: [], prUrls: [], merged: [{ id: "ABC-380", url: "https://linear.app/inkwell/issue/ABC-380" }] });
  });
});

// Reading lists has three of your PRs. #320 also carries ABC-341, which Shelf order owns, so Shelf order owns #320 through that second ticket.
// The Linear project "Shelf order" has #316 and #320, both Shelf order's. Store pickup has #322. #321 carries no ticket.
const LISTS = { id: "proj-lists", name: "Reading lists", description: "Readers keep lists of books to read next.\nEach list syncs across devices.",
  targetDate: "2026-10-17", initiatives: ["Reading rooms"] };
const SHELVES = { id: "proj-shelves", name: "Shelf order" };
const PICKUP = { id: "proj-pickup", name: "Store pickup" };
const ISSUES: Record<string, Issue> = { "ABC-350": { project: LISTS }, "ABC-351": { project: LISTS }, "ABC-352": { project: LISTS },
  "ABC-341": { project: SHELVES }, "ABC-360": { project: PICKUP } };
const AUTHORED = () => [pr(313, "ABC-350 Start a reading list"), pr(314, "ABC-351 Share a reading list"), pr(316, "ABC-341 Group shelves by genre"),
  pr(320, "ABC-352 ABC-341 Shelve a list's books together"), pr(321, "Remove an unused import"), pr(322, "ABC-360 Print pickup slips")];

async function seeded() {
  const prs = AUTHORED();
  const issues = { ...ISSUES };
  const env = await setup(prs, issues);
  const shelf = env.efforts.establish({ sourceKey: "ticket:ABC-341", name: "Shelf order", goal: "Keep shelves in order", projectId: "project-folio",
    coordinatorState: "none", members: { tickets: ["ABC-341"], prUrls: [] } });
  return { ...env, prs, issues, shelf };
}
const REQUEST = "88888888-8888-4888-8888-888888888888";

describe("Seed from Linear", () => {
  it("proposes one effort per Linear project on your open PRs, with a short goal and each match by name or owned PRs, and creates nothing", async () => {
    const env = await seeded();
    const before = env.efforts.listAll().length;
    const preview = await env.call("linear_seed_preview", null);
    expect(preview.keyed).toBe(true);
    const shelf = { id: env.shelf.id, name: "Shelf order" };
    expect(preview.proposals.map((proposal: any) => [proposal.name, proposal.goal, proposal.prs.map((item: any) => [item.number, item.effort?.name ?? null]),
      proposal.matches])).toEqual([
      ["Reading lists", "Readers keep lists of books to read next.", [[313, null], [314, null], [320, "Shelf order"]], [{ ...shelf, by: "members", prs: 1 }]],
      ["Store pickup", "", [[322, null]], []],
      ["Shelf order", "", [[316, "Shelf order"], [320, "Shelf order"]], [{ ...shelf, by: "name", prs: 2 }]],
    ]);
    expect(env.efforts.listAll().length).toBe(before);
  });

  it("creates only the projects you pick, never takes a PR another effort owns, audits each PR, and records the project it came from", async () => {
    const env = await seeded();
    const fetched = env.asked().length;
    const result = await env.call("linear_seed_create", { projectIds: ["proj-lists", "proj-shelves"], requestId: REQUEST });
    expect(result).toEqual({ ok: true, created: [{ projectId: "proj-lists", actionId: expect.any(String), effort: expect.objectContaining({ name: "Reading lists" }), added: 2 }],
      skipped: [{ projectId: "proj-shelves", name: "Shelf order", reason: "An effort with that name already exists." }] });
    // #320 stays Shelf order's through its second ticket, and Store pickup, which you didn't pick, is still to sort.
    expect(await env.grouped()).toEqual({ "Reading lists": [313, 314], "Shelf order": [316, 320], "No effort": [321, 322] });
    const effortId = result.created[0].effort.id;
    const db = env.bb.storage.database();
    expect(db.prepare("SELECT source, kind, ref FROM effort_assignments WHERE effort_id = ? ORDER BY ref").all(effortId))
      .toEqual([{ source: "seed", kind: "prUrl", ref: url(313) }, { source: "seed", kind: "prUrl", ref: url(314) }]);
    expect(db.prepare("SELECT kind, ref, name FROM effort_seeds WHERE effort_id = ?").get(effortId)).toEqual({ kind: "linear-project", ref: "proj-lists", name: "Reading lists" });
    // Provenance lives beside the effort, so no save that spreads an effort's record can drop it; the seed claims no ticket.
    expect(env.efforts.get(effortId)).toMatchObject({ goal: "Readers keep lists of books to read next.", members: { tickets: [] } });
    expect(JSON.stringify(env.efforts.get(effortId))).not.toContain("proj-lists");
    // Seeding reads only what the board stored.
    expect(env.asked().length).toBe(fetched);
    // The same request again creates nothing twice.
    expect(await env.call("linear_seed_create", { projectIds: ["proj-lists"], requestId: REQUEST }))
      .toMatchObject({ created: [], skipped: [{ projectId: "proj-lists", reason: "Already seeded as Reading lists." }] });
  });

  // A seed is a starting point, not a mirror: Linear changing afterwards moves nothing, and a later PR on the project waits for your click.
  it("never syncs a seeded effort with Linear afterwards, and a later PR on its project stays to sort", async () => {
    const env = await seeded();
    const { created: [made] } = await env.call("linear_seed_create", { projectIds: ["proj-lists"], requestId: REQUEST });
    const db = env.bb.storage.database();
    const row = db.prepare("SELECT detail FROM linear_detail WHERE ticket = 'ABC-350'").get() as { detail: string };
    db.prepare("UPDATE linear_detail SET detail = ? WHERE ticket = 'ABC-350'").run(JSON.stringify({ ...JSON.parse(row.detail),
      project: { id: "proj-lists", name: "Reading lists v2", description: "Renamed in Linear", targetDate: null, initiatives: [] } }));
    env.prs.push(pr(325, "ABC-353 Reorder a reading list"));
    env.issues["ABC-353"] = { project: LISTS };
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect(env.efforts.get(made.effort.id)).toMatchObject({ name: "Reading lists", goal: "Readers keep lists of books to read next." });
    expect(await env.grouped()).toMatchObject({ "Reading lists": [313, 314], "No effort": [321, 322, 325] });
    // It is suggested, with high confidence, for the effort seeded from its project.
    expect((await env.call("classify_get", null)).groups).toContainEqual(expect.objectContaining({ target: { kind: "effort", effortId: made.effort.id,
      name: "Reading lists" }, confidence: "high", prs: [expect.objectContaining({ number: 325, signals: expect.arrayContaining([{ kind: "project",
        effortId: made.effort.id, text: "Linear project “Reading lists”" }]) })] }));
  });

  it("lets a standing rule place PRs by Linear project, in any case", async () => {
    const env = await seeded();
    const lists = env.efforts.establish({ sourceKey: "lists", name: "Lists", goal: "", projectId: "", coordinatorState: "none", members: { tickets: [], prUrls: [] } });
    expect(await env.call("classify_rule_preview", { kind: "linear-project", value: " reading  LISTS ", effortKey: lists.key }))
      .toEqual({ ok: true, prUrls: [url(313), url(314)] });
    expect(await env.call("classify_rule_add", { kind: "linear-project", value: "Reading lists", effortKey: lists.key, now: true }))
      .toMatchObject({ ok: true, rule: { kind: "linear-project", value: "Reading lists" }, actions: [{ added: 2 }] });
    expect(await env.grouped()).toMatchObject({ Lists: [313, 314] });
    expect(await env.call("classify_rule_preview", { kind: "linear-project", value: "  ", effortKey: lists.key }))
      .toEqual({ ok: false, error: "Enter a Linear project's name." });
  });

  it("undoes a seed as one action: the effort and its provenance go, and the project can be seeded again", async () => {
    const env = await seeded();
    const { created: [made] } = await env.call("linear_seed_create", { projectIds: ["proj-lists"], requestId: REQUEST });
    expect(await env.call("classify_undo", { actionId: made.actionId })).toEqual({ ok: true });
    expect(env.efforts.get(made.effort.id)).toBeNull();
    expect(env.bb.storage.database().prepare("SELECT COUNT(*) AS n FROM effort_seeds").get()).toEqual({ n: 0 });
    expect(await env.grouped()).toEqual({ "Shelf order": [316, 320], "No effort": [313, 314, 321, 322] });
    expect((await env.call("linear_seed_preview", null)).proposals[0]).toMatchObject({ name: "Reading lists",
      matches: [{ name: "Shelf order", by: "members" }] });
    expect(await env.call("linear_seed_create", { projectIds: ["proj-lists"], requestId: "99999999-9999-4999-8999-999999999999" }))
      .toMatchObject({ created: [{ added: 2 }], skipped: [] });
  });

  // Merging drops the seeded effort from every list, so without its seed the survivor wouldn't match the project, and a later PR on it
  // would seed a second effort.
  it("keeps a seed with the effort it merges into, so the project is never seeded twice", async () => {
    const env = await seeded();
    const { created: [made] } = await env.call("linear_seed_create", { projectIds: ["proj-lists"], requestId: REQUEST });
    const keys = { sourceKey: made.effort.key, destinationKey: env.shelf.key };
    const { preview } = await env.call("effort_admin_merge_preview", keys);
    expect(await env.call("effort_admin_merge", { ...keys, expectedScope: preview.scope })).toMatchObject({ ok: true });
    env.prs.push(pr(325, "ABC-353 Reorder a reading list"));
    env.issues["ABC-353"] = { project: LISTS };
    expect((await env.harness.runCli(["refresh"])).exitCode).toBe(0);
    expect(await env.call("linear_seed_create", { projectIds: ["proj-lists"], requestId: "99999999-9999-4999-8999-999999999999" }))
      .toMatchObject({ created: [], skipped: [{ projectId: "proj-lists", reason: "Already seeded as Shelf order." }] });
  });
});
