// The entry is a deep link, so the contract worth pinning is its rendered
// shape: the route it points at, and whether it is the primary call to action.
// Rendered to static markup rather than mounted, because it has no hooks — the
// project count is a prop — and that keeps the suite free of a DOM.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CreateProjectEntry, NEW_PROJECT_HREF } from "./create-project-entry.js";

describe("CreateProjectEntry", () => {
  it("is the primary call to action when the server has no projects", () => {
    const html = renderToStaticMarkup(<CreateProjectEntry projectCount={0} />);
    expect(html).toContain(`href="${NEW_PROJECT_HREF}"`);
    expect(html).toContain("Create a project from a git URL");
    // The filled default variant, not the secondary link.
    expect(html).toContain("bg-foreground");
    expect(html).not.toContain("underline-offset-4");
  });

  it("is a secondary link once a project exists", () => {
    const html = renderToStaticMarkup(<CreateProjectEntry projectCount={1} />);
    expect(html).toContain(`href="${NEW_PROJECT_HREF}"`);
    expect(html).toContain("Create a project from a git URL");
    // The link variant.
    expect(html).toContain("underline-offset-4");
    expect(html).not.toContain("bg-foreground");
  });
});
