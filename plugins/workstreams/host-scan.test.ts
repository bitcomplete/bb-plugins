import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectAll } from "./host.js";
import { unitLifecycle } from "./workstreams.js";

vi.mock("@get-bb/plugin-sdk/host", () => ({ experimental_defineHostEntry: (entry: unknown) => entry }));

const originalPath = process.env.PATH;
const directories: string[] = [];

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function commands(options: { statusFails?: boolean; dirty?: boolean; authFails?: boolean; prFails?: boolean; prMalformed?: boolean; approvedPr?: boolean; threadsFail?: boolean; threadsMore?: boolean; threadsOpen?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), "workstreams-scan-"));
  directories.push(directory);
  await writeFile(join(directory, "git"), `#!/bin/sh
case "$1" in
  remote) echo https://github.com/example/widget.git ;;
  rev-parse) echo feature/ABC-123 ;;
  status) ${options.statusFails ? "exit 1" : options.dirty ? "echo ' M file'" : "echo"} ;;
  rev-list) echo '0 0' ;;
  log) echo 2026-09-24T00:00:00Z ;;
  merge-base) echo abc123 ;;
  diff) echo ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  await writeFile(join(directory, "gh"), `#!/bin/sh
if [ "$1" = auth ]; then ${options.authFails ? "exit 1" : "exit 0"}; fi
if [ "$1" = repo ]; then echo main; exit 0; fi
if [ "$1" = pr ]; then ${options.prFails ? "exit 1" : options.prMalformed ? "echo malformed; exit 0" : options.approvedPr ? `echo '[{"number":42,"state":"OPEN","isDraft":false,"reviewDecision":"APPROVED","statusCheckRollup":[{"conclusion":"SUCCESS"}],"url":"https://github.com/example/widget/pull/42","title":"ABC-123: Widget fix","latestReviews":[{"author":{"login":"reviewer"},"state":"APPROVED"}],"mergeStateStatus":"CLEAN"}]'; exit 0` : "echo '[]'; exit 0"}; fi
if [ "$1" = api ]; then echo checked >> '${directory}/gh-api-calls'; ${options.threadsFail ? "exit 1" : `echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":${options.threadsMore === true}},"nodes":[{"isResolved":${options.threadsOpen !== true}}]}}}}}'; exit 0`}; fi
exit 1
`, { mode: 0o755 });
  process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
  const checkout = join(directory, "checkout");
  await mkdir(checkout);
  return checkout;
}

describe("host scan uncertainty", () => {
  it("marks git status failure unknown even when GitHub confirms there is no PR", async () => {
    const path = await commands({ statusFails: true });
    const { units, warnings } = await inspectAll([path], [], new AbortController().signal);
    expect(units[0]?.observed).toEqual({ status: false, pr: true });
    expect(unitLifecycle(units[0]!)).toBe("unverified");
    expect(warnings).toContain("checkout: git status failed; working-tree state is unknown.");
  });

  it("keeps local git facts while gh authentication is unavailable", async () => {
    const path = await commands({ authFails: true, dirty: true });
    const { units, warnings } = await inspectAll([path], [], new AbortController().signal);
    expect(units[0]?.observed).toEqual({ status: true, pr: false });
    expect(unitLifecycle(units[0]!)).toBe("active");
    expect(warnings[0]).toContain("gh is not authenticated");
  });

  it("does not turn a failed or malformed gh PR lookup into confirmed no PR", async () => {
    for (const options of [{ prFails: true }, { prMalformed: true }]) {
      const path = await commands(options);
      const { units, warnings } = await inspectAll([path], [], new AbortController().signal);
      expect(units[0]?.observed).toEqual({ status: true, pr: false });
      expect(unitLifecycle(units[0]!)).toBe("unverified");
      expect(warnings.some((warning) => warning.includes("gh pr list"))).toBe(true);
    }
  });

  it("reads unresolved threads before offering Merge on an approved PR", async () => {
    const path = await commands({ approvedPr: true, threadsOpen: true });
    const { units } = await inspectAll([path], [], new AbortController().signal);
    expect(units[0]?.pr?.unresolvedReviewThreads).toBe(1);
    expect(unitLifecycle(units[0]!)).toBe("approved-with-comments");
  });

  it("checks each PR once when multiple checkouts point at it", async () => {
    const path = await commands({ approvedPr: true });
    const second = join(dirname(path), "second-checkout");
    await mkdir(second);
    const { units } = await inspectAll([path, second], [], new AbortController().signal);
    expect(units).toHaveLength(2);
    expect(units.map(unitLifecycle)).toEqual(["awaiting-merge", "awaiting-merge"]);
    expect((await readFile(join(dirname(path), "gh-api-calls"), "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("keeps Merge unavailable when the review-thread check fails or has unread pages", async () => {
    for (const options of [{ threadsFail: true }, { threadsMore: true }]) {
      const path = await commands({ approvedPr: true, ...options });
      const { units, warnings } = await inspectAll([path], [], new AbortController().signal);
      expect(units[0]?.pr?.unresolvedReviewThreads).toBeNull();
      expect(unitLifecycle(units[0]!)).toBe("unverified");
      expect(warnings.some((warning) => warning.includes("review thread"))).toBe(true);
    }
  });
});
