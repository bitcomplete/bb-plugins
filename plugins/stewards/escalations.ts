// Escalation routing: where an escalation goes next, how it is delivered to
// the binding that decides it, and the escalations routed to a binding from
// its children. This is the routing seam, kept in its own module so a change
// to it is always the owner's.
//
// The functions take an `EscalationsContext` rather than the server's whole
// closure, so nothing here reads the plugin's config or snapshots on its own.
import type { Binding, Escalation, EscalationRoute, Store } from "./store.js";

/**
 * What the escalation routing needs from the server: the store, the reconcile
 * scheduler a delivered escalation wakes, and the project wake a route that
 * reaches the project steward uses. Passed in so this module holds no state.
 */
export type EscalationsContext = {
  store: Store;
  scheduleReconcile: (bindingId: string) => void;
  wakeProject: (projectId: string, reason: string, opts: { digestDue: boolean; notes?: string[] }) => Promise<void>;
};

/** The escalations routed to `b` from its children, for the wake to list. */
export function routedTo(ctx: EscalationsContext, b: Binding): Array<{ escalation: Escalation; from: Binding }> {
  return ctx.store.children(b.id).flatMap((child) => ctx.store.openEscalations(child.id).filter((x) => x.route === "parent").map((escalation) => ({ escalation, from: child })));
}

/** Where an escalation goes next, above where it is. */
export function nextRoute(ctx: EscalationsContext, b: Binding, from: EscalationRoute | null): EscalationRoute {
  if (from === null) {
    const parent = b.parentBindingId === null ? null : ctx.store.binding(b.parentBindingId);
    return parent !== null && parent.endedAt === null && parent.threadId !== null ? "parent" : "project";
  }
  if (from === "steward" || from === "parent") return "project";
  return "user";
}

/**
 * Deliver an escalation to whatever decides it: a worker's goes to the
 * binding's own steward, a child's to its parent, and a route-`project` one
 * wakes the project steward. A route-`user` escalation is the project
 * steward's to ask in its own thread, so nothing is delivered here.
 */
export async function deliverEscalation(ctx: EscalationsContext, b: Binding, x: Escalation): Promise<void> {
  if (x.route === "user") return;
  // A worker's escalation is for the binding's own steward.
  if (x.route === "steward") {
    ctx.store.note(b.id, `Escalation ${x.id} from a worker (${x.kind}): ${x.question}`);
    ctx.scheduleReconcile(b.id);
    return;
  }
  if (x.route === "parent" && b.parentBindingId !== null) {
    ctx.store.note(b.parentBindingId, `Escalation ${x.id} from ${b.entityKey} (${x.kind}): ${x.question}`);
    ctx.scheduleReconcile(b.parentBindingId);
    return;
  }
  await ctx.wakeProject(b.projectId, `escalation from ${b.entityKey}`, { digestDue: false });
}
