// @vitest-environment jsdom
// BB-198: the stewards navigation provider is a rail-placement provider that
// renders bb's own bundled Rail through `experimental_Original`, with no
// header, so the rail's New thread button is dropped. BB-184's own list of
// navigation rows is gone.
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot, type CapturedPluginApp, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";

let app: CapturedPluginApp | null = null;
const loadApp = async () => {
  app ??= await loadPluginApp(() => import("./app.js"));
  return app;
};

const renderNavigation = async (props: Record<string, unknown> = {}): Promise<RenderedSlot> => {
  const captured = await loadApp();
  const navigation = captured.experimentalSidebarNavigations[0]!;
  return renderSlot(
    navigation,
    { isCompactViewport: false, placement: "rail", experimental_Original: () => <span data-testid="bb-rail">bb rail</span>, ...props },
    { pluginId: "stewards" },
  );
};

describe("the stewards navigation provider (BB-198)", () => {
  it("registers one rail navigation under the Stewards title, with no header", async () => {
    const captured = await loadApp();
    expect(captured.experimentalSidebarNavigations).toHaveLength(1);
    expect(captured.experimentalSidebarNavigations[0]).toMatchObject({ id: "navigation", title: "Stewards", placement: "rail" });
    expect(captured.experimentalSidebarNavigations[0]!.headerComponent).toBeUndefined();
  });

  it("renders the slot's experimental_Original", async () => {
    const slot = await renderNavigation();
    expect(slot.getByTestId("bb-rail")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("renders no New thread element of its own", async () => {
    const slot = await renderNavigation();
    expect(slot.queryByRole("button", { name: "New thread" })).toBeNull();
    expect(slot.queryByRole("link", { name: "New thread" })).toBeNull();
    expect(slot.queryByText("New thread")).toBeNull();
    slot.lifecycle.unmount();
  });
});
