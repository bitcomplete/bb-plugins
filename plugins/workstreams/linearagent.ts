// The manual fallback for tickets no Linear key covers: ask ONE agent thread,
// in the BB project that owns the checkouts, to look the tickets up with
// whatever Linear tools that project's session has. The project decides the
// Linear identity; this plugin never holds it. Pure: the prompt, and the
// parser for the answer.
import { z } from "zod";
import type { LinearDetail } from "./linear.js";
import { projectForPath } from "./spawn.js";

/** The most tickets one fallback run asks about. */
export const AGENT_FETCH_MAX = 60;

export function agentFetchPrompt(tickets: readonly string[]): string {
  return [
    "Look up these Linear issues with the Linear tools available in this session:",
    tickets.join(", "),
    "",
    "Then output exactly one fenced ```json block containing an array with one object per issue you found:",
    '{"identifier": "ABC-1", "title": "...", "state": "...", "project": "..." or null, "parentIdentifier": "..." or null, "parentTitle": "..." or null, "url": "..." or null}',
    "Output nothing else of substance. Do not change anything in Linear.",
    "If no Linear tools are available in this session, say so in one line and output an empty array: ```json\n[]\n```",
  ].join("\n");
}

const entrySchema = z
  .object({
    identifier: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/u),
    title: z.string().max(500).nullish(),
    state: z.string().max(100).nullish(),
    project: z.string().max(300).nullish(),
    parentIdentifier: z.string().max(40).nullish(),
    parentTitle: z.string().max(500).nullish(),
    url: z.string().max(500).nullish(),
  })
  .strip();
const answerSchema = z.array(entrySchema).max(AGENT_FETCH_MAX * 2);

const JSON_BLOCK = /```json[^\S\n]*\n([\s\S]*?)```/giu;

/**
 * The entries in the LAST ```json block of the agent's final message. An
 * earlier block is the agent thinking out loud; the last one is its answer. An
 * empty array is a valid answer (no Linear tools). Anything else invalid is a
 * failure with a short reason, and stores nothing.
 */
export function parseAgentAnswer(
  text: string | null | undefined,
  asked: readonly string[],
): { ok: true; details: LinearDetail[] } | { ok: false; reason: string } {
  if (text === null || text === undefined) return { ok: false, reason: "No final message." };
  const blocks = [...text.matchAll(JSON_BLOCK)];
  const last = blocks[blocks.length - 1]?.[1];
  if (last === undefined) return { ok: false, reason: "No json block in the final message." };
  let raw: unknown;
  try {
    raw = JSON.parse(last);
  } catch {
    return { ok: false, reason: "The json block is not valid JSON." };
  }
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "The json block is not an array of issues." };
  // Only what was asked about is stored: an agent cannot add tickets to the cache.
  const wanted = new Set(asked.map((ticket) => ticket.toUpperCase()));
  const details = parsed.data.flatMap((entry): LinearDetail[] => {
    const identifier = entry.identifier.toUpperCase();
    if (!wanted.has(identifier)) return [];
    return [
      {
        identifier,
        title: entry.title ?? null,
        description: null,
        state: entry.state === null || entry.state === undefined ? null : { name: entry.state, type: null },
        project: entry.project === null || entry.project === undefined || entry.project.trim() === "" ? null : { id: null, name: entry.project },
        parent:
          entry.parentIdentifier === null || entry.parentIdentifier === undefined
            ? entry.parentTitle === null || entry.parentTitle === undefined
              ? null
              : { identifier: null, title: entry.parentTitle }
            : { identifier: entry.parentIdentifier.toUpperCase(), title: entry.parentTitle ?? null },
        labels: [],
        url: entry.url !== null && entry.url !== undefined && /^https:\/\//u.test(entry.url) ? entry.url : null,
        updatedAt: null,
        source: "agent",
      },
    ];
  });
  return { ok: true, details };
}

/** The slice of `bb.sdk` the fallback needs. */
export type LinearFetchSdk = {
  projects: {
    list(): Promise<readonly { id: string; sources: readonly { hostId: string; path: string }[] }[]>;
  };
  threads: {
    spawn(args: {
      projectId: string;
      environment: { type: "host"; hostId: string; workspace: { type: "unmanaged"; path: string } };
      prompt: string;
      pluginMetadata: { purpose: string };
    }): Promise<{ id: string }>;
  };
};

/**
 * Spawn the ONE fallback thread, in the deepest BB project containing a scan
 * root, so it runs with THAT project's Linear MCP identity. Only tickets no key
 * covers are ever passed in; the caller guarantees it and this caps the count.
 */
export async function startLinearFetch(
  sdk: LinearFetchSdk,
  roots: readonly string[],
  tickets: readonly string[],
): Promise<{ ok: true; threadId: string; root: string; asked: string[] } | { ok: false; error: string }> {
  if (tickets.length === 0) return { ok: false, error: "Every ticket on the board already has Linear detail or is covered by a key." };
  const projects = await sdk.projects.list();
  for (const root of roots) {
    const project = projectForPath(projects, root);
    if (project === null) continue;
    const asked = tickets.slice(0, AGENT_FETCH_MAX);
    const thread = await sdk.threads.spawn({
      projectId: project.projectId,
      environment: { type: "host", hostId: project.hostId, workspace: { type: "unmanaged", path: root } },
      prompt: agentFetchPrompt(asked),
      pluginMetadata: { purpose: "linear-fetch" },
    });
    return { ok: true, threadId: thread.id, root, asked };
  }
  return { ok: false, error: "No BB project contains a scan root. Add a project whose folder holds the checkouts, then try again." };
}
