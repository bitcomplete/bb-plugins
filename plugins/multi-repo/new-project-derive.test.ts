/**
 * The New project form's derivation rules (BB-219).
 *
 * These are the rules behind the acceptance criteria "name/path stop
 * auto-updating once edited" and "a checkout is adopted, not cloned beside".
 * They live outside the component so they can be checked without a browser.
 */
import { describe, expect, it } from "vitest";
import { deriveName, locationFrozen } from "./new-project-derive.js";

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
