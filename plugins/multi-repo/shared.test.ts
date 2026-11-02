import { describe, expect, it } from "vitest";
import { NEW_PROJECT_SUBPATH, opensNewProjectForm } from "./shared.js";

describe("opensNewProjectForm", () => {
  it("opens the form for the deep-link sub-path", () => {
    expect(NEW_PROJECT_SUBPATH).toBe("new");
    expect(opensNewProjectForm(NEW_PROJECT_SUBPATH)).toBe(true);
  });

  it("leaves the form closed at the panel root and any other sub-path", () => {
    expect(opensNewProjectForm("")).toBe(false);
    expect(opensNewProjectForm("some-project")).toBe(false);
    expect(opensNewProjectForm("new/extra")).toBe(false);
  });
});
