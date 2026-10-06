import { describe, expect, it } from "vitest";
import {
  addRepo,
  dirFromUrl,
  findRepo,
  parseReposFile,
  removeRepo,
  resolveRepoEntry,
  serializeReposFile,
  setRepoBranch,
  validateRepoSet,
  MAX_REPOS,
} from "./repos.js";

const valid = JSON.stringify({
  version: 1,
  repos: [
    { dir: "bb-dylan", url: "git@github.com:you/bb-dylan.git" },
    { dir: "bb-plugins", url: "https://github.com/you/bb-plugins", branch: "main" },
  ],
});

describe("parseReposFile", () => {
  it("accepts a well-formed file", () => {
    const parsed = parseReposFile(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.repos).toHaveLength(2);
    expect(parsed.value.repos[1].branch).toBe("main");
  });

  it("names the offending entry rather than failing vaguely", () => {
    const parsed = parseReposFile(JSON.stringify({ version: 1, repos: [{ dir: "a/b", url: "x" }] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("repos[0]");
    expect(parsed.error).toContain("a/b");
  });

  it("rejects a JSON syntax error with the parser's own message", () => {
    const parsed = parseReposFile("{ not json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("not valid JSON");
  });

  it("rejects a missing or wrong version rather than guessing", () => {
    expect(parseReposFile(JSON.stringify({ repos: [] })).ok).toBe(false);
    expect(parseReposFile(JSON.stringify({ version: 2, repos: [] })).ok).toBe(false);
  });

  it("rejects unknown keys so a typo is not silently ignored", () => {
    const parsed = parseReposFile(JSON.stringify({ version: 1, repos: [{ dir: "a", url: "u", brunch: "main" }] }));
    expect(parsed.ok).toBe(false);
  });

  it("rejects comments, because the file is strict JSON", () => {
    expect(parseReposFile('{ "version": 1, /* nope */ "repos": [] }').ok).toBe(false);
  });

  it("infers a missing dir from the repo name", () => {
    const parsed = parseReposFile(
      JSON.stringify({ version: 1, repos: [{ url: "git@github.com:you/bb-dylan.git" }] }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.repos[0].dir).toBe("bb-dylan");
    expect(parsed.value.repos[0].inferredDir).toBe(true);
  });

  it("still catches a duplicate when one side's dir is inferred", () => {
    const parsed = parseReposFile(
      JSON.stringify({
        version: 1,
        repos: [{ dir: "repo", url: "https://example.com/a" }, { url: "https://example.com/repo" }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("already used");
  });

  it("says so when a missing dir cannot be inferred", () => {
    const parsed = parseReposFile(JSON.stringify({ version: 1, repos: [{ url: "https://github.com/you/.hidden" }] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("repos[0]");
    expect(parsed.error).toContain('"dir"');
  });
});

describe("resolveRepoEntry", () => {
  it("keeps an explicit dir and does not mark it inferred", () => {
    expect(resolveRepoEntry({ dir: "mine", url: "https://example.com/theirs" })).toEqual({
      dir: "mine",
      url: "https://example.com/theirs",
    });
  });

  it("returns null when the url yields no usable name", () => {
    expect(resolveRepoEntry({ url: "/" })).toBeNull();
  });
});

describe("validateRepoSet", () => {
  it("reserves .bb for the project's own definition", () => {
    const problem = validateRepoSet([{ dir: ".bb", url: "u" }]);
    expect(problem).toContain("reserved");
  });

  it("rejects dot segments and separators in dir", () => {
    for (const dir of ["..", ".", "a/b", "a\\b", ".hidden", "a "]) {
      expect(validateRepoSet([{ dir, url: "u" }])).not.toBeNull();
    }
  });

  it("rejects a duplicate dir case-insensitively", () => {
    const problem = validateRepoSet([
      { dir: "Repo", url: "a" },
      { dir: "repo", url: "b" },
    ]);
    // Two entries that differ only in case collide on macOS and Windows, so a
    // repo set must mean the same thing on every machine.
    expect(problem).toContain("already used");
  });

  it("treats ssh and https spellings of one repo as a duplicate", () => {
    const problem = validateRepoSet([
      { dir: "a", url: "git@github.com:you/repo.git" },
      { dir: "b", url: "https://github.com/you/repo" },
    ]);
    expect(problem).toContain("same repo");
  });

  it("rejects a url that git would read as an option", () => {
    expect(validateRepoSet([{ dir: "a", url: "--upload-pack=evil" }])).toContain('may not start with "-"');
  });

  it("accepts a local path as a url", () => {
    expect(validateRepoSet([{ dir: "a", url: "/home/me/src/repo" }])).toBeNull();
  });
});

describe("serializeReposFile", () => {
  it("round-trips and omits an absent branch", () => {
    const parsed = parseReposFile(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const text = serializeReposFile(parsed.value);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain('"branch": undefined');
    const again = parseReposFile(text);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value).toEqual(parsed.value);
  });

  it("writes an inferred dir back out as the absence it was", () => {
    const text = serializeReposFile({
      version: 1,
      repos: [
        { dir: "bb-dylan", url: "git@github.com:you/bb-dylan.git", inferredDir: true },
        { dir: "other", url: "https://example.com/repo" },
      ],
    });
    expect(text).not.toContain('"dir": "bb-dylan"');
    expect(text).toContain('"dir": "other"');
    const again = parseReposFile(text);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.repos[0]).toEqual({
      dir: "bb-dylan",
      url: "git@github.com:you/bb-dylan.git",
      inferredDir: true,
    });
  });

  it("writes keys in a fixed order so an edit is a one-line diff", () => {
    const text = serializeReposFile({ version: 1, repos: [{ branch: "x", url: "u", dir: "d" } as never] });
    expect(text.indexOf('"dir"')).toBeLessThan(text.indexOf('"url"'));
    expect(text.indexOf('"url"')).toBeLessThan(text.indexOf('"branch"'));
  });
});

describe("edits", () => {
  const base = { version: 1 as const, repos: [{ dir: "a", url: "https://example.com/a" }] };

  it("adds a repo with a dir inferred from its url", () => {
    const result = addRepo(base, { url: "https://example.com/b.git" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repos[1]).toEqual({ dir: "b", url: "https://example.com/b.git", inferredDir: true });
  });

  it("refuses an add whose dir cannot be inferred", () => {
    const result = addRepo(base, { url: "/" });
    expect(result.ok).toBe(false);
  });

  it("adds a repo", () => {
    const result = addRepo(base, { dir: "b", url: "https://example.com/b" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repos.map((repo) => repo.dir)).toEqual(["a", "b"]);
  });

  it("refuses an add that would break the set", () => {
    const result = addRepo(base, { dir: "a", url: "https://example.com/other" });
    expect(result.ok).toBe(false);
  });

  it("refuses to exceed the cap", () => {
    const full = {
      version: 1 as const,
      repos: Array.from({ length: MAX_REPOS }, (_, index) => ({
        dir: `r${index}`,
        url: `https://example.com/r${index}`,
      })),
    };
    const result = addRepo(full, { dir: "extra", url: "https://example.com/extra" });
    expect(result.ok).toBe(false);
  });

  it("removes a repo and reports an unknown one", () => {
    expect(removeRepo(base, "a").ok).toBe(true);
    const missing = removeRepo(base, "nope");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toContain("nope");
  });

  it("sets, changes and clears a repo's base branch without touching its shape", () => {
    const inferred = { version: 1 as const, repos: [{ dir: "a", url: "https://example.com/a", inferredDir: true }] };
    const set = setRepoBranch(inferred, "a", "release");
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.value.repos[0]).toEqual({ dir: "a", url: "https://example.com/a", inferredDir: true, branch: "release" });
    // Serialized, the inferred dir stays absent and the branch is the only addition.
    expect(JSON.parse(serializeReposFile(set.value)).repos[0]).toEqual({ url: "https://example.com/a", branch: "release" });
    const cleared = setRepoBranch(set.value, "a", null);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.repos[0]).toEqual(inferred.repos[0]);
    const blank = setRepoBranch(set.value, "a", "   ");
    expect(blank.ok && blank.value.repos[0].branch).toBeUndefined();
  });

  it("refuses a branch for an unknown repo or one that reads as an option", () => {
    expect(setRepoBranch(base, "nope", "main").ok).toBe(false);
    expect(setRepoBranch(base, "a", "--upload-pack=x").ok).toBe(false);
  });

  it("finds an existing repo by dir or by equivalent url", () => {
    expect(findRepo(base, { dir: "a" })?.dir).toBe("a");
    expect(findRepo(base, { url: "https://example.com/a.git" })?.dir).toBe("a");
    expect(findRepo(base, { dir: "z", url: "https://example.com/z" })).toBeNull();
  });
});

describe("dirFromUrl", () => {
  it("takes the last component without .git", () => {
    expect(dirFromUrl("git@github.com:you/bb-dylan.git")).toBe("bb-dylan");
    expect(dirFromUrl("https://github.com/you/bb-plugins/")).toBe("bb-plugins");
    expect(dirFromUrl("/home/me/src/thing")).toBe("thing");
  });

  it("returns null rather than inventing a name", () => {
    // Callers ask for an explicit `dir` instead of getting `repo-1` and
    // having to discover what they got.
    expect(dirFromUrl("https://github.com/you/.hidden")).toBeNull();
    expect(dirFromUrl("/")).toBeNull();
  });
});
