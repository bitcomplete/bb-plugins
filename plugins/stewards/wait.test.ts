// BB-333: the typed wait's pure validation. The six named cases are checked
// here without a store: an unknown kind, a missing or malformed reference and a
// date wait with no date are hard refusals; a self or unvalidatable reference is
// accepted and recorded as `external`.
import { describe, expect, it } from "vitest";
import { WAIT_KINDS, isEntityKey, validateWait, type WaitContext } from "./wait.js";

const ctx = (over: Partial<WaitContext> = {}): WaitContext => ({
  isOwnPull: () => false,
  isWatchedRepo: () => true,
  hasDeployment: () => true,
  hasOpenBinding: () => true,
  hasWorker: () => true,
  hasOpenItem: () => true,
  ...over,
});

const v = (kind: string, ref: string | undefined, over: Partial<WaitContext> = {}, until?: string) => validateWait({ kind, ref }, until, ctx(over));

/** A well-formed ref for each kind, so the loop covers the whole set. */
const wellFormed: Record<(typeof WAIT_KINDS)[number], string> = {
  pull: "acme/web#7",
  review: "https://github.com/acme/web/pull/7",
  deployment: "acme/web#7",
  worker: "thr_w1",
  binding: "ENG-12",
  date: "2026-12-01",
  person: "need_1",
  external: "the vendor's reply",
};

describe("the typed wait: the closed kind set", () => {
  it("accepts every kind with a well-formed ref", () => {
    for (const kind of WAIT_KINDS) {
      const ref = wellFormed[kind];
      expect(v(kind, ref), kind).toMatchObject({ ok: true, wait: { kind, ref }, downgraded: null });
    }
  });

  it("refuses an unknown kind by name", () => {
    expect(v("nope", "acme/web#7")).toMatchObject({ ok: false, refusal: "unknown_kind" });
  });

  it("refuses a missing or empty reference by name", () => {
    expect(v("pull", undefined)).toMatchObject({ ok: false, refusal: "missing_reference" });
    expect(v("pull", "   ")).toMatchObject({ ok: false, refusal: "missing_reference" });
  });

  it("refuses a malformed reference by name for each parsing kind", () => {
    expect(v("pull", "acme/web")).toMatchObject({ refusal: "malformed_reference" });
    expect(v("review", "not-a-pull")).toMatchObject({ refusal: "malformed_reference" });
    expect(v("deployment", "acme/web")).toMatchObject({ refusal: "malformed_reference" });
    expect(v("worker", "thr")).toMatchObject({ refusal: "malformed_reference" });
    expect(v("binding", "not a key")).toMatchObject({ refusal: "malformed_reference" });
    expect(v("person", "pr_1")).toMatchObject({ refusal: "malformed_reference" });
  });

  it("refuses a date wait with no date in ref and no until", () => {
    expect(v("date", "next Tuesday")).toMatchObject({ ok: false, refusal: "date_wait_without_date" });
    // An until in the same report supplies the date.
    expect(v("date", "next Tuesday", {}, "2026-12-01")).toMatchObject({ ok: true, wait: { kind: "date", ref: "next Tuesday" } });
    expect(v("date", "2026-12-01")).toMatchObject({ ok: true, wait: { kind: "date", ref: "2026-12-01" } });
  });

  it("accepts a Linear key or a pull key as a binding reference", () => {
    expect(isEntityKey("ENG-12")).toBe(true);
    expect(isEntityKey("acme/web#7")).toBe(true);
    expect(isEntityKey("not a key")).toBe(false);
  });

  it("accepts a base64url page-item or worker id", () => {
    // `newId` produces 9 random bytes as base64url, so the suffix can hold `-` and `_`.
    expect(v("person", "qst_7bXtzENlTTc_")).toMatchObject({ ok: true, wait: { kind: "person", ref: "qst_7bXtzENlTTc_" } });
    expect(v("person", "esc_WRoXHJxRrNPZ")).toMatchObject({ ok: true });
    expect(v("worker", "thr_ab-cd_ef")).toMatchObject({ ok: true, wait: { kind: "worker", ref: "thr_ab-cd_ef" } });
  });
});

describe("the typed wait: the downgrade to external", () => {
  it("downgrades a pull ref that is the binding's own, but not a review ref", () => {
    expect(v("pull", "acme/web#7", { isOwnPull: () => true })).toMatchObject({ ok: true, wait: { kind: "external", ref: "acme/web#7" }, downgraded: "reference_is_self" });
    // A `review` wait on the same own pull is valid and live while unreviewed (the BB-333 design's bb-plugins#294 note).
    expect(v("review", "acme/web#7", { isOwnPull: () => true })).toMatchObject({ ok: true, wait: { kind: "review", ref: "acme/web#7" }, downgraded: null });
  });

  it("downgrades a well-formed ref the plugin cannot resolve", () => {
    expect(v("pull", "acme/web#7", { isWatchedRepo: () => false })).toMatchObject({ downgraded: "unvalidatable_reference", wait: { kind: "external" } });
    expect(v("deployment", "acme/web#7", { hasDeployment: () => false })).toMatchObject({ downgraded: "unvalidatable_reference" });
    expect(v("worker", "thr_w1", { hasWorker: () => false })).toMatchObject({ downgraded: "unvalidatable_reference" });
    expect(v("binding", "ENG-99", { hasOpenBinding: () => false })).toMatchObject({ downgraded: "unvalidatable_reference" });
    expect(v("person", "need_1", { hasOpenItem: () => false })).toMatchObject({ downgraded: "unvalidatable_reference" });
  });

  it("leaves an external wait alone", () => {
    expect(v("external", "the vendor's reply")).toMatchObject({ ok: true, wait: { kind: "external", ref: "the vendor's reply" }, downgraded: null });
  });
});
