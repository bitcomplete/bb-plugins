/**
 * The New project form's derivation and gate rules (BB-219, BB-222).
 *
 * These are the rules behind the acceptance criteria "name/path stop
 * auto-updating once edited", "a checkout is adopted, not cloned beside",
 * "Name, Machine and Location appear only once the probe answers" and "Create
 * is disabled until a probe has answered". They live outside the component so
 * they can be checked without a browser.
 */
import { describe, expect, it } from "vitest";
import { createReady, deriveName, fieldsRevealed, locationFrozen, probeNeeded, sourceFromProbe } from "./new-project-derive.js";

describe("deriving the name from the URL", () => {
  it("uses the URL's last component until the name is edited", () => {
    expect(deriveName("git@github.com:you/acme.git", "", false)).toBe("acme");
    expect(deriveName("https://github.com/you/other.git", "acme", false)).toBe("other");
    // A URL with nothing usable leaves the name empty rather than inventing one.
    expect(deriveName("https://github.com/you/.", "", false)).toBe("");
  });

  it("leaves an edited name alone, whatever the URL becomes", () => {
    expect(deriveName("https://github.com/you/other.git", "acme", true)).toBe("acme");
    expect(deriveName("https://github.com/you/third.git", "acme", true)).toBe("acme");
  });
});

describe("freezing the location", () => {
  it("is frozen by a hand edit or by an adopted checkout, and by neither otherwise", () => {
    expect(locationFrozen(false, false)).toBe(false);
    expect(locationFrozen(true, false)).toBe(true);
    expect(locationFrozen(false, true)).toBe(true);
    expect(locationFrozen(true, true)).toBe(true);
  });

  it("clears an adopted freeze when the URL changes, but never a hand edit", () => {
    // The form clears `pathAdopted` on a URL change; `pathEdited` is untouched.
    // So the suggestion runs again after adopting, but not after typing.
    const afterUrlChangeFromAdoption = { edited: false, adopted: false };
    expect(locationFrozen(afterUrlChangeFromAdoption.edited, afterUrlChangeFromAdoption.adopted)).toBe(false);
    const afterUrlChangeFromEdit = { edited: true, adopted: false };
    expect(locationFrozen(afterUrlChangeFromEdit.edited, afterUrlChangeFromEdit.adopted)).toBe(true);
  });
});

describe("the probe gate", () => {
  it("reveals Name, Machine and Location only after the URL's own probe answers", () => {
    expect(fieldsRevealed(false, "idle")).toBe(false);
    expect(fieldsRevealed(false, "probing")).toBe(false);
    expect(fieldsRevealed(false, "error")).toBe(false);
    expect(fieldsRevealed(false, "done")).toBe(true);
  });

  it("keeps them visible through a machine-change re-probe once revealed", () => {
    // The URL's own probe has answered, so a re-probe and its error do not
    // unmount the Machine select the user is trying to use.
    expect(fieldsRevealed(true, "probing")).toBe(true);
    expect(fieldsRevealed(true, "error")).toBe(true);
    expect(fieldsRevealed(true, "idle")).toBe(true);
  });

  it("keeps Create disabled until a probe has answered, whatever the fields hold", () => {
    const filled = { submitting: false, probe: "done" as const, hostId: "host-a", name: "acme", path: "/home/me/bb/acme" };
    expect(createReady(filled)).toBe(true);
    for (const probe of ["idle", "probing", "error"] as const) {
      expect(createReady({ ...filled, probe })).toBe(false);
    }
    expect(createReady({ ...filled, submitting: true })).toBe(false);
    expect(createReady({ ...filled, hostId: null })).toBe(false);
    expect(createReady({ ...filled, name: "  " })).toBe(false);
    expect(createReady({ ...filled, path: "  " })).toBe(false);
  });

  it("skips a blur or Enter the last answer already covers", () => {
    const last = { url: "https://example.com/acme.git", hostId: "host-a" };
    expect(probeNeeded(last, "https://example.com/acme.git", "host-a")).toBe(false);
    // A new URL, or a new machine, probes again.
    expect(probeNeeded(last, "https://example.com/other.git", "host-a")).toBe(true);
    expect(probeNeeded(last, "https://example.com/acme.git", "host-b")).toBe(true);
    // Nothing to probe with, and nothing to probe for.
    expect(probeNeeded(null, "https://example.com/acme.git", "host-a")).toBe(true);
    expect(probeNeeded(null, "", "host-a")).toBe(false);
    expect(probeNeeded(null, "https://example.com/acme.git", null)).toBe(false);
  });
});

describe("choosing the source from the probe", () => {
  it("clones every remote outcome and adopts only a local checkout", () => {
    for (const outcome of ["primary", "plain"] as const) {
      expect(sourceFromProbe(outcome, "https://example.com/acme.git")).toEqual({
        kind: "clone",
        url: "https://example.com/acme.git",
      });
    }
    expect(sourceFromProbe("checkout", "/home/me/code/acme")).toEqual({
      kind: "checkout",
      url: "/home/me/code/acme",
    });
  });

  it("never produces the removed auto kind", () => {
    for (const outcome of ["primary", "plain", "checkout"] as const) {
      expect(sourceFromProbe(outcome, "x").kind).not.toBe("auto");
    }
  });
});
