// @vitest-environment jsdom
// BB-184: the stewards navigation provider draws bb's own navigation items
// except New thread, keeps hidden items reachable under More, and activates
// through the host's sidebar-navigation actions.
import { describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalSidebarNavigationItem } from "@get-bb/plugin-sdk/app";

const hostIcon = (name: "extensions" | "new-thread" | "search" | "skills"): ExperimentalSidebarNavigationItem["icon"] => ({ kind: "host", name });

const item = (over: Partial<ExperimentalSidebarNavigationItem> & { id: string; label: string }): ExperimentalSidebarNavigationItem => ({
  icon: hostIcon("extensions"),
  action: { kind: "open-extensions" },
  isDisabled: false,
  isVisible: true,
  isLoading: false,
  pluginId: null,
  shortcut: null,
  badge: null,
  ...over,
});

const items: ExperimentalSidebarNavigationItem[] = [
  item({ id: "__bb__/new-thread", label: "New thread", icon: hostIcon("new-thread"), action: { kind: "new-thread" } }),
  item({ id: "__bb__/search-threads", label: "Search threads", icon: hostIcon("search"), action: { kind: "search-threads" } }),
  item({ id: "__bb__/extensions", label: "Plugins", isDisabled: true }),
  item({ id: "__bb__/skills", label: "Skills", icon: hostIcon("skills"), action: { kind: "open-skills" } }),
  item({ id: "__bb__/automations", label: "Automations", action: { kind: "open-plugin-panel", pluginId: "automations", panelId: "automations" } }),
  item({ id: "stewards/board", label: "Stewards", icon: { kind: "plugin", pluginId: "stewards", icon: "ShieldCheck" }, action: { kind: "open-plugin-panel", pluginId: "stewards", panelId: "board" }, pluginId: "stewards", badge: { count: 3, label: "3 waiting" } }),
  item({ id: "other/panel", label: "Other panel", icon: { kind: "plugin", pluginId: "other", icon: null }, action: { kind: "open-plugin-panel", pluginId: "other", panelId: "panel" }, pluginId: "other", isVisible: false }),
];

let app: CapturedPluginApp | null = null;
const loadApp = async () => {
  app ??= await loadPluginApp(() => import("./app.js"));
  return app;
};

const renderNavigation = async (options: Parameters<typeof renderSlot>[2] = {}, props: Record<string, unknown> = {}): Promise<RenderedSlot> => {
  const captured = await loadApp();
  const navigation = captured.experimentalSidebarNavigations[0]!;
  return renderSlot(
    navigation,
    { isCompactViewport: false, placement: "list", experimental_Original: () => null, ...props },
    { pluginId: "stewards", sidebarNavigation: { items, activeItemId: "stewards/board" }, ...options },
  );
};

describe("the stewards navigation provider (BB-184)", () => {
  it("registers one list navigation under the Stewards title, with no header", async () => {
    const captured = await loadApp();
    expect(captured.experimentalSidebarNavigations).toHaveLength(1);
    expect(captured.experimentalSidebarNavigations[0]).toMatchObject({ id: "navigation", title: "Stewards", placement: "list" });
    expect(captured.experimentalSidebarNavigations[0]!.headerComponent).toBeUndefined();
  });

  it("draws every visible item except New thread", async () => {
    const slot = await renderNavigation();
    for (const label of ["Search threads", "Plugins", "Skills", "Automations", "Stewards 3 waiting"]) {
      expect(slot.getByRole("button", { name: label })).toBeTruthy();
    }
    expect(slot.queryByRole("button", { name: "New thread" })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("activates the clicked item in the current view", async () => {
    const slot = await renderNavigation();
    fireEvent.click(slot.getByRole("button", { name: "Skills" }));
    await waitFor(() => expect(slot.inspection.sidebarNavigationCalls).toContainEqual({ method: "activate", itemId: "__bb__/skills", target: "current" }));
    slot.lifecycle.unmount();
  });

  it("marks the active item and disables a disabled one", async () => {
    const slot = await renderNavigation();
    expect(slot.getByRole("button", { name: "Stewards 3 waiting" }).getAttribute("aria-current")).toBe("page");
    expect((slot.getByRole("button", { name: "Plugins" }) as HTMLButtonElement).disabled).toBe(true);
    slot.lifecycle.unmount();
  });

  it("puts a hidden item under More, not in the list", async () => {
    const slot = await renderNavigation();
    expect(slot.queryByRole("button", { name: "Other panel" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "More" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Other panel" })).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("adds the badge label to the row's accessible name", async () => {
    const slot = await renderNavigation();
    expect(slot.getByRole("button", { name: "Stewards 3 waiting" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("renders a More row only when something is hidden", async () => {
    const visibleOnly = items.filter((i) => i.isVisible);
    const slot = await renderNavigation({ sidebarNavigation: { items: visibleOnly, activeItemId: null } });
    expect(slot.queryByRole("button", { name: "More" })).toBeNull();
    slot.lifecycle.unmount();
  });
});
