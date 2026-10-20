import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH, DEFAULT_SLA, alertFingerprint, alertLine, batchAlert, deadlineAt, dueDate, isBatchable, priorityFor, sightingOf } from "./deps.js";
import type { DependabotAlert } from "./source-contract.js";

const alert = (over: Partial<DependabotAlert> = {}): DependabotAlert => ({
  id: "acme/web#4",
  repo: "acme/web",
  number: 4,
  severity: "high",
  package: "lodash",
  ecosystem: "npm",
  manifestPath: "package-lock.json",
  state: "open",
  ghsaId: "GHSA-xxxx-yyyy-zzzz",
  fixedVersion: "4.17.21",
  summary: "Prototype pollution",
  url: "https://github.com/acme/web/security/dependabot/4",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  ...over,
});

const now = Date.parse("2026-10-14T15:00:00Z");

describe("severity and the SLA", () => {
  it("maps each severity to its Linear priority", () => {
    expect(priorityFor("critical")).toBe("urgent");
    expect(priorityFor("high")).toBe("high");
    expect(priorityFor("medium")).toBe("medium");
    expect(priorityFor("low")).toBe("low");
  });

  it("makes asap due now and a duration due first-seen plus the SLA", () => {
    expect(deadlineAt("critical", DEFAULT_SLA, now)).toBe(now);
    expect(deadlineAt("high", DEFAULT_SLA, now)).toBe(now + 86_400_000);
    expect(deadlineAt("medium", DEFAULT_SLA, now)).toBe(now + 7 * 86_400_000);
    expect(deadlineAt("low", DEFAULT_SLA, now)).toBe(now + 30 * 86_400_000);
    expect(dueDate(now + 86_400_000)).toBe("2026-10-15");
  });

  it("batches only medium and low", () => {
    expect(isBatchable("critical")).toBe(false);
    expect(isBatchable("high")).toBe(false);
    expect(isBatchable("medium")).toBe(true);
    expect(isBatchable("low")).toBe(true);
  });
});

describe("batching", () => {
  const low = { repo: "acme/web", ecosystem: "npm", severity: "low" as const };
  const medium = { ...low, severity: "medium" as const };

  it("gives a critical or high alert a ticket of its own", () => {
    const open = [{ ticketKey: "ENG-1", repo: "acme/web", ecosystem: "npm", dueAt: now + 30 * 86_400_000 }];
    expect(batchAlert({ ...low, severity: "critical" }, now, open)).toEqual({ kind: "new" });
    expect(batchAlert({ ...low, severity: "high" }, now, open)).toEqual({ kind: "new" });
  });

  it("joins an open ticket whose due date is inside the new alert's deadline", () => {
    const due = now + 30 * 86_400_000;
    const open = [{ ticketKey: "ENG-1", repo: "acme/web", ecosystem: "npm", dueAt: due }];
    // The second low alert has the same deadline: the ticket is already as urgent.
    expect(batchAlert(low, due, open)).toEqual({ kind: "join", ticketKey: "ENG-1" });
    // A later alert with a longer deadline still joins.
    expect(batchAlert(low, due + 86_400_000, open)).toEqual({ kind: "join", ticketKey: "ENG-1" });
  });

  it("tightens the due date when the new alert is more urgent", () => {
    const due = now + 30 * 86_400_000;
    const open = [{ ticketKey: "ENG-1", repo: "acme/web", ecosystem: "npm", dueAt: due }];
    expect(batchAlert(medium, now + 7 * 86_400_000, open)).toEqual({ kind: "tighten", ticketKey: "ENG-1", dueAt: now + 7 * 86_400_000 });
  });

  it("starts a ticket when nothing open matches the repo and ecosystem", () => {
    const open = [{ ticketKey: "ENG-1", repo: "acme/web", ecosystem: "pip", dueAt: now }];
    expect(batchAlert(low, now + 30 * 86_400_000, open)).toEqual({ kind: "new" });
    expect(batchAlert({ ...low, repo: "acme/other" }, now + 30 * 86_400_000, open)).toEqual({ kind: "new" });
  });

  it("picks the tightest of several open tickets", () => {
    const open = [
      { ticketKey: "ENG-1", repo: "acme/web", ecosystem: "npm", dueAt: now + 30 * 86_400_000 },
      { ticketKey: "ENG-2", repo: "acme/web", ecosystem: "npm", dueAt: now + 7 * 86_400_000 },
    ];
    expect(batchAlert(low, now + 30 * 86_400_000, open)).toEqual({ kind: "join", ticketKey: "ENG-2" });
  });
});

describe("alert rendering", () => {
  it("names the fingerprint, the package, the fix and the link", () => {
    expect(alertFingerprint(alert())).toBe("acme/web#4");
    expect(sightingOf(alert())).toMatchObject({ fingerprint: "acme/web#4", severity: "high", ecosystem: "npm" });
    const line = alertLine(alert());
    expect(line).toMatch(/GHSA-xxxx-yyyy-zzzz/u);
    expect(line).toMatch(/lodash/u);
    expect(line).toMatch(/fixed in 4\.17\.21/u);
    expect(alertLine(alert({ fixedVersion: null, ghsaId: null }))).toMatch(/no fixed version yet/u);
  });
});

describe("the defaults", () => {
  it("are the ticket's", () => {
    expect(DEFAULT_SLA).toEqual({ critical: "asap", high: 86_400_000, medium: 7 * 86_400_000, low: 30 * 86_400_000 });
    expect(DEFAULT_BATCH).toEqual({ medium: 7 * 86_400_000, low: 30 * 86_400_000 });
  });
});
