// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { Checkbox, CheckboxGroup } from "@ui-sdk/react/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { Button } from "@ui-sdk/react/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/react/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { z } from "zod";
import { disposePrsUiAgentBridge, usePrsUiAgentBridge } from "./ui-agent-bridge";

declare global { var __UI_SDK_STRICT__: boolean | undefined }
globalThis.__UI_SDK_STRICT__ = true;
// jsdom has no top layer, visibility measurement, or layout observers.
HTMLElement.prototype.showPopover = function () {};
HTMLElement.prototype.hidePopover = function () {};
Element.prototype.getAnimations = () => [];
Element.prototype.scrollIntoView = function () {};
Element.prototype.checkVisibility = () => true;
Element.prototype.getClientRects = () => Object.assign([], { item: () => null });
document.elementFromPoint = () => null;
document.elementsFromPoint = () => [];
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

type Tool = { name: string; inputSchema: unknown; execute: (input: unknown) => Promise<unknown> };
const tools = new Map<string, Tool>();
const stateSchema = z.object({
  ok: z.boolean(), panelId: z.string(), incomplete: z.boolean(), hint: z.string().optional(),
  components: z.array(z.object({
    ref: z.string(), component: z.string(), label: z.string().optional(),
    value: z.unknown().optional(), checked: z.union([z.boolean(), z.literal("mixed")]).optional(),
    open: z.boolean().optional(), actions: z.array(z.string()),
    items: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  })),
});

beforeEach(() => {
  tools.clear();
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: {
      registerTool: async (tool: Tool, { signal }: { signal: AbortSignal }) => {
        if (tools.has(tool.name)) throw new Error("Duplicate tool");
        tools.set(tool.name, tool);
        signal.addEventListener("abort", () => {
          if (tools.get(tool.name) === tool) tools.delete(tool.name);
        }, { once: true });
      },
    },
  });
});
afterEach(() => {
  cleanup();
  disposePrsUiAgentBridge();
  Reflect.deleteProperty(document, "modelContext");
});

function Panel({ name, save = () => {}, onView = () => {} }: {
  name: string; save?: () => void; onView?: () => void;
}) {
  const { rootRef, panelId, availability } = usePrsUiAgentBridge();
  return <div ref={rootRef} data-testid={name} data-prs-agent-panel={panelId} data-availability={availability}>
    <Tabs aria-label={`${name} tabs`} defaultValue="mine" data-prs-agent-local="">
      <TabsList><TabsTab value="mine">Mine</TabsTab><TabsTab value="review">To review</TabsTab></TabsList>
      <TabsPanel value="mine">
        <SegmentedControl aria-label={`${name} status`} defaultValue="all" onValueChange={onView} data-prs-agent-local="">
          <SegmentedControlItem value="all">All</SegmentedControlItem>
          <SegmentedControlItem value="drafts">Drafts</SegmentedControlItem>
        </SegmentedControl>
        <Checkbox aria-label={`${name} pick`} data-prs-agent-local="" />
        <CheckboxGroup aria-label={`${name} selection`} data-prs-agent-local="">
          <Checkbox aria-label={`${name} first PR`} value="first" data-prs-agent-local="" />
          <Checkbox aria-label={`${name} second PR`} value="second" data-prs-agent-local="" />
        </CheckboxGroup>
        <Collapsible aria-label={`${name} details`} data-prs-agent-local="">
          <CollapsibleTrigger>Show details</CollapsibleTrigger>
          <CollapsiblePanel>Local details</CollapsiblePanel>
        </Collapsible>
        <SegmentedControl aria-label={`${name} Agent model`} defaultValue="sol" onValueChange={save}>
          <SegmentedControlItem value="sol">Sol</SegmentedControlItem>
          <SegmentedControlItem value="other">Other</SegmentedControlItem>
        </SegmentedControl>
        <Button onClick={save} data-prs-agent-local="">{name} start agent</Button>
        <Checkbox aria-label={`${name} guarded`} data-prs-agent-local="" data-agent-confirm="Writes persisted settings" onCheckedChange={save} />
      </TabsPanel>
      <TabsPanel value="review"><Checkbox aria-label={`${name} review pick`} data-prs-agent-local="" /></TabsPanel>
    </Tabs>
  </div>;
}
async function tool(name: string, input: unknown) {
  const found = tools.get(`prs_ui_${name}`);
  if (!found) throw new Error(`Missing tool ${name}`);
  let result: unknown;
  await act(async () => { result = await found.execute(input); });
  return result;
}
function panelId(element: HTMLElement) {
  return z.string().parse(element.getAttribute("data-prs-agent-panel"));
}
async function state(id: string) { return stateSchema.parse(await tool("snapshot", { panelId: id })); }
function refOf(state: z.infer<typeof stateSchema>, label: string) {
  const entry = state.components.find((entry) => entry.label === label);
  if (!entry) throw new Error(`Missing ${label}: ${JSON.stringify(state.components)}`);
  return entry.ref;
}

it("registers namespaced tools once and isolates two PRs panels from unrelated SDK controls", async () => {
  const view = render(<><Panel name="First" /><Panel name="Second" />
    <SegmentedControl aria-label="Unrelated private control" defaultValue="private">
      <SegmentedControlItem value="private">Confidential other workspace</SegmentedControlItem>
    </SegmentedControl></>);
  await waitFor(() => expect(view.getByTestId("First").getAttribute("data-availability")).toBe("available"));
  expect([...tools.keys()]).toEqual(["prs_ui_snapshot", "prs_ui_query", "prs_ui_act"]);
  const first = panelId(view.getByTestId("First"));
  const second = panelId(view.getByTestId("Second"));
  expect(first).not.toBe(second);
  within(view.getByTestId("First")).getByRole("tab", { name: "Mine" }).focus();
  expect(await tool("snapshot", {})).toEqual({ ok: true, incomplete: false, panels: [
    { panelId: first, label: "PRs", visible: true, focused: true },
    { panelId: second, label: "PRs", visible: true, focused: false },
  ] });
  const firstState = await state(first);
  expect(firstState.components.map((entry) => entry.label)).toContain("First status");
  expect(JSON.stringify(firstState)).not.toMatch(/Second|Unrelated|Confidential/);
  const firstQuery = await tool("query", { panelId: first, kind: "segmented-control" });
  expect(JSON.stringify(firstQuery)).toContain("First status");
  expect(JSON.stringify(firstQuery)).not.toMatch(/Second|Unrelated|Confidential/);
  expect(await tool("query", { panelId: first, within: refOf(await state(second), "Second status") }))
    .toMatchObject({ ok: false, code: "ref_unavailable" });
  expect(await tool("query", { panelId: first, within: "First status" }))
    .toMatchObject({ ok: false, code: "ref_unavailable" });
});

it("changes local setters with exact refs and returns only sanitized scoped state", async () => {
  const onView = vi.fn();
  const view = render(<><Panel name="First" onView={onView} /><Panel name="Second" />
    <Dialog defaultOpen><DialogContent><DialogTitle>Unrelated confidential dialog</DialogTitle>
      <DialogDescription>Private external details</DialogDescription><Button>Send outside</Button>
    </DialogContent></Dialog></>);
  const first = panelId(view.getByTestId("First"));
  const initial = await state(first);
  const result = stateSchema.parse(await tool("act", {
    panelId: first, ref: refOf(initial, "First status"), action: "setValue", args: ["drafts"],
  }));
  expect(result.ok).toBe(true);
  expect(onView).toHaveBeenCalledWith("drafts", expect.objectContaining({ source: "agent" }));
  expect(result.components.find((entry) => entry.label === "First status")?.value).toBe("drafts");
  expect(JSON.stringify(result)).not.toMatch(/Second|Unrelated|confidential|Private external|Send outside/);
  expect(result).not.toHaveProperty("values");
  expect(result).not.toHaveProperty("open");
  expect(result).not.toHaveProperty("appeared");
  expect(result).not.toHaveProperty("steps");
  const checked = stateSchema.parse(await tool("act", { panelId: first, ref: refOf(initial, "First pick"), action: "setChecked", args: [true] }));
  expect(checked.ok).toBe(true);
  expect(within(view.getByTestId("First")).getByRole("checkbox", { name: "First pick" }).getAttribute("aria-checked")).toBe("true");
  const opened = stateSchema.parse(await tool("act", { panelId: first, ref: refOf(initial, "First details"), action: "setOpen", args: [true] }));
  expect(opened.ok).toBe(true);
  expect(opened.components.find((entry) => entry.label === "First details")?.open).toBe(true);
  expect(initial.components.find((entry) => entry.label === "First selection")?.actions).toEqual([]);
  const selected = stateSchema.parse(await tool("act", { panelId: first, ref: refOf(initial, "First first PR"), action: "setChecked", args: [true] }));
  expect(selected.ok).toBe(true);
  expect(selected.components.find((entry) => entry.label === "First selection")?.value).toEqual(["first"]);
});

it("refuses cross-pane, fuzzy, stale, unmarked persisted settings and all button actions", async () => {
  const save = vi.fn();
  const view = render(<><Panel name="First" save={save} /><Panel name="Second" /></>);
  const first = panelId(view.getByTestId("First"));
  const initial = await state(first);
  fireEvent.click(within(view.getByTestId("First")).getByRole("button", { name: "First start agent" }));
  expect(save).toHaveBeenCalledTimes(1);
  save.mockClear();
  const action = (ref: string, action = "setValue", args: unknown[] = ["other"]) => tool("act", { panelId: first, ref, action, args });
  expect(await action(refOf(await state(panelId(view.getByTestId("Second"))), "Second status")))
    .toMatchObject({ ok: false, code: "ref_unavailable" });
  expect(await action("First status", "setValue", ["drafts"]))
    .toMatchObject({ ok: false, code: "ref_unavailable" });
  expect(initial.components.find((entry) => entry.label === "First Agent model")?.actions).toEqual([]);
  expect(await action(refOf(initial, "First Agent model"))).toMatchObject({ ok: false, code: "action_unavailable" });
  expect(await action(refOf(initial, "First guarded"), "setChecked", [true])).toMatchObject({ ok: false, code: "action_unavailable" });
  expect(await action(refOf(initial, "First start agent"), "press", [])).toMatchObject({ ok: false, code: "invalid_input" });
  expect(await action(refOf(initial, "First status"), "setValue", ["fabricated"])).toMatchObject({ ok: false, code: "invalid_value" });
  expect(await action(refOf(initial, "First status"), "setValue", ["Drafts"])).toMatchObject({ ok: false, code: "invalid_value" });
  expect(await action(refOf(initial, "First tabs"), "setValue", ["review"])).toMatchObject({ ok: true });
  expect(await action(refOf(initial, "First pick"), "setChecked", [true])).toMatchObject({ ok: false, code: "ref_unavailable" });
  expect(save).not.toHaveBeenCalled();
});

it("excludes controls with ambiguous nested ownership or hidden ancestors", async () => {
  function Outer() {
    const { rootRef, panelId } = usePrsUiAgentBridge();
    return <div ref={rootRef} data-testid="Outer" data-prs-agent-panel={panelId}>
      <div hidden><Checkbox aria-label="Hidden local control" data-prs-agent-local="" /></div>
      <Panel name="Nested" />
    </div>;
  }
  const view = render(<Outer />);
  const outer = await state(panelId(view.getByTestId("Outer")));
  const inner = await state(panelId(view.getByTestId("Nested")));
  expect(outer.components).toEqual([]);
  expect(inner.components).toEqual([]);
  expect(JSON.stringify(await tool("query", { panelId: inner.panelId }))).not.toMatch(/Nested|Hidden/);
});

it("validates unknown tool inputs and limits without echoing untrusted errors", async () => {
  const view = render(<Panel name="First" />);
  const first = panelId(view.getByTestId("First"));
  for (const input of [null, [], { panelId: first, injected: "secret" }, { panelId: "other" }])
    expect(await tool("snapshot", input)).toMatchObject({ ok: false, code: "invalid_input" });
  expect(await tool("query", { panelId: first, text: "secret".repeat(100) })).toMatchObject({ ok: false, code: "invalid_input" });
  expect(await tool("act", { panelId: first, ref: "unknown", action: "setValue", args: [Array.from({ length: 51 }, () => "value")] })).toMatchObject({ ok: false, code: "invalid_input" });
  expect(await tool("snapshot", { panelId: `prs-panel-${crypto.randomUUID()}` })).toMatchObject({ ok: false, code: "panel_unavailable" });
});

it("leaves unsupported browsers untouched and reports unavailable", () => {
  Reflect.deleteProperty(document, "modelContext");
  const view = render(<Panel name="First" />);
  expect(view.getByTestId("First").getAttribute("data-availability")).toBe("unavailable");
  expect("modelContext" in document).toBe(false);
  expect(tools.size).toBe(0);
});

it("declines legacy WebMCP lifecycle APIs without registering resources it cannot safely dispose", () => {
  const registerTool = vi.fn();
  const unregisterTool = vi.fn();
  Object.defineProperty(document, "modelContext", {
    configurable: true, value: { registerTool, unregisterTool },
  });
  const view = render(<Panel name="First" />);
  expect(view.getByTestId("First").getAttribute("data-availability")).toBe("unsupported-lifecycle");
  expect(registerTool).not.toHaveBeenCalled();
  expect(unregisterTool).not.toHaveBeenCalled();
});

it("rolls back its registrations when a namespaced tool collides without removing another owner", async () => {
  const existing = { name: "prs_ui_query", inputSchema: {}, execute: async () => "other owner" };
  tools.set(existing.name, existing);
  const view = render(<Panel name="First" />);
  await waitFor(() => expect(view.getByTestId("First").getAttribute("data-availability")).toBe("registration-failed"));
  expect([...tools.values()]).toEqual([existing]);
});

it("aborts registrations after the last panel and host disposal, including retained handles", async () => {
  const first = render(<Panel name="First" />);
  const second = render(<Panel name="Second" />);
  const id = panelId(first.getByTestId("First"));
  const retained = tools.get("prs_ui_snapshot");
  first.unmount();
  expect(tools.size).toBe(3);
  expect(await retained?.execute({ panelId: id })).toMatchObject({ ok: false, code: "panel_unavailable" });
  second.unmount();
  expect(tools.size).toBe(0);
  const third = render(<Panel name="Third" />);
  expect(tools.size).toBe(3);
  act(() => disposePrsUiAgentBridge());
  expect(tools.size).toBe(0);
  expect(await retained?.execute({ panelId: panelId(third.getByTestId("Third")) })).toMatchObject({ ok: false, code: "bridge_unavailable" });
});

it("reports global SDK truncation without exposing omitted foreign controls or counts", async () => {
  const view = render(<>
    {Array.from({ length: 110 }, (_, index) => <Checkbox key={index} aria-label={`Unrelated confidential ${index}`} />)}
    <Panel name="First" />
  </>);
  const first = panelId(view.getByTestId("First"));
  const snapshot = await state(first);
  expect(snapshot.incomplete).toBe(true);
  expect(JSON.stringify(snapshot)).not.toMatch(/Unrelated|confidential|"more"/);
  expect(snapshot).toHaveProperty("hint", expect.stringContaining("typed BB"));
  const query = await tool("query", { panelId: first, kind: "checkbox" });
  expect(query).toMatchObject({ ok: true, incomplete: true });
  expect(JSON.stringify(query)).not.toMatch(/Unrelated|confidential/);
});

it("can query within and change an exact owned ref beyond the global snapshot limit", async () => {
  function LatePanel() {
    const { rootRef, panelId } = usePrsUiAgentBridge();
    return <div ref={rootRef} data-testid="Late" data-prs-agent-panel={panelId}>
      <Checkbox aria-label="Late PR selection" data-prs-agent-local="" />
    </div>;
  }
  const view = render(<>
    {Array.from({ length: 105 }, (_, index) => <Checkbox key={index} aria-label={`Unrelated confidential ${index}`} />)}
    <LatePanel />
  </>);
  const late = panelId(view.getByTestId("Late"));
  const snapshot = await state(late);
  expect(snapshot.components).toEqual([]);
  expect(snapshot.incomplete).toBe(true);
  const found = stateSchema.parse(await tool("query", { panelId: late, text: "Late PR selection" }));
  const ref = refOf(found, "Late PR selection");
  expect(found.components).toHaveLength(1);
  expect(found.components[0]?.actions).toEqual(["setChecked"]);
  const narrowed = stateSchema.parse(await tool("query", { panelId: late, within: ref }));
  expect(narrowed.components.map((entry) => entry.ref)).toEqual([ref]);
  expect(narrowed.incomplete).toBe(true);
  const changed = await tool("act", { panelId: late, ref, action: "setChecked", args: [true] });
  expect(changed).toMatchObject({ ok: true, incomplete: true });
  expect(within(view.getByTestId("Late")).getByRole("checkbox", { name: "Late PR selection" }).getAttribute("aria-checked")).toBe("true");
  expect(JSON.stringify([found, narrowed, changed])).not.toMatch(/Unrelated|confidential/);
});

it("changes only a directly marked organization Select using canonical refs and listed values", async () => {
  const organizationChanged = vi.fn();
  const saveModel = vi.fn();
  const readOnlyChanged = vi.fn();
  const organizations = [
    { value: "*", label: "All organizations" },
    { value: "parsley-health", label: "Parsley Health" },
  ];
  const models = [{ value: "sol", label: "Sol" }, { value: "other", label: "Other" }];
  function SelectPanel() {
    const { rootRef, panelId } = usePrsUiAgentBridge();
    return <div ref={rootRef} data-testid="Select panel" data-prs-agent-panel={panelId}>
      <Tabs defaultValue="mine" aria-label="PR views" data-prs-agent-local="">
        <TabsList><TabsTab value="mine">Mine</TabsTab></TabsList>
        <TabsPanel value="mine">
          <Select items={organizations} defaultValue="*" onValueChange={organizationChanged}>
            <SelectTrigger aria-label="Organization" data-prs-agent-local=""><SelectValue /></SelectTrigger>
            <SelectContent>{organizations.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select items={models} defaultValue="sol" onValueChange={saveModel}>
            <SelectTrigger aria-label="Agent model"><SelectValue /></SelectTrigger>
            <SelectContent>{models.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select items={organizations} defaultValue="*" readOnly onValueChange={readOnlyChanged}>
            <SelectTrigger aria-label="Read-only organization" data-prs-agent-local=""><SelectValue /></SelectTrigger>
            <SelectContent />
          </Select>
        </TabsPanel>
      </Tabs>
    </div>;
  }
  const view = render(<SelectPanel />);
  const id = panelId(view.getByTestId("Select panel"));
  const initial = await state(id);
  const org = initial.components.find((entry) => entry.label === "Organization");
  expect(org).toMatchObject({ component: "select", items: organizations, actions: ["setValue"] });
  const orgRef = refOf(initial, "Organization");
  expect(await tool("act", { panelId: id, ref: orgRef, action: "setValue", args: ["parsley-health"] })).toMatchObject({ ok: true });
  expect(organizationChanged).toHaveBeenCalledWith("parsley-health", expect.objectContaining({ source: "agent" }));
  expect((await state(id)).components.find((entry) => entry.ref === orgRef)?.value).toBe("parsley-health");
  expect(within(view.getByTestId("Select panel")).getByRole("combobox", { name: "Organization" }).textContent).toBe("Parsley Health");
  expect(await tool("act", { panelId: id, ref: "Organization", action: "setValue", args: ["*"] })).toMatchObject({ ok: false, code: "ref_unavailable" });
  expect(await tool("act", { panelId: id, ref: orgRef, action: "setValue", args: ["fabricated"] })).toMatchObject({ ok: false, code: "invalid_value" });
  expect(await tool("act", { panelId: id, ref: orgRef, action: "setValue", args: ["Parsley Health"] })).toMatchObject({ ok: false, code: "invalid_value" });
  expect(await tool("act", { panelId: id, ref: refOf(initial, "Agent model"), action: "setValue", args: ["other"] })).toMatchObject({ ok: false, code: "action_unavailable" });
  expect(await tool("act", { panelId: id, ref: refOf(initial, "Read-only organization"), action: "setValue", args: ["parsley-health"] })).toMatchObject({ ok: false, code: "action_unavailable" });
  expect(saveModel).not.toHaveBeenCalled();
  expect(readOnlyChanged).not.toHaveBeenCalled();
});

it("opens local reviewer popovers and changes their choices without exposing send actions", async () => {
  const send = vi.fn();
  function ReviewerPanel() {
    const { rootRef, panelId } = usePrsUiAgentBridge();
    return <div ref={rootRef} data-testid="Reviewer panel" data-prs-agent-panel={panelId}>
      <Popover>
        <PopoverTrigger data-prs-agent-local="" aria-label="Choose reviewers for Change 1 #1">dev-one</PopoverTrigger>
        <PopoverContent>
          <PopoverTitle>Reviewers for Change 1 #1</PopoverTitle>
          <CheckboxGroup data-prs-agent-local="" aria-label="Reviewer selection for Change 1 #1" defaultValue={["dev-one"]}>
            <Checkbox data-prs-agent-local="" aria-label="dev-one for Change 1 #1" value="dev-one" />
            <Checkbox data-prs-agent-local="" aria-label="dev-two for Change 1 #1" value="dev-two" />
          </CheckboxGroup>
          <Button onClick={send}>Send review request for Change 1 #1</Button>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger aria-label="Unmarked popup">Other</PopoverTrigger>
        <PopoverContent><PopoverTitle>Private popup</PopoverTitle></PopoverContent>
      </Popover>
    </div>;
  }
  const view = render(<ReviewerPanel />);
  const id = panelId(view.getByTestId("Reviewer panel"));
  const initial = await state(id);
  const selector = refOf(initial, "Choose reviewers for Change 1 #1");
  expect(initial.components.find((entry) => entry.ref === selector)).toMatchObject({ actions: ["setOpen"] });
  expect(await tool("act", { panelId: id, ref: selector, action: "setOpen", args: [true] })).toMatchObject({ ok: true });
  const opened = await state(id);
  expect(opened.components.find((entry) => entry.label === "dev-one for Change 1 #1")).toMatchObject({ checked: true });
  expect(await tool("act", { panelId: id, ref: refOf(opened, "dev-two for Change 1 #1"), action: "setChecked", args: [true] })).toMatchObject({ ok: true });
  expect((await state(id)).components.find((entry) => entry.label === "dev-two for Change 1 #1")).toMatchObject({ checked: true });
  expect(opened.components.find((entry) => entry.label === "Send review request for Change 1 #1")).toMatchObject({ actions: [] });
  expect(await tool("act", { panelId: id, ref: refOf(opened, "Unmarked popup"), action: "setOpen", args: [true] })).toMatchObject({ ok: false, code: "action_unavailable" });
  expect(send).not.toHaveBeenCalled();
});
