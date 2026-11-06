// The frontend contract without a DOM: the app's registrations are captured by
// running its setup against a fake builder. No jsdom or testing-library, so
// this stays a no-review, plugin-only change.
import { describe, expect, it } from "vitest";
import type {
  ExperimentalAppOverlayRegistration,
  PluginAppBuilder,
  PluginHomepageSectionRegistration,
  PluginNavPanelRegistration,
  PluginSettingsSectionRegistration,
} from "@get-bb/plugin-sdk/app";
import app, { routedAccountLabels } from "./app.js";

function capture() {
  const navPanels: PluginNavPanelRegistration[] = [];
  const appOverlays: ExperimentalAppOverlayRegistration[] = [];
  const homepageSections: PluginHomepageSectionRegistration[] = [];
  const settingsSections: PluginSettingsSectionRegistration[] = [];
  const fake = {
    slots: {
      navPanel: (registration: PluginNavPanelRegistration) => navPanels.push(registration),
      experimental_appOverlay: (registration: ExperimentalAppOverlayRegistration) => appOverlays.push(registration),
      homepageSection: (registration: PluginHomepageSectionRegistration) => homepageSections.push(registration),
      settingsSection: (registration: PluginSettingsSectionRegistration) => settingsSections.push(registration),
    },
  } as unknown as PluginAppBuilder;
  app.setup(fake);
  return { navPanels, appOverlays, homepageSections, settingsSections };
}

describe("registration", () => {
  it("registers the checklist homepage section and the settings sections", () => {
    const { homepageSections, settingsSections } = capture();
    expect(homepageSections.map((section) => section.id)).toEqual(["checklist"]);
    expect(settingsSections.map((section) => section.id)).toEqual(["server-update", "checklist", "advanced"]);
    // The Advanced section draws its own heading and description in the
    // disclosure, and renders nothing off-gate; the host must not draw a
    // heading for it.
    const advanced = settingsSections.find((section) => section.id === "advanced");
    expect(advanced?.title).toBeUndefined();
    expect(advanced?.description).toBeUndefined();
  });

  // BB-174's Get started nav panel and redirect overlay were removed in
  // BB-201; the first-visit redirect now lives in bb-gate's router.
  it("registers no nav panel or app overlay", () => {
    const { navPanels, appOverlays } = capture();
    expect(navPanels).toEqual([]);
    expect(appOverlays).toEqual([]);
  });
});

describe("routedAccountLabels", () => {
  it("prefixes each routed account with its provider, in account order", () => {
    expect(
      routedAccountLabels(
        [
          { provider: "claude", label: "dylan@bitcomplete.io" },
          { provider: "codex", label: "Elijah" },
        ],
        { claude: true, codex: true },
      ),
    ).toBe("Claude: dylan@bitcomplete.io, Codex: Elijah");
  });

  it("leaves out accounts whose provider routing is off", () => {
    expect(
      routedAccountLabels(
        [
          { provider: "claude", label: "dylan@bitcomplete.io" },
          { provider: "codex", label: "Elijah" },
        ],
        { claude: true, codex: false },
      ),
    ).toBe("Claude: dylan@bitcomplete.io");
  });

  it("is empty when nothing is routed", () => {
    expect(routedAccountLabels([{ provider: "claude", label: "dylan@bitcomplete.io" }], { claude: false, codex: false })).toBe("");
  });
});
