import { describe, expect, it } from "vitest";
import { ADOPTION_CHOICES, DEFAULT_BATCH, DEFAULT_SLA, adoptionChoices, adoptionHow, adoptionQuestion, alertClockAt, alertFingerprint, alertLine, batchAlert, dateInText, deadlineAt, depsFindingSchema, depsLookSchema, dueDate, isBatchable, overdue, priorityFor, reminderText, sightingOf, snoozeUntil } from "./deps.js";
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
    expect(dueDate(now + 86_400_000, "UTC")).toBe("2026-10-15");
    // The project's time zone decides the calendar day.
    expect(dueDate(Date.parse("2026-10-15T01:00:00Z"), "America/New_York")).toBe("2026-10-14");
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

describe("a finding's classification fields", () => {
  it("carries the close date, the window and the assignee, defaulting dedupUnavailable", () => {
    const finding = {
      fingerprint: "acme/web#4",
      alertNumber: 4,
      severity: "high" as const,
      package: "lodash",
      ecosystem: "npm",
      manifestPath: null,
      ghsaId: null,
      fixedVersion: null,
      summary: "high lodash",
      state: "open",
      url: null,
      dueAt: now,
      priority: "high",
      class: "returned" as const,
      ticket: "ENG-50",
      ticketState: "Done",
      closedAt: "2026-10-05T00:00:00Z",
      window: "within" as const,
      assignee: "Jane",
      firstSeenAt: now,
      lastCommentedAt: null,
      batch: { kind: "new" as const },
    };
    expect(depsFindingSchema.parse(finding)).toMatchObject({ closedAt: "2026-10-05T00:00:00Z", window: "within", assignee: "Jane", dedupUnavailable: false });
    expect(depsFindingSchema.parse({ ...finding, closedAt: null, window: null, dedupUnavailable: true })).toMatchObject({ closedAt: null, window: null, dedupUnavailable: true });
  });
});

describe("the defaults", () => {
  it("are the ticket's", () => {
    expect(DEFAULT_SLA).toEqual({ critical: "asap", high: 86_400_000, medium: 7 * 86_400_000, low: 30 * 86_400_000 });
    expect(DEFAULT_BATCH).toEqual({ medium: 7 * 86_400_000, low: 30 * 86_400_000 });
  });
});

describe("the SLA clock is the alert's own created_at", () => {
  it("starts at created_at when it parses, else at first seen", () => {
    expect(alertClockAt(alert({ createdAt: "2026-10-29T00:19:43Z" }), now)).toBe(Date.parse("2026-10-29T00:19:43Z"));
    expect(alertClockAt(alert({ createdAt: null }), now)).toBe(now);
    expect(alertClockAt(alert({ createdAt: "not a date" }), now)).toBe(now);
  });

  it("gives a binding recreated later the same deadline, not a fresh one (SC-111)", () => {
    const created = Date.parse("2026-10-29T00:19:43Z");
    const filedBy = deadlineAt("medium", DEFAULT_SLA, alertClockAt(alert({ createdAt: "2026-10-29T00:19:43Z" }), created));
    const recreatedAt = Date.parse("2026-10-31T15:48:52Z");
    const seenAgain = deadlineAt("medium", DEFAULT_SLA, alertClockAt(alert({ createdAt: "2026-10-29T00:19:43Z" }), recreatedAt));
    expect(seenAgain).toBe(filedBy);
    expect(dueDate(seenAgain, "UTC")).toBe("2026-11-05");
    expect(dueDate(seenAgain, "America/New_York")).toBe("2026-11-04");
  });

  it("snoozes Keep tracking to the note's date, or one SLA window from now when it gives none", () => {
    const at = Date.parse("2026-10-29T00:00:00Z");
    expect(dateInText("Chose: Keep tracking — 2026-11-20")).toBe(Date.parse("2026-11-20T12:00:00Z"));
    expect(dateInText("nothing here")).toBeNull();
    expect(snoozeUntil("Chose: Keep tracking — 2026-11-20", "medium", DEFAULT_SLA, at)).toBe(Date.parse("2026-11-20T12:00:00Z"));
    expect(snoozeUntil("Chose: Keep tracking", "medium", DEFAULT_SLA, at)).toBe(at + 7 * 86_400_000);
  });
});

describe("the adoption decision", () => {
  it("leads with Adopt when a fix exists and with Dismiss when none does", () => {
    expect(adoptionChoices(true, true)).toEqual([ADOPTION_CHOICES.adopt, ADOPTION_CHOICES.keep, ADOPTION_CHOICES.dismiss]);
    expect(adoptionChoices(false, true)).toEqual([ADOPTION_CHOICES.dismiss, ADOPTION_CHOICES.keep, ADOPTION_CHOICES.adopt]);
  });

  it("offers no Dismiss when the playbook's may list does not allow it", () => {
    expect(adoptionChoices(true, false)).toEqual([ADOPTION_CHOICES.adopt, ADOPTION_CHOICES.keep]);
    expect(adoptionChoices(false, false)).toEqual([ADOPTION_CHOICES.keep, ADOPTION_CHOICES.adopt]);
    expect(adoptionHow(false)).not.toMatch(/Dismiss/u);
    expect(adoptionHow(true)).toMatch(/Dismiss as not used/u);
  });

  it("asks one line naming the ticket, the alerts, the fix and the due date, and says when it is overdue", () => {
    const echo = { severity: "medium" as const, package: "github.com/labstack/echo/v4", ecosystem: "go", fixedVersion: null };
    expect(adoptionQuestion("SC-111", "bitcomplete/santaclaw", [echo, echo], "2026-11-04")).toBe("Adopt SC-111? medium Dependabot alerts (2) on bitcomplete/santaclaw: github.com/labstack/echo/v4 (go), no fixed version, due 2026-11-04.");
    expect(adoptionQuestion("ENG-50", "acme/web", [alert()], null)).toBe("Adopt ENG-50? high Dependabot alert on acme/web: lodash (npm), fix available.");
    expect(adoptionQuestion("ENG-50", "acme/web", [alert({ severity: "low" }), alert({ severity: "medium", package: "axios", fixedVersion: null })], "2026-11-01")).toMatch(/^Adopt ENG-50\? medium\/low Dependabot alerts \(2\) on acme\/web: lodash, axios \(npm\), fix for 1 of 2, due 2026-11-01\.$/u);
    expect(adoptionQuestion("ENG-50", "acme/web", [alert()], "2026-11-04", 2)).toMatch(/due 2026-11-04\. Overdue by 2 days\.$/u);
    expect(adoptionQuestion("ENG-50", "acme/web", [alert()], "2026-11-04", 1)).toMatch(/Overdue by 1 day\.$/u);
  });

  it("words the one overdue reminder with the days past the due date", () => {
    expect(overdue(Date.parse("2026-11-04T12:00:00Z"), Date.parse("2026-11-04T12:00:00Z"), "UTC")).toBe(false);
    expect(overdue(Date.parse("2026-11-04T12:00:00Z"), Date.parse("2026-11-05T12:00:00Z"), "UTC")).toBe(true);
    expect(reminderText("SC-111", "2026-11-04", Date.parse("2026-11-05T12:00:00Z"), "UTC")).toBe("SC-111 is a day past its due date (2026-11-04) and still unadopted.");
    expect(reminderText("SC-111", "2026-11-04", Date.parse("2026-11-10T12:00:00Z"), "UTC")).toBe("SC-111 is 6 days past its due date (2026-11-04) and still unadopted.");
  });

  it("parses an older look without the ticket's labels or created_at", () => {
    const parsed = depsFindingSchema.parse({ fingerprint: "acme/web#4", alertNumber: 4, severity: "high", package: "lodash", ecosystem: "npm", manifestPath: null, ghsaId: null, fixedVersion: null, summary: "x", state: "open", url: null, dueAt: now, priority: "high", class: "new", ticket: null, ticketState: null, closedAt: null, window: null, assignee: "Jane", firstSeenAt: now, lastCommentedAt: null, batch: { kind: "new" } });
    expect(parsed).toMatchObject({ ticketLabels: [], alertCreatedAt: null });
  });
});

describe("the dependency look", () => {
  const look = { at: now, target: "dependabot/acme/web", error: null, viewer: "Jane", alerts: [] };

  it("keeps the graph-empty flag when present and treats a look stored before it as not empty (BB-289)", () => {
    expect(depsLookSchema.parse({ ...look, graphEmpty: true }).graphEmpty).toBe(true);
    expect(depsLookSchema.parse({ ...look, graphEmpty: false }).graphEmpty).toBe(false);
    // A look written before the field parses; absent means false, so the wake says "no open alerts".
    expect(depsLookSchema.parse(look).graphEmpty).toBeUndefined();
  });
});
