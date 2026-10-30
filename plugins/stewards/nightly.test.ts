import { describe, expect, it } from "vitest";
import { localParts, nightOf, nightlyDue, stillNight } from "./nightly.js";

const NY = { at: "01:00", until: "02:45", timezone: "America/New_York" };
// 2026-10-14 05:30Z is 01:30 in New York (EDT, UTC-4).
const at = (isoz: string) => Date.parse(isoz);

describe("the nightly window", () => {
  it("reads local time in the project's zone", () => {
    expect(localParts(at("2026-10-14T05:30:00Z"), NY.timezone)).toEqual({ date: "2026-10-14", minutes: 90 });
  });

  it("is due once per night, inside the window only", () => {
    expect(nightlyDue(at("2026-10-14T04:59:00Z"), NY, null)).toBeNull();
    expect(nightlyDue(at("2026-10-14T05:30:00Z"), NY, null)).toBe("2026-10-14");
    expect(nightlyDue(at("2026-10-14T05:30:00Z"), NY, "2026-10-14")).toBeNull();
    expect(nightlyDue(at("2026-10-14T06:50:00Z"), NY, null)).toBeNull();
    expect(stillNight(at("2026-10-14T06:40:00Z"), NY, "2026-10-14")).toBe(true);
    expect(stillNight(at("2026-10-14T06:46:00Z"), NY, "2026-10-14")).toBe(false);
  });

  it("names a window across midnight by the evening it started", () => {
    const late = { at: "23:00", until: "02:00", timezone: "UTC" };
    expect(nightOf(at("2026-10-14T23:30:00Z"), late)).toBe("2026-10-14");
    expect(nightOf(at("2026-10-15T01:30:00Z"), late)).toBe("2026-10-14");
    expect(nightOf(at("2026-10-15T12:00:00Z"), late)).toBeNull();
  });
});
