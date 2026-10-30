// Age-in-state and relative-time rules. Fixtures are the invented Inkwell bookstore: repos
// quill, folio, margin, colophon and spine.
import { describe, expect, it } from "vitest";
import { DAY_MS, ageLabel, relativeTime, trackTransitions, type Transition } from "./workstreams.js";

const NOW = Date.parse("2030-01-10T12:00:00Z");

describe("trackTransitions", () => {
  const T0 = NOW - 3 * DAY_MS;
  const table = (entries: [string, Transition][]) => new Map(entries);

  it("records an unknown entry time the first time a unit is seen, because the first scan cannot know how long it has been there", () => {
    const next = trackTransitions(new Map(), [{ path: "/p/quill", lifecycle: "blocked" }], NOW);
    expect(next.get("/p/quill")).toEqual({ lifecycle: "blocked", enteredAt: null });
  });

  it("records the time when a unit is seen ENTERING a state", () => {
    const previous = table([["/p/quill", { lifecycle: "awaiting-review", enteredAt: null }]]);
    const next = trackTransitions(previous, [{ path: "/p/quill", lifecycle: "blocked" }], NOW);
    expect(next.get("/p/quill")).toEqual({ lifecycle: "blocked", enteredAt: NOW });
  });

  it("keeps the entry time while a unit stays put, so 'CI failing 3d' keeps counting across scans", () => {
    const previous = table([["/p/quill", { lifecycle: "blocked", enteredAt: T0 }]]);
    const next = trackTransitions(previous, [{ path: "/p/quill", lifecycle: "blocked" }], NOW);
    expect(next.get("/p/quill")).toEqual({ lifecycle: "blocked", enteredAt: T0 });
  });

  it("resets the entry time when the state changes again", () => {
    const previous = table([["/p/quill", { lifecycle: "blocked", enteredAt: T0 }]]);
    const next = trackTransitions(previous, [{ path: "/p/quill", lifecycle: "awaiting-review" }], NOW);
    expect(next.get("/p/quill")).toEqual({ lifecycle: "awaiting-review", enteredAt: NOW });
  });

  it("drops a unit that left the scan", () => {
    const previous = table([["/p/gone", { lifecycle: "blocked", enteredAt: T0 }]]);
    expect(trackTransitions(previous, [], NOW).size).toBe(0);
  });
});

describe("ageLabel", () => {
  it("prints an observed state age as is", () => {
    expect(ageLabel({ since: NOW - 3 * DAY_MS, basis: "state" }, NOW)).toBe("3d");
  });

  it("SAYS when the age is the last commit, because a proxy must never pass for the state age", () => {
    expect(ageLabel({ since: NOW - 12 * DAY_MS, basis: "last-commit" }, NOW)).toBe("last commit 12d");
  });

  it("says there is no commit date rather than printing a number it does not have", () => {
    expect(ageLabel({ since: null, basis: "last-commit" }, NOW)).toBe("no commit date");
  });

  it("prints hours and minutes for young states", () => {
    expect(ageLabel({ since: NOW - 5 * 3_600_000, basis: "state" }, NOW)).toBe("5h");
    expect(ageLabel({ since: NOW - 45 * 60_000, basis: "state" }, NOW)).toBe("45m");
  });
});

describe("relativeTime", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  it("reads under a minute, and a future time from clock skew, as just now", () => {
    expect(relativeTime(at(0), NOW)).toBe("just now");
    expect(relativeTime(at(59_999), NOW)).toBe("just now");
    expect(relativeTime(at(-5_000), NOW)).toBe("just now");
  });

  it("switches units at the minute, hour and day boundaries", () => {
    expect(relativeTime(at(60_000), NOW)).toBe("1m ago");
    expect(relativeTime(at(59 * 60_000), NOW)).toBe("59m ago");
    expect(relativeTime(at(60 * 60_000), NOW)).toBe("1h ago");
    expect(relativeTime(at(DAY_MS - 1), NOW)).toBe("23h ago");
    expect(relativeTime(at(DAY_MS), NOW)).toBe("1d ago");
  });

  it("says never or unknown rather than inventing a time", () => {
    expect(relativeTime(null, NOW)).toBe("never");
    expect(relativeTime("yesterday-ish", NOW)).toBe("unknown");
  });
});
