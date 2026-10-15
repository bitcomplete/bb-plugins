import { describe, expect, it } from "vitest";
import { NO_OPT_OUT, readOptOut } from "./optout.js";

describe("readOptOut", () => {
  it("reads each false as an opt-out", () => {
    expect(
      readOptOut({ role: "project", threadBriefs: { rename: false, group: false, archive: false } }),
    ).toEqual({ rename: true, group: true, archive: true });
    expect(readOptOut({ threadBriefs: { archive: false } })).toEqual({
      rename: false,
      group: false,
      archive: true,
    });
  });

  it("leaves everything on for anything but false", () => {
    // A typo or a truthy string must not quietly exempt a thread.
    expect(readOptOut({ threadBriefs: { rename: true, group: "no", archive: 0 } })).toEqual(
      NO_OPT_OUT,
    );
    expect(readOptOut({ threadBriefs: null })).toEqual(NO_OPT_OUT);
    expect(readOptOut({})).toEqual(NO_OPT_OUT);
    expect(readOptOut(undefined)).toEqual(NO_OPT_OUT);
  });
});
