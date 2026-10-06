import { describe, expect, it } from "vitest";
import { localProblem } from "./add-repo-row.js";
import { slugify } from "./names.js";

describe("slugify", () => {
  it("turns a project name into a directory-safe slug", () => {
    expect(slugify("My Project!")).toBe("my-project");
    expect(slugify("  bb / dylan  ")).toBe("bb-dylan");
    expect(slugify("Café")).toBe("cafe");
  });

  it("never returns an empty slug", () => {
    expect(slugify("!!!")).toBe("project");
    expect(slugify("")).toBe("project");
  });
});

describe("the add row's local check", () => {
  const existing = [{ dir: "bb-dylan", url: "git@github.com:you/bb-dylan.git" }];

  it("says nothing for an empty or a new entry", () => {
    expect(localProblem({ url: "" }, existing)).toBeNull();
    expect(localProblem({ url: "git@github.com:you/bb-plugins.git" }, existing)).toBeNull();
  });

  it("catches a duplicate directory, case-insensitively, and a duplicate remote in another spelling", () => {
    expect(localProblem({ url: "https://example.com/x", dir: "BB-Dylan" }, existing)).toContain("already");
    expect(localProblem({ url: "https://github.com/you/bb-dylan" }, existing)).toContain("already");
  });

  it("asks for a name when none can be inferred, and refuses reserved or unsafe ones", () => {
    expect(localProblem({ url: "/" }, existing)).toContain("directory name");
    expect(localProblem({ url: "https://example.com/x", dir: ".bb" }, existing)).toContain("reserved");
    expect(localProblem({ url: "https://example.com/x", dir: "a/b" }, existing)).toContain("plain directory");
    expect(localProblem({ url: "--upload-pack=x" }, existing)).toContain('"-"');
  });
});
