// BB-364: a stock install must not land on a bb too old for the plugin. The
// manifest's `engines` block is what `bb plugin install` validates for a
// managed source (git:/npm:/catalog — the CLI's own help: "managed sources
// validate engines ranges and build artifacts"), so the declaration is the
// whole plugin-side mechanism and this guards it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")) as {
  engines?: { bb?: string; bbPluginSdk?: string };
  dependencies?: Record<string, string>;
};

describe("the stewards manifest's minimum bb version (BB-364)", () => {
  it("declares a bb engines range, and the bb-server image's desktop-v0.49.0 satisfies it", () => {
    expect(typeof pkg.engines?.bb).toBe("string");
    // `>=0.49` (or a later floor) is a well-formed range, not a bare version.
    const m = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(pkg.engines!.bb!);
    expect(m).not.toBeNull();
    const [major, minor] = [Number(m![1]), Number(m![2])];
    // The plugin is verified against the image's bb, desktop-v0.49.0; a floor
    // above it would refuse the image's own version.
    expect([major, minor]).toEqual([0, 49]);
  });

  it("declares an SDK floor at or below the SDK the plugin is built against", () => {
    const pinned = pkg.dependencies?.["@get-bb/plugin-sdk"];
    expect(pinned).toBe("0.6.80");
    expect(pkg.engines?.bbPluginSdk).toBe(`>=${pinned}`);
  });
});
