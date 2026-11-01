// The frontend contract without a DOM: the app's registrations are captured by
// running its setup against a fake builder, and the overlay's decision is a
// pure function. No jsdom or testing-library, so this stays a no-review,
// plugin-only change.
import { describe, expect, it } from "vitest";
import type {
  ExperimentalAppOverlayRegistration,
  PluginAppBuilder,
  PluginHomepageSectionRegistration,
  PluginNavPanelRegistration,
} from "@get-bb/plugin-sdk/app";
import app from "./app.js";
import { GET_STARTED_PANEL_ID, GET_STARTED_PATH, shouldOpenGetStarted } from "./onboarding.js";

function capture() {
  const navPanels: PluginNavPanelRegistration[] = [];
  const appOverlays: ExperimentalAppOverlayRegistration[] = [];
  const homepageSections: PluginHomepageSectionRegistration[] = [];
  const fake = {
    slots: {
      navPanel: (registration: PluginNavPanelRegistration) => navPanels.push(registration),
      experimental_appOverlay: (registration: ExperimentalAppOverlayRegistration) => appOverlays.push(registration),
      homepageSection: (registration: PluginHomepageSectionRegistration) => homepageSections.push(registration),
      settingsSection: () => {},
    },
  } as unknown as PluginAppBuilder;
  app.setup(fake);
  return { navPanels, appOverlays, homepageSections };
}

describe("registration", () => {
  it("registers the Get started nav panel with the plugin's icon", () => {
    const { navPanels } = capture();
    expect(navPanels).toContainEqual(
      expect.objectContaining({ id: GET_STARTED_PANEL_ID, title: "Get started", icon: "ListTodo", path: GET_STARTED_PATH }),
    );
  });

  it("registers the redirect overlay", () => {
    const { appOverlays } = capture();
    expect(appOverlays.map((overlay) => overlay.id)).toContain("get-started-redirect");
  });
});

describe("first-run redirect conditions", () => {
  it("fires on the compose root with required setup incomplete and no dismissal", () => {
    expect(shouldOpenGetStarted({ pathname: "/", dismissed: false, requiredComplete: false })).toBe(true);
  });

  it("does not fire once the required steps are done", () => {
    expect(shouldOpenGetStarted({ pathname: "/", dismissed: false, requiredComplete: true })).toBe(false);
  });

  it("does not fire after the developer dismissed it", () => {
    expect(shouldOpenGetStarted({ pathname: "/", dismissed: true, requiredComplete: false })).toBe(false);
  });

  it("does not fire on a deep link", () => {
    for (const pathname of ["/projects/proj_1/threads/thr_1", "/settings/plugins/team-setup", "/plugins/team-setup/get-started"]) {
      expect(shouldOpenGetStarted({ pathname, dismissed: false, requiredComplete: false })).toBe(false);
    }
  });
});
