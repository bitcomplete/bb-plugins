// BB-360: the source-neutral ticket tools, registered for steward and worker
// threads. Each is a thin dispatch over `source-contract.ts` by the shape of
// the key it is given: `BB-123` is Linear, `owner/repo#N` is GitHub. Nothing
// here names a system in its output; the per-source differences that remain
// (what a source cannot do) are the source's own errors, surfaced verbatim.
//
// The tools keep the validations stewards already does: a filed description
// and a comment body are signed with the contract's `signatureLine` before
// they are sent, the source refuses an unsigned body and an assignee other
// than this server's own login, and `ticket_file` resolves its unit against
// the project's own teams and repos, defaulting only when there is exactly
// one.
//
// `ticket_watch` is the one tool that is not a contract dispatch: it records
// the watching thread beside the entity id and the plugin's existing ring
// path (`stewardsRing`) wakes it, so no source-contract RPC is needed.
import type { BbPluginApi, PluginKvStorage } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { signatureLine, sourceContract, type EntitySnapshot, type SearchIssue, type Source } from "./source-contract.js";

/** The tools this module registers, in the order they read in a thread's tool list. */
export const TICKET_TOOL_NAMES = ["ticket_file", "ticket_read", "ticket_search", "ticket_comment", "ticket_update", "ticket_watch"] as const;
export type TicketToolName = (typeof TICKET_TOOL_NAMES)[number];

/** Linear's issue key, `ENG-123`. */
const LINEAR_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/u;

const GH_NAME = "[A-Za-z0-9_.-]+";
// Every way a person writes a GitHub issue or pull request: a URL, an
// owner/repo/issues/N path, or owner/repo#N.
const GH_FORMS = [
  new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${GH_NAME})/(${GH_NAME})/(?:pulls?|issues?)/(\\d+)(?:[/?#].*)?$`, "u"),
  new RegExp(`^(${GH_NAME})/(${GH_NAME})/(?:pulls?|issues?)/(\\d+)$`, "u"),
  new RegExp(`^(${GH_NAME})/(${GH_NAME})#(\\d+)$`, "u"),
];

/** A GitHub reference from any of its forms, or null. */
function parseGitHubRef(input: string): { repo: string; number: number } | null {
  const s = input.trim();
  for (const form of GH_FORMS) {
    const m = form.exec(s);
    if (m === null) continue;
    const number = Number(m[3]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { repo: `${m[1]}/${m[2]}`, number };
  }
  return null;
}

/** A ticket key resolved to the source it names and the id a source reads it by. */
export type TicketKey = { source: "linear" | "github" | "local"; id: string; key: string };

/** A Linear key `ENG-1` and a local key `LOCAL-1` are the same shape; the project's prefix tells them apart. */
const localKeyRe = (prefix: string): RegExp => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}-\\d+$`, "iu");

/** The source a key names, by its shape alone; null when it is none of them. */
export function sourceOfTicketKey(key: string, localPrefix?: string | null): "linear" | "github" | "local" | null {
  const trimmed = key.trim();
  if (parseGitHubRef(trimmed) !== null) return "github";
  // BB-361: the project's local prefix wins over the Linear shape, since a
  // prefix equal to a Linear team key is refused at config load.
  if (localPrefix !== undefined && localPrefix !== null && localPrefix !== "" && localKeyRe(localPrefix).test(trimmed)) return "local";
  if (LINEAR_KEY.test(trimmed)) return "linear";
  return null;
}

/**
 * Resolve a ticket key. A Linear key is both its own id and its own key; a
 * GitHub reference is canonicalized to `owner/repo#N`, which is the id the
 * source's snapshot and ring path use. A local key is its own id too.
 */
export function parseTicketKey(key: string, localPrefix?: string | null): TicketKey | null {
  const trimmed = key.trim();
  const source = sourceOfTicketKey(trimmed, localPrefix);
  if (source === null) return null;
  if (source === "local") return { source, id: trimmed, key: trimmed };
  const ref = parseGitHubRef(trimmed);
  if (ref === null) return { source, id: trimmed, key: trimmed };
  const canonical = `${ref.repo}#${ref.number}`;
  return { source, id: canonical, key: canonical };
}

/** One unit a ticket may be filed in: a Linear team key, a GitHub owner/repo, or the local project. */
export type TicketUnit = { source: "linear" | "github" | "local"; unit: string };

/** The project's units as filing targets: its Linear teams, then its GitHub repos, then local. */
export function ticketUnits(file: { linear: { teams: string[] } }, repos: readonly string[], localProjectId?: string | null): TicketUnit[] {
  return [...file.linear.teams.map((unit): TicketUnit => ({ source: "linear", unit })), ...repos.map((unit): TicketUnit => ({ source: "github", unit })), ...(localProjectId === undefined || localProjectId === null ? [] : [{ source: "local" as const, unit: localProjectId }])];
}

/** The name a person types for a unit: `local` for the local project, the unit itself otherwise. */
const unitName = (u: TicketUnit): string => (u.source === "local" ? "local" : u.unit);

const listUnits = (units: readonly TicketUnit[]): string => (units.length === 0 ? "none" : units.map(unitName).join(", "));

export type UnitResolution = { ok: true; unit: TicketUnit } | { ok: false; error: string };

/**
 * Resolve the unit `ticket_file` files into: the named one when given, the
 * only configured one when there is exactly one, and a refusal naming the
 * units when several are configured and none was named.
 */
export function resolveFileUnit(units: readonly TicketUnit[], requested: string | undefined): UnitResolution {
  const name = (requested ?? "").trim();
  if (name !== "") {
    const found = name.toLowerCase() === "local" ? units.find((u) => u.source === "local") : units.find((u) => u.unit.toLowerCase() === name.toLowerCase());
    return found === undefined
      ? { ok: false, error: `${JSON.stringify(name)} is not one of this project's units (${listUnits(units)}); file in one of those.` }
      : { ok: true, unit: found };
  }
  if (units.length === 0) return { ok: false, error: "This project lists no Linear team, GitHub repo or local source to file in." };
  if (units.length === 1) return { ok: true, unit: units[0]! };
  return { ok: false, error: `This project lists several units (${listUnits(units)}); name the one to file in with unit.` };
}

/** Whether an assignee value names this server's own login, `me`, or `nobody` (clear). */
export function assigneeAllowed(value: string, own: readonly (string | null)[]): boolean {
  const v = value.trim().toLowerCase();
  if (v === "" || v === "me" || v === "nobody") return true;
  return own.some((login) => login !== null && login.trim().toLowerCase() === v);
}

/** The text a `ticket_read` returns: the facts a steward acts on, no system named. */
export function formatTicket(entity: EntitySnapshot): string {
  const lines: string[] = [`${entity.key}: ${entity.title ?? "(untitled)"}`];
  lines.push(`${entity.state}${entity.unit === "" ? "" : ` · ${entity.unit}`}${entity.url === null ? "" : ` · ${entity.url}`}`);
  if (entity.labels.length > 0) lines.push(`labels: ${entity.labels.join(", ")}`);
  if (entity.assignees.length > 0) lines.push(`assignees: ${entity.assignees.join(", ")}`);
  if (entity.priority !== null) lines.push(`priority: ${entity.priority}`);
  if (entity.parent !== null) lines.push(`parent: ${entity.parent.key}`);
  if (entity.description !== null && entity.description.trim() !== "") lines.push("", entity.description.trim());
  if (entity.comments.length > 0) {
    lines.push("", `comments (${entity.comments.length}, newest last):`);
    for (const c of entity.comments) lines.push(`- ${c.author} (${c.did})${c.signedBy === null ? "" : ` [bb thread ${c.signedBy}]`}: ${c.body.replace(/\s+/gu, " ").trim().slice(0, 400)}`);
  }
  return lines.join("\n");
}

/** One line per search hit. */
export function formatSearchHit(issue: SearchIssue): string {
  return `${issue.key}  ${issue.state}${issue.assignee === null ? "" : `  @${issue.assignee}`}  ${issue.title ?? "(untitled)"}${issue.unit === "" ? "" : `  [${issue.unit}]`}`;
}

// ---- the watch registry ------------------------------------------------------
//
// One KV row per (source, entity id, thread): the row is the truth, and the
// plugin's existing `stewardsRing` path reads it to wake the thread. Storing
// one row per watcher means an add or a remove is a single write, never a
// read-modify-write of a shared list.

const WATCH_PREFIX = "ticket-watch/";
const watchKey = (source: string, id: string, threadId: string): string => `${WATCH_PREFIX}${source}/${id}/${threadId}`;

export type TicketWatcher = { threadId: string; key: string };

export interface TicketWatches {
  add(threadId: string, ref: { source: Source; id: string; key: string }): Promise<void>;
  remove(threadId: string, source: Source, id: string): Promise<void>;
  /** Forget every watch a thread holds, when the thread is archived or deleted. */
  removeThread(threadId: string): Promise<void>;
  /** Every thread watching this entity, with the key to show it. */
  watchers(source: Source, id: string): Promise<TicketWatcher[]>;
  /** The watched entity ids per source, for the interest set the sources lease on. */
  interest(): Promise<{ linear: string[]; github: string[] }>;
}

export function createTicketWatches(kv: PluginKvStorage): TicketWatches {
  return {
    async add(threadId, ref) {
      await kv.set(watchKey(ref.source, ref.id, threadId), { key: ref.key });
    },
    async remove(threadId, source, id) {
      await kv.delete(watchKey(source, id, threadId));
    },
    async removeThread(threadId) {
      const suffix = `/${threadId}`;
      for (const key of await kv.list(WATCH_PREFIX)) if (key.endsWith(suffix)) await kv.delete(key);
    },
    async watchers(source, id) {
      const prefix = `${WATCH_PREFIX}${source}/${id}/`;
      const out: TicketWatcher[] = [];
      for (const key of await kv.list(prefix)) {
        const stored = await kv.get<{ key?: unknown }>(key);
        out.push({ threadId: key.slice(prefix.length), key: typeof stored?.key === "string" ? stored.key : id });
      }
      return out;
    },
    async interest() {
      const linear = new Set<string>();
      const github = new Set<string>();
      for (const key of await kv.list(WATCH_PREFIX)) {
        const rest = key.slice(WATCH_PREFIX.length);
        const first = rest.indexOf("/");
        const last = rest.lastIndexOf("/");
        if (first < 0 || last <= first) continue;
        const source = rest.slice(0, first);
        const id = rest.slice(first + 1, last);
        if (source === "linear") linear.add(id);
        else if (source === "github") github.add(id);
      }
      return { linear: [...linear], github: [...github] };
    },
  };
}

// ---- registration ------------------------------------------------------------

/** What the calling thread's project offers the ticket tools. */
export type TicketProject = { units: TicketUnit[]; viewer: { linear: string | null; github: string | null }; localPrefix: string };

export interface TicketToolDeps {
  /** One source-contract call, to the plugin that serves the source. */
  sourceRpc: <T>(source: Source, method: string, input: unknown, outputSchema: z.ZodType<T>) => Promise<T>;
  /** One fresh entity read through the contract. */
  snapshot: (source: Source, id: string) => Promise<EntitySnapshot | null>;
  /** The calling thread's project: its filing units and this server's own logins. */
  project: (projectId: string) => Promise<TicketProject | null>;
  /**
   * Whether the calling thread's newest turn was started by the owner's own
   * message (a plain client turn), not a plugin wake or a forward carrying
   * someone else's text. A local ticket only moves to Ready on the owner's
   * turn; anything else lands in Backlog (BB-361).
   */
  ownerTurn: (threadId: string) => Promise<boolean>;
  /** The watch registry the ring path wakes from. */
  watches: TicketWatches;
  /** Ask the plugin to re-send the interest set, after a watch is added. */
  pushInterest: () => void;
  log: (message: string) => void;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const toolError = (error: unknown) => ({ content: [{ type: "text" as const, text: errorMessage(error) }], isError: true });

/** Sign a body the way `ticket_file` and `ticket_comment` do: the contract's signature line, on its own, last. */
export const signedTicketBody = (threadId: string, body: string): string => `${body.trimEnd()}\n\n${signatureLine(threadId)}`;

const badKey = (key: string): Error =>
  new Error(`${JSON.stringify(key)} is not a ticket key. Give a Linear key such as BB-123, or a GitHub issue as owner/repo#12 or its URL.`);

/** Register the six source-neutral ticket tools. The role selection decides who sees them. */
export function registerTicketTools(bb: BbPluginApi, deps: TicketToolDeps): void {
  const sign = signedTicketBody;

  bb.agents.registerTool({
    name: "ticket_file",
    description:
      "File a new ticket. Give a unit (a Linear team key such as ENG, or a GitHub owner/repo) when the project lists more than one; with a single unit it is the default. The description is signed for you. On GitHub there is no priority; a Linear ticket may carry one. The assignee is this server's own login or nobody.",
    presentation: { label: { pending: "Filing a ticket", completed: "Filed a ticket" } },
    parameters: z.object({
      unit: z.string().trim().min(1).max(200).optional().describe("The unit to file in: a Linear team key, a GitHub owner/repo, or `local` for this project's local tickets. Omit when the project lists exactly one."),
      title: z.string().trim().min(1).max(500).describe("The ticket's title."),
      description: z.string().trim().min(1).max(50_000).describe("The ticket's description, in Markdown. Do not sign it; the plugin signs it."),
      labels: z.array(z.string().trim().min(1).max(100)).max(50).optional().describe("Label names to add. A local ticket has no labels."),
      priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional().describe("The priority. A source with no priority (GitHub, local) refuses it."),
      parent: z.string().trim().min(1).max(200).optional().describe("The parent ticket's key, to file this as a child."),
      assignee: z.string().trim().min(1).max(200).optional().describe("'me' for this server's own login, or 'nobody'. Any other person is refused."),
      playbook: z.string().trim().min(1).max(200).optional().describe("A local ticket's playbook: `ticket` (the default) or `initiative`. Linear and GitHub ignore it."),
    }),
    async execute(input, { threadId, projectId }) {
      try {
        const project = await deps.project(projectId);
        if (project === null) return toolError(new Error("This thread's project has no readable stewards configuration."));
        const resolved = resolveFileUnit(project.units, input.unit);
        if (!resolved.ok) return toolError(new Error(resolved.error));
        if (input.assignee !== undefined && !assigneeAllowed(input.assignee, [project.viewer.linear, project.viewer.github])) {
          return toolError(new Error(`assignee accepts only this server's own login (${project.viewer.linear ?? project.viewer.github ?? "me"}) or 'nobody', not ${JSON.stringify(input.assignee)}.`));
        }
        const out = await deps.sourceRpc(
          resolved.unit.source,
          "sourceCreateIssue",
          {
            unit: resolved.unit.unit,
            title: input.title,
            description: sign(threadId, input.description),
            labels: input.labels ?? [],
            ...(input.priority === undefined ? {} : { priority: input.priority }),
            ...(input.parent === undefined ? {} : { parent: input.parent }),
            ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
            ...(input.playbook === undefined ? {} : { playbook: input.playbook }),
          },
          sourceContract.sourceCreateIssue.output,
        );
        return `Filed ${out.key}${out.url === null ? "" : `: ${out.url}`}`;
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "ticket_read",
    description:
      "Read one ticket by key: a Linear key such as BB-123, or a GitHub issue as owner/repo#12 or its URL. Returns its title, state, unit, labels, assignees, priority, parent, description and latest comments.",
    presentation: { label: { pending: "Reading a ticket", completed: "Read a ticket" } },
    parameters: z.object({ key: z.string().trim().min(1).max(300).describe("The ticket key: BB-123, or owner/repo#12.") }),
    async execute({ key }, { projectId }) {
      try {
        const project = await deps.project(projectId);
        const ref = parseTicketKey(key, project?.localPrefix);
        if (ref === null) return toolError(badKey(key));
        const entity = await deps.snapshot(ref.source, ref.id);
        return entity === null ? toolError(new Error(`No ticket ${ref.key}, or it is not visible to this server.`)) : formatTicket(entity);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "ticket_search",
    description:
      "Find tickets by free text. Searches every unit the project lists, or only the units named. Returns one line per ticket, newest first.",
    presentation: { label: { pending: "Searching tickets", completed: "Searched tickets" } },
    parameters: z.object({
      query: z.string().trim().min(1).max(500).describe("Free text over titles and descriptions."),
      units: z.array(z.string().trim().min(1).max(200)).max(100).optional().describe("The units to search: Linear team keys or GitHub owner/repos. Omit for every unit the project lists."),
    }),
    async execute({ query, units }, { projectId }) {
      try {
        const project = await deps.project(projectId);
        if (project === null) return toolError(new Error("This thread's project has no readable stewards configuration."));
        let selected = project.units;
        if (units !== undefined && units.length > 0) {
          const wanted = units.map((u) => u.trim().toLowerCase());
          const missing = units.filter((u) => !project.units.some((x) => unitName(x).toLowerCase() === u.trim().toLowerCase()));
          if (missing.length > 0) return toolError(new Error(`${missing.map((u) => JSON.stringify(u)).join(", ")} ${missing.length === 1 ? "is" : "are"} not among this project's units (${listUnits(project.units)}).`));
          selected = project.units.filter((u) => wanted.includes(unitName(u).toLowerCase()));
        }
        const bySource = new Map<"linear" | "github" | "local", string[]>();
        for (const u of selected) bySource.set(u.source, [...(bySource.get(u.source) ?? []), u.unit]);
        const found: SearchIssue[] = [];
        for (const [source, sourceUnits] of bySource) {
          const out = await deps.sourceRpc(source, "sourceSearchIssues", { units: sourceUnits, query, limit: 20 }, sourceContract.sourceSearchIssues.output);
          found.push(...out.issues);
        }
        return found.length === 0 ? `No tickets match ${JSON.stringify(query)}.` : found.map(formatSearchHit).join("\n");
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "ticket_comment",
    description: "Add a comment to a ticket by key. The comment is signed for you; do not sign it yourself.",
    presentation: { label: { pending: "Commenting on a ticket", completed: "Commented on a ticket" } },
    parameters: z.object({
      key: z.string().trim().min(1).max(300).describe("The ticket key: BB-123, or owner/repo#12."),
      body: z.string().trim().min(1).max(20_000).describe("The comment, in Markdown. Do not sign it; the plugin signs it."),
    }),
    async execute({ key, body }, { threadId, projectId }) {
      try {
        const project = await deps.project(projectId);
        const ref = parseTicketKey(key, project?.localPrefix);
        if (ref === null) return toolError(badKey(key));
        const out = await deps.sourceRpc(ref.source, "sourceComment", { key: ref.key, body: sign(threadId, body) }, sourceContract.sourceComment.output);
        return `Commented on ${ref.key}${out.url === null ? "" : `: ${out.url}`}`;
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "ticket_update",
    description:
      "Change a ticket by key: add labels, set a priority, set the state, set the assignee, or add relations ({ type, issue } with type blockedBy, blocks, related or duplicate). Give only the fields to change; a source that has no concept for a field returns its own error. `state` is the source's own vocabulary: a Linear workflow state name, or on GitHub `open`, `closed`, `closed (not planned)` or a `status:<phase>` label, which replaces the other status labels. `priority` is Linear's (GitHub has none). The assignee is this server's own login or nobody.",
    presentation: { label: { pending: "Updating a ticket", completed: "Updated a ticket" } },
    parameters: z.object({
      key: z.string().trim().min(1).max(300).describe("The ticket key: BB-123, or owner/repo#12."),
      state: z.string().trim().min(1).max(60).optional().describe("The state: a Linear workflow state name, or on GitHub `open`, `closed`, `closed (not planned)` or a `status:<phase>` label."),
      labels: z.array(z.string().trim().min(1).max(100)).max(50).optional().describe("Label names to add."),
      priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional().describe("The priority. A source with no priority refuses it."),
      assignee: z.string().trim().min(1).max(200).optional().describe("'me' for this server's own login, or 'nobody' to clear. Any other person is refused."),
      relations: z
        .array(z.object({ type: z.enum(["blockedBy", "blocks", "related", "duplicate"]), issue: z.string().trim().min(1).max(200) }))
        .max(20)
        .optional()
        .describe("Relations to add."),
    }),
    async execute(input, { projectId, threadId }) {
      try {
        const project = await deps.project(projectId);
        const ref = parseTicketKey(input.key, project?.localPrefix);
        if (ref === null) return toolError(badKey(input.key));
        if (input.assignee !== undefined && (project === null || !assigneeAllowed(input.assignee, [project.viewer.linear, project.viewer.github]))) {
          return toolError(new Error(`assignee accepts only this server's own login${project === null ? "" : ` (${project.viewer.linear ?? project.viewer.github ?? "me"})`} or 'nobody', not ${JSON.stringify(input.assignee)}.`));
        }
        // BB-361: a local ticket only moves to Ready in a turn the owner
        // started; a participant's forward or a plugin wake lands it in
        // Backlog instead.
        let state = input.state;
        if (ref.source === "local" && state !== undefined && state.trim().toLowerCase() === "ready" && !(await deps.ownerTurn(threadId))) state = "Backlog";
        const out = await deps.sourceRpc(
          ref.source,
          "sourceUpdateIssue",
          {
            key: ref.key,
            addLabels: input.labels ?? [],
            ...(state === undefined ? {} : { state }),
            ...(input.priority === undefined ? {} : { priority: input.priority }),
            ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
            relations: input.relations ?? [],
          },
          sourceContract.sourceUpdateIssue.output,
        );
        return `${ref.key}: ${out.changed.length === 0 ? "no change" : out.changed.join("; ")}.`;
      } catch (error) {
        return toolError(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "ticket_watch",
    description:
      "Watch a ticket by key and end the turn rather than polling: this thread is messaged when the ticket changes. The source's own ring path fires the wake, so it works wherever the project's source is connected; a source that only polls wakes on its next poll.",
    presentation: { label: { pending: "Watching a ticket", completed: "Watching a ticket" } },
    parameters: z.object({ key: z.string().trim().min(1).max(300).describe("The ticket key: BB-123, or owner/repo#12.") }),
    async execute({ key }, { threadId, projectId }) {
      try {
        const project = await deps.project(projectId);
        const ref = parseTicketKey(key, project?.localPrefix);
        if (ref === null) return toolError(badKey(key));
        const entity = await deps.snapshot(ref.source, ref.id);
        if (entity === null) return toolError(new Error(`No ticket ${ref.key}, or it is not visible to this server.`));
        await deps.watches.add(threadId, { source: entity.source, id: entity.id, key: entity.key });
        deps.pushInterest();
        return `Watching ${entity.key}. This thread will be messaged when it changes; end the turn rather than polling.`;
      } catch (error) {
        return toolError(error);
      }
    },
  });
}
