import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { canonicalPrUrl, prHoldFor } from "./pr-holds.js";
import { createPrHoldStore, PR_HOLD_MIGRATIONS } from "./pr-hold-store.js";

const URL = "https://github.com/acme/widget/pull/42";
describe("manual PR holds", () => {
  it("shares one durable hold across copied links and checkout clones", () => {
    const db = new Database(":memory:");
    for (const migration of PR_HOLD_MIGRATIONS) db.exec(migration);
    const store = createPrHoldStore(db, () => 123);
    expect(store.set("https://GitHub.com/Acme/Widget/pull/42/?tab=files#review", true, "  Await launch decision  "))
      .toEqual({ [URL]: { reason: "Await launch decision", heldAt: 123 } });
    const restored = createPrHoldStore(db, () => 456);
    expect(prHoldFor("https://github.com/ACME/WIDGET/pull/42", restored.list())).toEqual({ reason: "Await launch decision", heldAt: 123 });
    expect(restored.set(URL, true, "Updated decision")).toEqual({ [URL]: { reason: "Updated decision", heldAt: 123 } });
    expect(restored.set("https://github.com/Acme/Widget/pull/42/", false)).toEqual({});
    expect(store.get(URL)).toBeNull();
    db.close();
  });
  it.each(["https://evil.test/acme/widget/pull/42", "https://github.com/acme/widget/issues/42", "http://github.com/acme/widget/pull/42", "https://secret@github.com/acme/widget/pull/42", "https://github.com/acme/widget/pull/0", "https://github.com/acme/widget/pull/42/files"])("rejects non-PR identity %s", (value) => {
    expect(canonicalPrUrl(value)).toBeNull();
    expect(prHoldFor(value, {})).toBeNull();
  });
});
