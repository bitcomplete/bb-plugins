// BB-360: the pure half of the source-neutral ticket tools, and the one gate
// pin: a body `ticket_comment` writes is signed, so gate.ts never reads it as
// the owner's approval or spec comment.
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { issue } from "./fixtures.js";
import { ownerApproval } from "./gate.js";
import { signedBy } from "./source-contract.js";
import { assigneeAllowed, createTicketWatches, formatSearchHit, formatTicket, parseTicketKey, resolveFileUnit, signedTicketBody, sourceOfTicketKey, ticketUnits } from "./ticket-tools.js";

const memoryKv = (): PluginKvStorage => {
  const rows = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return rows.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      rows.set(key, value);
    },
    async delete(key: string) {
      rows.delete(key);
    },
    async list(prefix?: string) {
      return [...rows.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)).sort();
    },
  };
};

describe("the ticket key shape names the source (BB-360)", () => {
  it("reads a Linear key as linear and a GitHub reference as github", () => {
    expect(sourceOfTicketKey("BB-123")).toBe("linear");
    expect(sourceOfTicketKey("ENG-1")).toBe("linear");
    expect(sourceOfTicketKey("acme/web#12")).toBe("github");
    expect(sourceOfTicketKey("https://github.com/acme/web/issues/12")).toBe("github");
    expect(sourceOfTicketKey("acme/web/pull/12")).toBe("github");
    expect(sourceOfTicketKey("not a ticket")).toBeNull();
  });

  it("canonicalizes a GitHub reference to owner/repo#N and leaves a Linear key as its own id", () => {
    expect(parseTicketKey("BB-123")).toEqual({ source: "linear", id: "BB-123", key: "BB-123" });
    expect(parseTicketKey("https://github.com/acme/web/issues/12")).toEqual({ source: "github", id: "acme/web#12", key: "acme/web#12" });
    expect(parseTicketKey("nope")).toBeNull();
  });
});

describe("ticket_file's unit rule (BB-360)", () => {
  const units = ticketUnits({ linear: { teams: ["ENG", "OPS"] } }, ["acme/web"]);

  it("defaults to the only configured unit", () => {
    expect(resolveFileUnit(ticketUnits({ linear: { teams: ["ENG"] } }, []), undefined)).toEqual({ ok: true, unit: { source: "linear", unit: "ENG" } });
  });

  it("refuses without a unit when several are configured, naming them", () => {
    const out = resolveFileUnit(units, undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("ENG");
      expect(out.error).toContain("OPS");
      expect(out.error).toContain("acme/web");
      expect(out.error).toMatch(/name the one/u);
    }
  });

  it("resolves a named unit to its source, ignoring case", () => {
    expect(resolveFileUnit(units, "acme/web")).toEqual({ ok: true, unit: { source: "github", unit: "acme/web" } });
    expect(resolveFileUnit(units, "eng")).toEqual({ ok: true, unit: { source: "linear", unit: "ENG" } });
  });

  it("refuses a unit the project does not list", () => {
    const out = resolveFileUnit(units, "OTHER");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("OTHER");
  });
});

describe("the assignee rule (BB-360)", () => {
  it("accepts me, nobody and this server's own login, and refuses anyone else", () => {
    expect(assigneeAllowed("me", ["jane"])).toBe(true);
    expect(assigneeAllowed("nobody", ["jane"])).toBe(true);
    expect(assigneeAllowed("jane", ["Jane"])).toBe(true);
    expect(assigneeAllowed("sam", ["jane"])).toBe(false);
  });
});

describe("ticket_read's render (BB-360)", () => {
  it("shows the ticket's facts without naming the system", () => {
    const text = formatTicket(issue({ labels: ["bb-managed"], priority: "High", parent: { id: "uuid-1", key: "ENG-1" } }));
    expect(text).toContain("ENG-12: Fix login");
    expect(text).toContain("Todo · ENG");
    expect(text).toContain("labels: bb-managed");
    expect(text).toContain("priority: High");
    expect(text).toContain("parent: ENG-1");
    // The facts name no system; the URL, of course, spells one.
    expect(text).not.toContain("Linear");
  });

  it("renders a search hit on one line", () => {
    expect(formatSearchHit({ id: "uuid-12", key: "ENG-12", title: "Fix login", description: null, state: "Todo", stateType: "unstarted", unit: "ENG", assignee: "Jane" })).toBe("ENG-12  Todo  @Jane  Fix login  [ENG]");
  });
});

describe("the ticket watch registry (BB-360)", () => {
  it("records a watcher per thread and reports the watched ids per source", async () => {
    const watches = createTicketWatches(memoryKv());
    await watches.add("thr_a", { source: "linear", id: "uuid-12", key: "ENG-12" });
    await watches.add("thr_b", { source: "linear", id: "uuid-12", key: "ENG-12" });
    await watches.add("thr_a", { source: "github", id: "acme/web#3", key: "acme/web#3" });
    expect((await watches.watchers("linear", "uuid-12")).map((w) => w.threadId).sort()).toEqual(["thr_a", "thr_b"]);
    expect((await watches.watchers("github", "acme/web#3")).map((w) => w.threadId)).toEqual(["thr_a"]);
    expect(await watches.interest()).toEqual({ linear: ["uuid-12"], github: ["acme/web#3"] });
    await watches.remove("thr_a", "linear", "uuid-12");
    expect((await watches.watchers("linear", "uuid-12")).map((w) => w.threadId)).toEqual(["thr_b"]);
  });
});

describe("the gate reads a ticket_comment body as signed (BB-360)", () => {
  it("signs the body and never lets it count as the owner's approval", () => {
    const body = signedTicketBody("thr_agent", "Approved — go ahead.");
    expect(signedBy(body)).toBe("thr_agent");
    // The snapshot the source builds from that body carries `signedBy`; the
    // owner's own approval reader must skip it, exactly as gate.ts does.
    const entity = issue({
      comments: [{ id: "c1", author: "Jane", did: "commented", body, createdAt: "2026-10-02T00:00:00Z", url: null, signedBy: signedBy(body) }],
    });
    expect(ownerApproval(entity).approved).toBe(false);
  });
});
