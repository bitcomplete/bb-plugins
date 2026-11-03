// The entry is a deep link, so the contract worth pinning is its rendered
// shape: the route it points at and its label. Rendered to static markup
// rather than mounted, because it has no hooks, which keeps the suite free of
// a DOM.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CreateProjectEntry, NEW_PROJECT_HREF } from "./create-project-entry.js";

describe("CreateProjectEntry", () => {
  it("links to multi-repo's New project form", () => {
    const html = renderToStaticMarkup(<CreateProjectEntry />);
    expect(html).toContain(`href="${NEW_PROJECT_HREF}"`);
    expect(html).toContain("Create a project from a git URL");
  });
});
