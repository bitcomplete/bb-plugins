import { describe, expect, it, vi } from "vitest";
import { classify } from "./ops.js";
import { NO_TOKEN, SentryApiError, createSentryReader, eventOf, issueInOrg, issueOf, issuesOf, recentLine, sentryChanges, sentrySightings, sentrySummary, stackTraceOf, type SentryFinding, type SentryIssue, type SentryLook } from "./sentry.js";

const now = Date.parse("2026-10-20T15:00:00Z");
const since = now - 3_600_000;

/** An issue as Sentry's API serializes it. */
const apiIssue = (over: Record<string, unknown> = {}) => ({
  id: "6081234567",
  shortId: "WEB-12",
  title: "TypeError: Cannot read properties of undefined (reading 'id')",
  culprit: "handler(src/api/users.ts)",
  permalink: "https://acme.sentry.io/issues/6081234567/",
  level: "error",
  status: "unresolved",
  substatus: "new",
  count: "17",
  userCount: 3,
  firstSeen: "2026-10-20T14:30:00Z",
  lastSeen: "2026-10-20T14:58:00Z",
  project: { id: "1", slug: "web", name: "Web" },
  ...over,
});

const apiEvent = {
  eventID: "abc123",
  dateCreated: "2026-10-20T14:58:00Z",
  message: "",
  title: "TypeError: Cannot read properties of undefined (reading 'id')",
  entries: [
    {
      type: "exception",
      data: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'id') token=sk_live_abc",
            stacktrace: {
              frames: [
                { filename: "node_modules/express/lib/router/index.js", function: "next", lineNo: 280, inApp: false },
                { filename: "src/api/users.ts", function: "handler", lineNo: 42, colNo: 7, inApp: true, context: [[41, "  const user = await load(req.params.id);"], [42, "  return res.json({ id: user.id });"], [43, "}"]] },
              ],
            },
          },
        ],
      },
    },
  ],
};

describe("reading Sentry's JSON", () => {
  it("reduces an issue to what a look reads, with the id as a string and credentials redacted", () => {
    const issue = issueOf(apiIssue({ id: 6081234567, title: "Boom: Authorization: Bearer eyJabc" }));
    expect(issue).toMatchObject({ id: "6081234567", shortId: "WEB-12", title: "Boom: Authorization: Bearer [redacted]", culprit: "handler(src/api/users.ts)", count: 17, userCount: 3, status: "unresolved", substatus: "new", project: "web" });
    expect(issueOf({ shortId: "no id" })).toBeNull();
    expect(issuesOf([apiIssue(), { nope: true }, apiIssue({ id: "2" })]).map((i) => i.id)).toEqual(["6081234567", "2"]);
    expect(issuesOf({ not: "a list" })).toEqual([]);
    expect(sentrySummary(issueOf(apiIssue())!)).toBe("WEB-12: TypeError: Cannot read properties of undefined (reading 'id') (handler(src/api/users.ts))");
    expect(recentLine(issueOf(apiIssue())!)).toBe("WEB-12 · TypeError: Cannot read properties of undefined (reading 'id') · handler(src/api/users.ts) · 17 events, last 2026-10-20T14:58:00Z");
  });

  it("formats a stack trace innermost last, marking in-app frames with their source line, redacted", () => {
    expect(stackTraceOf(apiEvent)).toEqual([
      "TypeError: Cannot read properties of undefined (reading 'id') token=[redacted]",
      "    node_modules/express/lib/router/index.js:280 in next",
      "  * src/api/users.ts:42 in handler",
      "      return res.json({ id: user.id });",
    ]);
    // A message event has no exception: its message is the trace.
    expect(stackTraceOf({ entries: [{ type: "message", data: { formatted: "disk full on /var" } }] })).toEqual(["disk full on /var"]);
    expect(stackTraceOf({})).toEqual([]);
    const event = eventOf(apiEvent);
    expect(event).toMatchObject({ id: "abc123", at: "2026-10-20T14:58:00Z", message: "TypeError: Cannot read properties of undefined (reading 'id')" });
    expect(event.stack).toHaveLength(4);
  });
});

describe("the reader", () => {
  const fetchFor = (routes: Record<string, () => Response>) =>
    vi.fn(async (url: string | URL, init: RequestInit) => {
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      const headers = init.headers as Record<string, string>;
      if (headers.authorization !== "Bearer tok-1") return new Response("", { status: 401 });
      const route = Object.entries(routes).find(([p]) => path.startsWith(p));
      return route === undefined ? new Response("", { status: 404 }) : route[1]();
    });

  it("reads the project, its unresolved issues and an issue's latest event with the token, and says when there is none", async () => {
    const fetchImpl = fetchFor({
      "/api/0/projects/acme/web/issues/": () => Response.json([apiIssue()]),
      "/api/0/projects/acme/web/": () => Response.json({ slug: "web", name: "Web" }),
      "/api/0/issues/6081234567/events/latest/": () => Response.json(apiEvent),
      "/api/0/issues/6081234567/": () => Response.json(apiIssue()),
    });
    let token: string | null = "tok-1";
    const reader = createSentryReader(fetchImpl, { apiUrl: "https://sentry.io/", token: async () => token });
    expect(await reader.access({ kind: "sentry-project", org: "acme", project: "web" })).toEqual({ ok: true, name: "Web" });
    const issues = await reader.issues({ kind: "sentry-project", org: "acme", project: "web" });
    expect(issues.map((i) => i.shortId)).toEqual(["WEB-12"]);
    expect(String(fetchImpl.mock.calls.at(-1)![0])).toBe("https://sentry.io/api/0/projects/acme/web/issues/?query=is%3Aunresolved&sort=date&limit=50&statsPeriod=");
    expect((await reader.latestEvent("6081234567"))?.stack).toHaveLength(4);
    expect((await reader.issue("6081234567"))?.id).toBe("6081234567");
    expect(await reader.issue("1")).toBeNull();
    expect(await reader.latestEvent("1")).toBeNull();
    expect(await reader.access({ kind: "sentry-project", org: "acme", project: "other" })).toEqual({ ok: false, error: "Sentry answered HTTP 404 to GET /api/0/projects/acme/other/" });

    token = "wrong";
    await expect(reader.issues({ kind: "sentry-project", org: "acme", project: "web" })).rejects.toThrow(/Sentry refused the token \(401\)/u);
    token = null;
    const noToken = await reader.issues({ kind: "sentry-project", org: "acme", project: "web" }).catch((e: unknown) => e);
    expect(noToken).toBeInstanceOf(SentryApiError);
    expect((noToken as Error).message).toBe(NO_TOKEN);
    // The token never leaves the header: no call was made without one, and no error names it.
    expect(fetchImpl.mock.calls.every(([, init]) => String((init.headers as Record<string, string>).authorization).startsWith("Bearer "))).toBe(true);
  });
});

describe("sightings", () => {
  const issue = (over: Partial<SentryIssue> = {}): SentryIssue => ({ ...issueOf(apiIssue())!, ...over });
  const old = { firstSeen: "2026-10-01T00:00:00Z" };

  it("are the issues first seen, regressed, rung or known and still firing since the last look, ordered by why", () => {
    const fresh = issue();
    const regressed = issue({ id: "2", shortId: "WEB-2", ...old, substatus: "regressed", lastSeen: "2026-10-20T14:59:00Z" });
    const rung = issue({ id: "3", shortId: "WEB-3", ...old, substatus: "ongoing", lastSeen: "2026-10-20T14:50:00Z" });
    const known = issue({ id: "4", shortId: "WEB-4", ...old, substatus: "ongoing", lastSeen: "2026-10-20T14:40:00Z" });
    const quiet = issue({ id: "5", shortId: "WEB-5", ...old, substatus: "ongoing", lastSeen: "2026-10-20T13:00:00Z" });
    const knownButQuiet = issue({ id: "6", shortId: "WEB-6", ...old, substatus: "ongoing", lastSeen: "2026-10-20T13:00:00Z" });
    const resolved = issue({ id: "7", shortId: "WEB-7", status: "resolved" });
    const out = sentrySightings([quiet, known, rung, fresh, regressed, knownButQuiet, resolved], { since }, new Set(["3", "7"]), new Set(["4", "6"]));
    expect(out.map((s) => [s.issue.shortId, s.reasons])).toEqual([
      ["WEB-2", ["regressed"]],
      ["WEB-12", ["new"]],
      ["WEB-3", ["rung"]],
      ["WEB-4", ["ongoing"]],
    ]);
    // A new issue that is also rung is both; "ongoing" is not said of it.
    expect(sentrySightings([fresh], { since }, new Set(["6081234567"]), new Set(["6081234567"]))[0]!.reasons).toEqual(["new", "rung"]);
    // An issue read by id is the target's organization's only when its permalink says so; one without a permalink is taken on trust.
    expect(issueInOrg({ permalink: "https://acme.sentry.io/issues/1/" }, "acme")).toBe(true);
    expect(issueInOrg({ permalink: "https://sentry.example.com/organizations/acme/issues/1/" }, "acme")).toBe(true);
    expect(issueInOrg({ permalink: "https://other.sentry.io/issues/1/" }, "acme")).toBe(false);
    expect(issueInOrg({ permalink: "https://sentry.example.com/organizations/other/issues/1/" }, "acme")).toBe(false);
    expect(issueInOrg({ permalink: null }, "acme")).toBe(true);
    expect(issueInOrg({ permalink: "not a url" }, "acme")).toBe(true);
    // An old regression Sentry still labels regressed is not news again once it was seen before the last look.
    expect(sentrySightings([issue({ ...old, substatus: "regressed", lastSeen: "2026-10-20T12:00:00Z" })], { since }, new Set(), new Set())).toEqual([]);
  });
});

describe("what changed between two looks", () => {
  const finding = (over: Partial<SentryFinding> = {}): SentryFinding => ({
    fingerprint: "6081234567",
    shortId: "WEB-12",
    title: "TypeError",
    culprit: null,
    permalink: "https://acme.sentry.io/issues/6081234567/",
    level: "error",
    substatus: "new",
    count: 17,
    userCount: 3,
    firstSeen: "2026-10-20T14:30:00Z",
    lastSeen: "2026-10-20T14:58:00Z",
    reasons: ["new"],
    event: null,
    class: "new",
    ticket: null,
    ticketState: null,
    firstSeenAt: now,
    lastCommentedAt: null,
    ...over,
  });
  const look = (findings: SentryFinding[], error: string | null = null): SentryLook => ({ at: now, target: "sentry-project/acme/web", error, unresolved: findings.length, recent: [], notes: [], findings });
  const hour = 3_600_000;

  it("makes a new, returned or regressed issue worth a turn at once, and a rung one once per requeue", () => {
    const fresh = look([finding()]);
    expect(sentryChanges(null, fresh, hour)).toEqual([{ text: "New Sentry issue: WEB-12 TypeError (https://acme.sentry.io/issues/6081234567/)", actionable: true }]);
    expect(sentryChanges(fresh, fresh, hour)).toEqual([]);
    const filed = look([finding({ class: "recurring", ticket: "OPS-5", ticketState: "In Progress", reasons: ["ongoing"] })]);
    expect(sentryChanges(fresh, filed, hour)).toEqual([]);
    // A second event under the open ticket: a comment is due when the steward has not spoken within a requeue.
    const rung = look([finding({ class: "recurring", ticket: "OPS-5", reasons: ["rung"], count: 18 })]);
    expect(sentryChanges(filed, rung, hour)).toEqual([{ text: "Sentry rang for WEB-12 under OPS-5: 18 events, last 2026-10-20T14:58:00Z", actionable: true }]);
    const commented = look([finding({ class: "recurring", ticket: "OPS-5", reasons: ["rung"], count: 19, lastCommentedAt: now - 10 * 60_000 })]);
    expect(sentryChanges(rung, commented, hour)).toEqual([{ text: "Sentry rang for WEB-12 under OPS-5: 19 events, last 2026-10-20T14:58:00Z", actionable: false }]);
    // Sentry marking it regressed while the ticket is open is evidence that moved.
    const regressed = look([finding({ class: "recurring", ticket: "OPS-5", reasons: ["regressed"], substatus: "regressed" })]);
    expect(sentryChanges(filed, regressed, hour)).toEqual([{ text: "Regressed in Sentry under OPS-5: WEB-12 TypeError (https://acme.sentry.io/issues/6081234567/)", actionable: true }]);
    expect(sentryChanges(regressed, regressed, hour)).toEqual([]);
    // Back after its ticket was Done.
    const back = look([finding({ class: "returned", ticket: "OPS-5", ticketState: "Done", reasons: ["ongoing"] })]);
    expect(sentryChanges(filed, back, hour)).toEqual([{ text: "Back after OPS-5 was resolved (Done): WEB-12 TypeError (https://acme.sentry.io/issues/6081234567/)", actionable: true }]);
    expect(sentryChanges(filed, look([]), hour)).toEqual([{ text: "No longer seen: WEB-12 (OPS-5)", actionable: false }]);
    // A known issue seen again for the first time by this look is quiet.
    expect(sentryChanges(null, filed, hour)).toEqual([{ text: "Seen again under OPS-5: WEB-12 TypeError (https://acme.sentry.io/issues/6081234567/)", actionable: false }]);
  });

  it("wakes once for a missing token, and is quiet about any other read failure", () => {
    const noToken = look([], NO_TOKEN);
    expect(sentryChanges(null, noToken, hour)).toEqual([{ text: `Cannot read sentry-project/acme/web: ${NO_TOKEN}`, actionable: true }]);
    expect(sentryChanges(noToken, noToken, hour)).toEqual([]);
    const forbidden = look([], "Sentry answered HTTP 403 to GET /api/0/projects/acme/web/issues/");
    expect(sentryChanges(noToken, forbidden, hour)).toEqual([{ text: "Cannot read sentry-project/acme/web: Sentry answered HTTP 403 to GET /api/0/projects/acme/web/issues/", actionable: false }]);
    expect(sentryChanges(forbidden, look([]), hour)).toEqual([{ text: "sentry-project/acme/web is readable again", actionable: false }]);
  });

  it("classifies against the fingerprint map like any ops sighting", () => {
    const sighting = { fingerprint: "6081234567", workload: "WEB-12", pods: [], container: null, signature: "new", summary: "WEB-12: TypeError", restarts: 0, events: [], logs: null, previous: false };
    const rows = new Map([["6081234567", { fingerprint: "6081234567", ticketKey: "OPS-5", firstSeenAt: 1, lastCommentedAt: null }]]);
    expect(classify([sighting], rows, new Map([["OPS-5", { state: "Done", stateType: "completed" }]]), now)[0]).toMatchObject({ class: "returned", ticket: "OPS-5" });
  });
});
