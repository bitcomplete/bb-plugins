// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server.js";
import { Store } from "../../src/store.js";
import { ObjectiveForm } from "../../src/ui/objective-form.js";
import type { DashboardApi } from "../../src/ui/types.js";

afterEach(cleanup);
function fillDraft() {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Keep the useful history" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Preserve request details when an operation is retried." } });
}
function form() { return screen.getByLabelText("Title").closest("form")!; }

describe("objective form retry intent", () => {
  it("retries a lost committed response with the same key and leaves exactly one saved objective and problem", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "self-improve" });
    try {
      await plugin(bb);
      let loseResponse = true;
      const createObjective = vi.fn<DashboardApi["createObjective"]>(async input => {
        const result = await harness.behavior.callRpc("createObjective", input) as { id: string };
        if (loseResponse) { loseResponse = false; throw new Error("Response lost; retry the unchanged draft"); }
        return result;
      });
      const onCreated = vi.fn(), api = { createObjective } as unknown as DashboardApi;
      const view = render(<ObjectiveForm api={api} onCreated={onCreated} onClose={vi.fn()} />);
      fillDraft(); fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "focus" } });
      fireEvent.submit(form()); fireEvent.submit(form());
      await screen.findByText("Response lost; retry the unchanged draft");
      expect(createObjective).toHaveBeenCalledTimes(1);
      expect(onCreated).not.toHaveBeenCalled();
      const store = new Store(bb.storage.database()), before = store.audit();
      expect(store.list("objectives")).toHaveLength(1); expect(store.list("problems")).toHaveLength(1);
      view.rerender(<ObjectiveForm api={api} onCreated={onCreated} onClose={vi.fn()} />);
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: " Keep the useful history " } });
      fireEvent.submit(form());
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      expect(createObjective).toHaveBeenCalledTimes(2);
      expect(createObjective.mock.calls[1][0]).toEqual(createObjective.mock.calls[0][0]);
      expect(createObjective.mock.calls[0][0].requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
      expect(store.list("objectives")).toHaveLength(1); expect(store.list("problems")).toHaveLength(1);
      expect(store.list("objective-focus")).toHaveLength(1); expect(store.audit()).toEqual(before);
      expect(onCreated).toHaveBeenCalledWith(store.list<{ problemId: string }>("objectives")[0].problemId);
    } finally { await harness.lifecycle.dispose(); }
  });

  it.each(["title", "priority", "metric"])("starts a distinct intent when the submitted %s changes", async field => {
    const createObjective = vi.fn<DashboardApi["createObjective"]>().mockRejectedValue(new Error("Save failed"));
    render(<ObjectiveForm api={{ createObjective } as unknown as DashboardApi} onCreated={vi.fn()} onClose={vi.fn()} />);
    fillDraft(); fireEvent.submit(form()); await screen.findByText("Save failed");
    if (field === "title") fireEvent.change(screen.getByLabelText("Title"), { target: { value: "An edited objective" } });
    else if (field === "priority") fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "focus" } });
    else {
      fireEvent.click(screen.getByRole("checkbox", { name: "I have a measurable target" }));
      fireEvent.change(screen.getByLabelText("Metric name"), { target: { value: "Retry count" } });
      fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "retries" } });
      fireEvent.change(screen.getByLabelText("Target"), { target: { value: "1" } });
    }
    fireEvent.submit(form()); await screen.findByText("Save failed");
    expect(createObjective).toHaveBeenCalledTimes(2);
    expect(createObjective.mock.calls[1][0].requestId).not.toBe(createObjective.mock.calls[0][0].requestId);
    fireEvent.submit(form()); await screen.findByText("Save failed");
    expect(createObjective.mock.calls[2][0]).toEqual(createObjective.mock.calls[1][0]);
  });

  it("starts a new intent after an acknowledged success", async () => {
    const createObjective = vi.fn<DashboardApi["createObjective"]>().mockResolvedValue({ id: "saved-problem" });
    const onCreated = vi.fn();
    render(<ObjectiveForm api={{ createObjective } as unknown as DashboardApi} onCreated={onCreated} onClose={vi.fn()} />);
    fillDraft(); fireEvent.submit(form());
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    fireEvent.submit(form());
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2));
    expect(createObjective.mock.calls[1][0].requestId).not.toBe(createObjective.mock.calls[0][0].requestId);
  });
});
