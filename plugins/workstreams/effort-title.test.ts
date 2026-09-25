import { describe, expect, it } from "vitest";
import { effortTitle } from "./effort-title.js";

describe("effort thread titles", () => {
  it.each([
    ["Speed up CI across projects", "🚦 Speed up CI across projects"],
    ["Bridge eligibility improvements", "🛡️ Bridge eligibility improvements"],
    ["Improve insurance eligibility checks", "🛡️ Improve insurance eligibility checks"],
    ["Roll out OTA releases", "🚀 Roll out OTA releases"],
    ["Improve manuscript review", "🔍 Improve manuscript review"],
    ["Reduce cache latency", "⚡ Reduce cache latency"],
    ["Tidy billing invoices", "💳 Tidy billing invoices"],
  ])("chooses a relevant symbol for %s", (name, title) => {
    expect(effortTitle(name)).toBe(title);
  });

  it.each(["🌿 Member experience", "👩🏽‍💻 Developer tools", "🇨🇦 Canadian launch", "1️⃣ First milestone"])("preserves the intentional leading emoji in %s", (name) => {
    expect(effortTitle(`  ${name}  `)).toBe(name);
  });

  it("keeps unfamiliar names stable while varying their fallback symbols", () => {
    const names = ["Quill", "Folio", "Harbor", "Orchard", "Lantern", "Willow"];
    const titles = names.map(effortTitle);
    expect(names.map(effortTitle)).toEqual(titles);
    expect(new Set(titles.map((title) => title.split(" ")[0])).size).toBeGreaterThan(1);
    for (const [index, name] of names.entries()) expect(titles[index]).toMatch(new RegExp(` ${name}$`, "u"));
  });

  it("avoids keyword matches inside unrelated words", () => {
    expect(effortTitle("Preview manuscript excerpts").startsWith("🔍 ")).toBe(false);
    expect(effortTitle("Circuit ownership").startsWith("🚦 ")).toBe(false);
  });
});
