import { describe, expect, it } from "vitest";
import { prWorkItemKey, workItemIndex } from "./work-item-index.js";

const url = "https://github.com/inkwell/folio/pull/42";

describe("PR work item observations", () => {
  it("joins copied URL forms, prefers fresh inventory, and retains checkout evidence", () => {
    const items = workItemIndex(
      [{ url: `${url}?tab=files`, stale: true, value: "stale" }, { url: url.toUpperCase() + "/", stale: false, value: "fresh" }],
      [{ url: `${url}#discussion`, path: "/p/folio-second", tickets: ["INK-2", "INK-1"], value: "second" },
        { url, path: "/p/folio-first", tickets: ["INK-1"], value: "first" }],
    );
    expect(items.size).toBe(1);
    expect(items.get(url)).toEqual({ key: url, remote: "fresh", locals: ["second", "first"],
      paths: ["/p/folio-first", "/p/folio-second"], tickets: ["INK-1", "INK-2"] });
    expect(prWorkItemKey("malformed-url/")).toBe("malformed-url");
  });
  it("takes ticket refs from the selected inventory observation in either order", () => {
    const stale = { url, stale: true, tickets: ["INK-OLD"], value: "stale" };
    const fresh = { url: `${url}?tab=files`, stale: false, tickets: ["INK-NEW"], value: "fresh" };
    const checkout = { url, path: "/p/folio", tickets: ["INK-LOCAL"], value: "checkout" };
    for (const remotes of [[stale, fresh], [fresh, stale]]) {
      expect(workItemIndex(remotes, [checkout]).get(url)).toMatchObject({ remote: "fresh", tickets: ["INK-LOCAL", "INK-NEW"] });
    }
  });
});
