import { describe, expect, it } from "vitest";
import { readOptOut } from "./optout.js";

describe("readOptOut", () => {
  it("reads the switch as off only for false", () => {
    expect(readOptOut({ role: "steward", threadBriefs: false })).toBe(true);
    expect(readOptOut({ threadBriefs: true })).toBe(false);
    expect(readOptOut({ threadBriefs: "false" })).toBe(false);
    expect(readOptOut({ threadBriefs: null })).toBe(false);
  });

  it("reads the legacy object as off when any one key is false", () => {
    expect(
      readOptOut({
        role: "project",
        threadBriefs: { rename: false, group: false, archive: false, ring: false },
      }),
    ).toBe(true);
    // Any single key is enough: the four were independent, and one of them
    // being off is what the old shape meant.
    expect(readOptOut({ threadBriefs: { rename: false } })).toBe(true);
    expect(readOptOut({ threadBriefs: { group: false } })).toBe(true);
    expect(readOptOut({ threadBriefs: { archive: false } })).toBe(true);
    expect(readOptOut({ threadBriefs: { ring: false } })).toBe(true);
  });

  it("leaves a legacy object with every key true on", () => {
    expect(
      readOptOut({ threadBriefs: { rename: true, group: true, archive: true, ring: true } }),
    ).toBe(false);
    // A partial object with nothing false is on too: the legacy reading is
    // "off when at least one key is false", not "off when not all are true".
    expect(readOptOut({ threadBriefs: { rename: true } })).toBe(false);
  });

  it("leaves a thread with no threadBriefs value on", () => {
    // The namespace exists for the plugin's own role tag; the absence of the
    // key is not an opt-out.
    expect(readOptOut({ role: "steward" })).toBe(false);
    expect(readOptOut({})).toBe(false);
    expect(readOptOut(undefined)).toBe(false);
    expect(readOptOut(null)).toBe(false);
  });
});
