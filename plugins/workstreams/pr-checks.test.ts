import { describe, expect, it } from "vitest";
import { checksFailed, checksGreen } from "./pr-checks.js";

describe("scanned PR checks", () => {
  it.each(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"])(
    "marks %s as failed even alongside passing checks",
    (conclusion) => {
      expect(checksFailed(["SUCCESS", conclusion])).toBe(true);
      expect(checksGreen(["SUCCESS", conclusion])).toBe(false);
    },
  );

  it.each(["PENDING", "IN_PROGRESS", "STALE", "UNKNOWN"])(
    "never treats %s as green or a confirmed failure",
    (conclusion) => {
      expect(checksFailed([conclusion])).toBe(false);
      expect(checksGreen([conclusion])).toBe(false);
    },
  );

  it("accepts completed passing checks and repositories without checks", () => {
    expect(checksGreen(["SUCCESS", "NEUTRAL", "SKIPPED"])).toBe(true);
    expect(checksGreen([])).toBe(true);
    expect(checksFailed([])).toBe(false);
  });
});
