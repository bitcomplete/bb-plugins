// BB-361: the local ticket source through the plugin's own surfaces -- the
// `ticket_file`/`ticket_update` tools, the `bb stewards tickets` CLI, adoption
// by state, detach by Backlog, and playbook routing by the snapshot's field.
import { describe, expect, it } from "vitest";
import { PROJECT_FILE, playbookPath } from "./config.js";
import { issue } from "./fixtures.js";
import { isSpecComment } from "./reconcile.js";
import { setup } from "./test-world.js";

/** A project-local initiative playbook, the other choice a local ticket names. */
const INITIATIVE_PLAYBOOK = `---
name: initiative
kind: ticket
source: local
phases:
  Backlog:     { stage: spec }
  Ready:       { stage: spec }
  In Progress: { stage: build, stuck: 7d }
  In Review:   { stage: review, stuck: 3d }
terminal: [Done, Canceled]
ready:
  checklist:
    - Outcome stated
  approval: user
---

You steward one initiative.
`;

/** A project with a Linear steward already spawned, so the ticket tools have a thread. */
async function withSteward() {
  const t = await setup({}, {}, undefined, undefined, (w) => {
    w.files[playbookPath("initiative")] = INITIATIVE_PLAYBOOK;
    const parsed = JSON.parse(w.files[PROJECT_FILE] ?? "{}") as Record<string, unknown>;
    parsed.tickets = [{ match: {}, playbook: "initiative" }, ...((parsed.tickets as unknown[]) ?? [])];
    w.files[PROJECT_FILE] = JSON.stringify(parsed);
  });
  t.entities.set("uuid-12", issue());
  await t.ring("linear", "uuid-12");
  const steward = t.spawns[1]!.id;
  return { t, steward };
}

/** The owner's own turn in the steward thread, so a local ticket may move to Ready. */
const ownerTurn = (t: Awaited<ReturnType<typeof withSteward>>["t"], threadId: string, text = "Please move it to Ready.") => t.userTurns.push({ threadId, text });

describe("the local ticket source through the plugin (BB-361)", () => {
  it("files LOCAL-1 from a project thread and prints it with `bb stewards tickets show`", async () => {
    const { t, steward } = await withSteward();
    const filed = await t.tool("ticket_file", { unit: "local", title: "A local effort", description: "Do the thing." }, steward);
    expect(filed.error).toBe(false);
    expect(filed.text).toContain("LOCAL-1");
    expect(t.hooks.localSource.get("LOCAL-1")).toMatchObject({ title: "A local effort", state: "Backlog", playbook: "local-tickets", projectId: "p1" });
    const shown = await t.harness.behavior.runCli(["tickets", "show", "LOCAL-1"], { threadId: steward, projectId: "p1" });
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("LOCAL-1");
    expect(shown.stdout).toContain("Do the thing.");
  });

  it("adopts on Ready, ends on Backlog, and resumes the same binding and thread on Ready again", async () => {
    const { t, steward } = await withSteward();
    await t.tool("ticket_file", { unit: "local", title: "A local effort", description: "Do the thing." }, steward);
    // Backlog has no binding.
    expect(t.hooks.store.find("LOCAL-1", "p1")).toBeNull();
    // The owner's turn moves it to Ready; the next reconcile adopts it.
    ownerTurn(t, steward);
    await t.tool("ticket_update", { key: "LOCAL-1", state: "Ready" }, steward);
    await t.flush();
    const adopted = t.hooks.store.find("LOCAL-1", "p1");
    expect(adopted).not.toBeNull();
    expect(adopted!.threadId).not.toBeNull();
    expect(adopted!.endedAt).toBeNull();
    // Backlog detaches: the binding ends and its thread is archived.
    await t.tool("ticket_update", { key: "LOCAL-1", state: "Backlog" }, steward);
    await t.flush();
    // The stop turn goes idle, which is how an ending binding finishes.
    await t.idle(adopted!.threadId!);
    await t.flush();
    const ended = t.hooks.store.find("LOCAL-1", "p1")!;
    expect(ended.endedAt).not.toBeNull();
    expect(ended.endReason).toBe("detach");
    expect(t.threads.get(ended.threadId!)!.archivedAt).not.toBeNull();
    // Ready again resumes the same binding and thread.
    ownerTurn(t, steward, "Ready again.");
    await t.tool("ticket_update", { key: "LOCAL-1", state: "Ready" }, steward);
    await t.flush();
    const resumed = t.hooks.store.find("LOCAL-1", "p1")!;
    expect(resumed.id).toBe(adopted!.id);
    expect(resumed.endedAt).toBeNull();
    expect(resumed.threadId).toBe(adopted!.threadId);
  });

  it("lands in Backlog when a non-owner turn moves it to Ready (BB-361 limit 3)", async () => {
    const { t, steward } = await withSteward();
    await t.tool("ticket_file", { unit: "local", title: "A local effort", description: "Do the thing." }, steward);
    // No owner turn: the steward's wake is a plugin send, so a move into an
    // adopted state is refused and the ticket stays parked -- Ready, In
    // Progress or In Review alike.
    await t.tool("ticket_update", { key: "LOCAL-1", state: "Ready" }, steward);
    await t.flush();
    expect(t.hooks.localSource.get("LOCAL-1")!.state).toBe("Backlog");
    expect(t.hooks.store.find("LOCAL-1", "p1")).toBeNull();
    await t.tool("ticket_update", { key: "LOCAL-1", state: "In Progress" }, steward);
    await t.flush();
    expect(t.hooks.localSource.get("LOCAL-1")!.state).toBe("Backlog");
    expect(t.hooks.store.find("LOCAL-1", "p1")).toBeNull();
  });

  it("runs the playbook a local ticket names, and local-tickets by default", async () => {
    const { t, steward } = await withSteward();
    await t.tool("ticket_file", { unit: "local", title: "An effort", description: "Do it." }, steward);
    await t.tool("ticket_file", { unit: "local", title: "An initiative", description: "Reach it.", playbook: "initiative" }, steward);
    ownerTurn(t, steward);
    await t.tool("ticket_update", { key: "LOCAL-2", state: "Ready" }, steward);
    await t.flush();
    const initiative = t.hooks.store.find("LOCAL-2", "p1")!;
    expect(initiative.playbook).toBe("initiative");
    // The default names local-tickets and adopts under it too.
    ownerTurn(t, steward, "Ready the other one.");
    await t.tool("ticket_update", { key: "LOCAL-1", state: "Ready" }, steward);
    await t.flush();
    expect(t.hooks.store.find("LOCAL-1", "p1")!.playbook).toBe("local-tickets");
  });

  it("runs the local tickets CLI: file, comment, export and close", async () => {
    const { t, steward } = await withSteward();
    const filed = await t.harness.behavior.runCli(["tickets", "file", "--title", "CLI effort", "--description", "From the CLI."], { threadId: steward, projectId: "p1" });
    expect(filed.exitCode).toBe(0);
    expect(filed.stdout).toContain("LOCAL-1");
    const comment = await t.harness.behavior.runCli(["tickets", "comment", "LOCAL-1", "--body", "A note."], { threadId: steward, projectId: "p1" });
    expect(comment.exitCode).toBe(0);
    expect(t.hooks.localSource.comments("LOCAL-1").map((c) => c.body).join("")).toContain("A note.");
    const exported = await t.harness.behavior.runCli(["tickets", "export", "--json"], { threadId: steward, projectId: "p1" });
    expect(exported.stdout).toContain("CLI effort");
    const closed = await t.harness.behavior.runCli(["tickets", "close", "LOCAL-1"], { threadId: steward, projectId: "p1" });
    expect(closed.exitCode).toBe(0);
    expect(t.hooks.localSource.get("LOCAL-1")!.state).toBe("Done");
  });

  it("counts an owner page comment as the user's spec, and never an agent comment (BB-361 limit 2)", async () => {
    const { t, steward } = await withSteward();
    await t.tool("ticket_file", { unit: "local", title: "A local effort", description: "Do the thing." }, steward);
    // The owner's comment enters on the Stewards page: a client call.
    await t.harness.callRpc("stewardsLocalComment", { key: "LOCAL-1", body: "**Spec:** the owner's words" }, { experimental_caller: { kind: "client" } });
    // An agent comment goes through `ticket_comment` and is signed.
    await t.tool("ticket_comment", { key: "LOCAL-1", body: "**Spec:** a worker's words" }, steward);
    const snap = t.hooks.localSource.snapshot("LOCAL-1")!;
    const owner = snap.comments.find((c) => c.body.includes("the owner's words"))!;
    const agent = snap.comments.find((c) => c.body.includes("a worker's words"))!;
    expect(owner.signedBy).toBeNull();
    expect(agent.signedBy).not.toBeNull();
    expect(isSpecComment(owner, "thr_s", undefined, snap.viewer, "local")).toBe(true);
    expect(isSpecComment(agent, "thr_s", undefined, snap.viewer, "local")).toBe(false);
  });
});
