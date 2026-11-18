// BB-361: the built-in `local` ticket source. A local ticket lives in the
// stewards SQLite store, is served by the stewards plugin itself over the same
// `source-contract.ts` linear and github serve, and is adopted by state rather
// than by label. Writes ring the reconcile loop in-process: no webhook, no
// lease, no bb-gate-hooks.
//
// This module is the store side of the source: SQL over the two tables
// `LOCAL_TICKET_MIGRATIONS` creates, plus the mapping to `EntitySnapshot`. The
// server wires it into `sourceRpc` (so `sourceRpc("local", …)` never leaves
// the process), into the ticket tools and CLI, and into the ring path.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { DEFAULT_LOCAL_PREFIX, LOCAL_PLAYBOOK_CHOICES, LOCAL_TICKETS_PLAYBOOK } from "./config.js";
import { signedBy, type AdoptableEntity, type EntitySnapshot, type SearchIssue, type SnapshotChild, type SnapshotComment } from "./source-contract.js";

/** The six states a local ticket moves through, in the order the playbook reads them. */
export const LOCAL_STATES = ["Backlog", "Ready", "In Progress", "In Review", "Done", "Canceled"] as const;
export type LocalState = (typeof LOCAL_STATES)[number];

/** The two terminal states; a ticket in one is never adopted. */
export const LOCAL_TERMINAL = ["Done", "Canceled"] as const;

/** The state a local ticket is parked in: no binding, and `bb stewards detach` writes it. */
export const LOCAL_PARKED = "Backlog";

const isTerminalState = (state: string): boolean => LOCAL_TERMINAL.some((t) => t.toLowerCase() === state.toLowerCase());
export const isLocalState = (state: string): boolean => LOCAL_STATES.some((s) => s.toLowerCase() === state.toLowerCase());

/** The Linear-like state type a local state maps to, so a consumer that reads `stateType` still works. */
export function localStateType(state: string): string | null {
  switch (state.toLowerCase()) {
    case "backlog":
      return "backlog";
    case "ready":
      return "unstarted";
    case "in progress":
    case "in review":
      return "started";
    case "done":
      return "completed";
    case "canceled":
      return "canceled";
    default:
      return null;
  }
}

/** One local ticket row. `id` is the key (`LOCAL-1`). */
export type LocalTicket = {
  id: string;
  projectId: string;
  prefix: string;
  number: number;
  title: string;
  description: string;
  state: string;
  parentId: string | null;
  playbook: string;
  createdAt: number;
  updatedAt: number;
};

/** One local comment row. `threadId` is the authoring bb thread, or null for an owner page comment. */
export type LocalComment = { id: string; ticketId: string; author: string; threadId: string | null; body: string; createdAt: number };

export type LocalCreateInput = { unit: string; title: string; description: string; playbook?: string; parent?: string; assignee?: string };
export type LocalUpdateInput = { key: string; state?: string; parent?: string | null; addLabels?: string[]; priority?: string; assignee?: string; relations?: unknown[] };

export type LocalSource = ReturnType<typeof createLocalSource>;

const nowIso = (ms: number): string => new Date(ms).toISOString();

/**
 * The local source, backed by the plugin's database. `ring` is called after
 * every write with the ticket key, so the reconcile loop runs in-process;
 * `changed` lets the app publish the project signal without a source plugin;
 * `prefixFor` reads a project's `localPrefix` from its config.
 */
export function createLocalSource(deps: { db: Database.Database; now: () => number; ring: (key: string) => void; changed: (projectId: string) => void; prefixFor: (projectId: string) => string; ownerFor: (projectId: string) => string | null }) {
  const { db, now, ring, changed, prefixFor, ownerFor } = deps;

  const insertTicket = db.prepare(
    `INSERT INTO local_tickets (id, project_id, prefix, number, title, description, state, parent_id, playbook, created_at, updated_at)
     VALUES (@id, @project_id, @prefix, @number, @title, @description, @state, @parent_id, @playbook, @created_at, @updated_at)`,
  );
  const getTicket = db.prepare<[string], Record<string, unknown>>("SELECT * FROM local_tickets WHERE id = ? COLLATE NOCASE");
  const ticketsForProject = db.prepare<[string], Record<string, unknown>>("SELECT * FROM local_tickets WHERE project_id = ? ORDER BY number");
  const allTickets = db.prepare<[], Record<string, unknown>>("SELECT * FROM local_tickets ORDER BY created_at, number");
  const maxNumber = db.prepare<[], { n: number | null }>("SELECT MAX(number) AS n FROM local_tickets");
  const childrenOf = db.prepare<[string], Record<string, unknown>>("SELECT * FROM local_tickets WHERE parent_id = ? COLLATE NOCASE ORDER BY number LIMIT 50");
  const childrenCount = db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM local_tickets WHERE parent_id = ? COLLATE NOCASE");
  const updateTicket = db.prepare("UPDATE local_tickets SET state = @state, parent_id = @parent_id, title = @title, description = @description, playbook = @playbook, updated_at = @updated_at WHERE id = @id");
  const insertComment = db.prepare("INSERT INTO local_comments (id, ticket_id, author, thread_id, body, created_at) VALUES (@id, @ticket_id, @author, @thread_id, @body, @created_at)");
  const commentsFor = db.prepare<[string], Record<string, unknown>>("SELECT * FROM local_comments WHERE ticket_id = ? COLLATE NOCASE ORDER BY created_at LIMIT 50");

  const rowToTicket = (r: Record<string, unknown>): LocalTicket => ({
    id: String(r.id),
    projectId: String(r.project_id),
    prefix: String(r.prefix),
    number: Number(r.number),
    title: String(r.title),
    description: String(r.description),
    state: String(r.state),
    parentId: r.parent_id === null || r.parent_id === undefined ? null : String(r.parent_id),
    playbook: String(r.playbook),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
  const rowToComment = (r: Record<string, unknown>): LocalComment => ({
    id: String(r.id),
    ticketId: String(r.ticket_id),
    author: String(r.author),
    threadId: r.thread_id === null || r.thread_id === undefined ? null : String(r.thread_id),
    body: String(r.body),
    createdAt: Number(r.created_at),
  });

  /** The ticket a key names, ignoring case; the key is its own id. */
  const get = (key: string): LocalTicket | null => {
    const r = getTicket.get(key.trim());
    return r === undefined ? null : rowToTicket(r);
  };
  const list = (projectId?: string): LocalTicket[] => (projectId === undefined ? allTickets.all() : ticketsForProject.all(projectId)).map(rowToTicket);
  const comments = (key: string): LocalComment[] => commentsFor.all(key.trim()).map(rowToComment);

  const assertState = (state: string): string => {
    const found = LOCAL_STATES.find((s) => s.toLowerCase() === state.trim().toLowerCase());
    if (found === undefined) throw new Error(`${JSON.stringify(state)} is not a local ticket state; use one of ${LOCAL_STATES.join(", ")}.`);
    return found;
  };

  const nextKey = (prefix: string): { key: string; number: number } => ({ key: `${prefix}-${(maxNumber.get()?.n ?? 0) + 1}`, number: (maxNumber.get()?.n ?? 0) + 1 });

  const resolvePlaybook = (raw: string | undefined): string => {
    const name = (raw ?? "").trim();
    if (name === "") return LOCAL_TICKETS_PLAYBOOK;
    return LOCAL_PLAYBOOK_CHOICES[name.toLowerCase()] ?? name;
  };

  const snapshotOf = (t: LocalTicket, owner: string | null): EntitySnapshot => {
    const kids = childrenOf.all(t.id).map(rowToTicket);
    const childTotal = childrenCount.get(t.id)?.n ?? kids.length;
    const children: SnapshotChild[] = kids.map((c) => ({ id: c.id, key: c.id, title: c.title, state: c.state, stateType: localStateType(c.state), labels: [] }));
    const parent = t.parentId === null ? null : get(t.parentId);
    const cs: SnapshotComment[] = comments(t.id).map((c) => ({ id: c.id, author: c.author, did: "commented", body: c.body, createdAt: nowIso(c.createdAt), url: null, signedBy: c.threadId }));
    return {
      source: "local",
      kind: "issue",
      id: t.id,
      key: t.id,
      url: null,
      title: t.title,
      state: t.state,
      stateType: localStateType(t.state),
      playbook: t.playbook,
      unit: t.projectId,
      labels: [],
      author: null,
      assignees: owner === null ? [] : [owner],
      priority: null,
      estimate: null,
      description: t.description,
      createdAt: nowIso(t.createdAt),
      updatedAt: nowIso(t.updatedAt),
      comments: cs,
      parent: parent === null ? null : { id: parent.id, key: parent.id },
      children,
      ...(childTotal > children.length ? { childrenTotal: childTotal } : {}),
      linkedPulls: [],
      pull: null,
      viewer: owner,
    };
  };

  /** One local ticket as a snapshot. The owner is this server's owner, the implicit assignee. */
  const snapshot = (key: string): EntitySnapshot | null => {
    const t = get(key);
    return t === null ? null : snapshotOf(t, ownerFor(t.projectId));
  };

  /** Whether a ticket is adopted: Backlog is parked, terminal is over, anything else is adopted. */
  const adoptable = (t: LocalTicket): boolean => t.state.toLowerCase() !== LOCAL_PARKED.toLowerCase() && !isTerminalState(t.state);

  const touch = (t: LocalTicket, state: string, parentId: string | null, title: string, description: string): void => {
    updateTicket.run({ id: t.id, state, parent_id: parentId, title, description, playbook: t.playbook, updated_at: now() });
    changed(t.projectId);
    ring(t.id);
  };

  function create(input: LocalCreateInput, owner: string | null): { id: string; key: string; url: string | null } {
    if (signedBy(input.description) === null) throw new Error("a ticket description must end with the bb thread signature line; nothing was filed");
    const projectId = input.unit.trim();
    if (projectId === "") throw new Error("a local ticket needs the project it belongs to as its unit");
    if (input.parent !== undefined) {
      const parent = get(input.parent);
      if (parent === null) throw new Error(`no local ticket ${input.parent} to file under`);
      if (parent.projectId !== projectId) throw new Error(`${input.parent} belongs to another project`);
    }
    const prefix = prefixFor(projectId) || DEFAULT_LOCAL_PREFIX;
    const { key, number } = nextKey(prefix);
    const at = now();
    insertTicket.run({ id: key, project_id: projectId, prefix, number, title: input.title, description: input.description, state: LOCAL_PARKED, parent_id: input.parent ?? null, playbook: resolvePlaybook(input.playbook), created_at: at, updated_at: at });
    changed(projectId);
    ring(key);
    return { id: key, key, url: null };
  }

  function update(input: LocalUpdateInput): { ok: boolean; changed: string[] } {
    if ((input.addLabels ?? []).length > 0) throw new Error("a local ticket has no labels");
    if (input.priority !== undefined) throw new Error("a local ticket has no priority");
    if ((input.relations ?? []).length > 0) throw new Error("a local ticket has no relations");
    const assignee = (input.assignee ?? "").trim().toLowerCase();
    if (assignee !== "" && assignee !== "me" && assignee !== "nobody") throw new Error("the local assignee is always this server's owner");
    const t = get(input.key);
    if (t === null) throw new Error(`no local ticket ${input.key}`);
    const changedFields: string[] = [];
    let state = t.state;
    let parentId = t.parentId;
    if (input.state !== undefined) {
      state = assertState(input.state);
      if (state !== t.state) changedFields.push(`state ${t.state} → ${state}`);
    }
    if (input.parent !== undefined) {
      if (input.parent === null || input.parent.trim() === "") {
        if (t.parentId !== null) changedFields.push("parent cleared");
        parentId = null;
      } else {
        const parent = get(input.parent);
        if (parent === null) throw new Error(`no local ticket ${input.parent}`);
        if (parent.id === t.id) throw new Error("a local ticket cannot be its own parent");
        if (parent.projectId !== t.projectId) throw new Error(`${parent.id} belongs to another project`);
        if (parent.id !== t.parentId) changedFields.push(`parent ${parent.id}`);
        parentId = parent.id;
      }
    }
    if (changedFields.length === 0) return { ok: true, changed: [] };
    touch(t, state, parentId, t.title, t.description);
    return { ok: true, changed: changedFields };
  }

  function comment(key: string, body: string): { ok: boolean; url: string | null } {
    const threadId = signedBy(body);
    if (threadId === null) throw new Error("a comment must end with the bb thread signature line; nothing was added");
    const t = get(key);
    if (t === null) throw new Error(`no local ticket ${key}`);
    insertComment.run({ id: `lc_${randomBytes(8).toString("hex")}`, ticket_id: t.id, author: threadId, thread_id: threadId, body, created_at: now() });
    touch(t, t.state, t.parentId, t.title, t.description);
    return { ok: true, url: null };
  }

  function ownerComment(key: string, body: string, owner: string): { ok: boolean; url: string | null } {
    const t = get(key);
    if (t === null) throw new Error(`no local ticket ${key}`);
    insertComment.run({ id: `lc_${randomBytes(8).toString("hex")}`, ticket_id: t.id, author: owner, thread_id: null, body, created_at: now() });
    touch(t, t.state, t.parentId, t.title, t.description);
    return { ok: true, url: null };
  }

  function editDescription(key: string, description: string): { ok: boolean } {
    const t = get(key);
    if (t === null) throw new Error(`no local ticket ${key}`);
    touch(t, t.state, t.parentId, t.title, description);
    return { ok: true };
  }

  function adoptableList(projectIds: readonly string[], limit: number): AdoptableEntity[] {
    const wanted = new Set(projectIds.map((p) => p.toLowerCase()));
    const out: AdoptableEntity[] = [];
    for (const t of list()) {
      if (!wanted.has(t.projectId.toLowerCase())) continue;
      if (!adoptable(t)) continue;
      out.push({ id: t.id, key: t.id, unit: t.projectId, kind: "issue", state: t.state, labels: [], author: null, draft: false, createdAt: nowIso(t.createdAt) });
      if (out.length >= limit) break;
    }
    return out;
  }

  function search(projectIds: readonly string[], query: string, limit: number): SearchIssue[] {
    const wanted = new Set(projectIds.map((p) => p.toLowerCase()));
    const needle = query.toLowerCase();
    const out: SearchIssue[] = [];
    for (const t of list()) {
      if (!wanted.has(t.projectId.toLowerCase())) continue;
      if (!t.title.toLowerCase().includes(needle) && !t.description.toLowerCase().includes(needle)) continue;
      out.push({ id: t.id, key: t.id, title: t.title, description: t.description, state: t.state, stateType: localStateType(t.state), unit: t.projectId, assignee: null });
      if (out.length >= limit) break;
    }
    return out;
  }

  return { get, list, comments, create, update, comment, ownerComment, editDescription, setState: (key: string, state: string) => update({ key, state }), adoptable: adoptableList, adoptableTicket: adoptable, search, snapshot, snapshotOf, states: LOCAL_STATES };
}
