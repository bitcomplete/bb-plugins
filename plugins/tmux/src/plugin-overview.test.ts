import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// bb's limit for the text of a store listing: MARKETPLACE_OVERVIEW_MAX_CHARS
// in bb 0.50.1. The marketplace build rejects a longer text and the bb server
// drops it. bb counts characters, not bytes, and leaves out the line break at
// the end of the file.
const MAX_OVERVIEW_CHARACTERS = 4000;

const overview = readFileSync(
  new URL("../PLUGIN_OVERVIEW.md", import.meta.url),
  "utf8",
);

// bb shows the description of package.json as the one sentence of the store
// listing, and the overview is the same claim at length.
const MAX_DESCRIPTION_CHARACTERS = 140;

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { description: string; bb: { description: string } };

describe("the descriptions in package.json", () => {
  it.each([
    ["of the package", manifest.description],
    ["of the store listing", manifest.bb.description],
  ])("%s name the rule of the plugin: stock tmux with the tmux config of the user on top", (_which, description) => {
    expect(description).toContain("stock tmux");
    expect(description).toContain("your own tmux config");
    expect([...description].length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARACTERS);
  });
});

describe("PLUGIN_OVERVIEW.md", () => {
  it("is short enough for bb to show it in the store listing", () => {
    const length = [...overview.replace(/\n$/u, "")].length;

    expect(length).toBeLessThanOrEqual(MAX_OVERVIEW_CHARACTERS);
  });

  it("starts with text and not with a title, which the listing shows itself", () => {
    expect(overview.startsWith("#")).toBe(false);
  });

  it("has no table and no picture, which the listing does not allow", () => {
    expect(overview).not.toMatch(/^\s*\|/m);
    expect(overview).not.toContain("![");
  });
});
