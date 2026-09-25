import { describe, expect, it } from "vitest";
import { checkoutBranch } from "./rebase.js";

describe("checkoutBranch", () => {
  const rebase = (name: string | null) => [{ present: true, name }, { present: false, name: null }];

  it("keeps the PR's branch visible while a checkout is detached for a rebase", () => {
    expect(checkoutBranch("HEAD", rebase("refs/heads/matts/cre-607-lock-eligibility-dob\n"))).toEqual({
      branch: "matts/cre-607-lock-eligibility-dob",
      rebasing: true,
    });
    expect(checkoutBranch("HEAD", [{ present: false, name: null }, { present: true, name: "refs/heads/feature/dob" }])).toEqual({
      branch: "feature/dob",
      rebasing: true,
    });
  });

  it("does not associate an arbitrary detached HEAD or malformed rebase metadata with a PR", () => {
    expect(checkoutBranch("HEAD", [])).toEqual({ branch: null, rebasing: false });
    for (const name of [null, "refs/tags/v1", "refs/heads/", "refs/heads/../main", "refs/heads/feature bad", "refs/heads/a.lock"]) {
      expect(checkoutBranch("HEAD", rebase(name))).toEqual({ branch: null, rebasing: true });
    }
    expect(checkoutBranch("HEAD", rebase("refs/heads/HEAD"))).toEqual({ branch: null, rebasing: true });
    expect(checkoutBranch("HEAD", [
      { present: true, name: "refs/heads/feature/a" },
      { present: true, name: "refs/heads/feature/b" },
    ])).toEqual({ branch: null, rebasing: true });
  });

  it("uses an attached branch while still treating leftover rebase metadata as in progress", () => {
    expect(checkoutBranch("feature/dob", rebase("refs/heads/feature/dob"))).toEqual({ branch: "feature/dob", rebasing: true });
    expect(checkoutBranch("main", [])).toEqual({ branch: "main", rebasing: false });
  });
});
