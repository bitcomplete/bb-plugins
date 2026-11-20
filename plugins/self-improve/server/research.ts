import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../src/store.js";
import type { Config } from "../src/config.js";
import { DairClient } from "../src/adapters/research.js";
import type { Paper } from "../src/adapters/types.js";

const paperSchema = z.object({ id: z.string(), version: z.string(), title: z.string(), abstract: z.string(), authors: z.array(z.string()), publishedAt: z.string(), updatedAt: z.string(), url: z.string().url(), source: z.literal("dair"), fwci: z.number().nonnegative().nullable(), authorSignal: z.number().nonnegative().nullable(), retrievedAt: z.string(), credibilityEvidenceUrls: z.array(z.string().url()).optional() });

/** Papers from a DAIR MCP tool result: at `path` when configured, otherwise its structured content or single JSON text block. */
function parsePapers(result: unknown, path?: string[]): Paper[] {
  let data = result;
  if (path) { for (const key of path) data = data && typeof data === "object" ? Object.hasOwn(data, key) ? (data as Record<string, unknown>)[key] : undefined : undefined; }
  else if (data && typeof data === "object" && !Array.isArray(data)) {
    const envelope = data as Record<string, unknown>;
    if (envelope.structuredContent !== undefined) data = envelope.structuredContent;
    else if (Array.isArray(envelope.content)) {
      const blocks = envelope.content.filter((b): b is { type: "text"; text: string } => !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string");
      if (blocks.length !== 1) throw new Error("DAIR requires a structured result mapping"); data = JSON.parse(blocks[0]!.text);
    }
  }
  return z.array(paperSchema).max(100).parse(data);
}

/** DAIR research access for the scout. Each request is recorded in access-costs; there is no per-request price. */
export function createResearch(options: { store: Store; config: () => Config; token: () => string | undefined; signal: AbortSignal }) {
  let client: DairClient | null = null;
  const getClient = () => client ??= new DairClient({ token: options.token(), url: options.config().dair.endpoint, onRequest: async (method, status) => {
    options.store.put("access-costs", randomUUID(), { service: "dair", method, status, atMs: Date.now(), basis: "unknown", amountMicros: null, note: "Research access and infrastructure are not invoiced automatically" });
  } });
  return {
    /** Paper search, when a token and search tool are configured. */
    dair: () => {
      const dair = options.config().dair;
      if (!options.token() || !dair.searchTool || !dair.queryArgument) return undefined;
      const current = getClient();
      return { search: async (query: string, searchOptions?: { signal?: AbortSignal }): Promise<Paper[]> => {
        const latest = options.config().dair;
        return parsePapers(await current.callTool(latest.searchTool!, { [latest.queryArgument!]: query }, searchOptions?.signal), latest.resultsPath);
      } };
    },
    weeklyIssue: async (): Promise<Paper[]> => {
      const dair = options.config().dair;
      if (!options.token() || !dair.weeklyTool) throw new Error("DAIR weekly tool is not configured");
      return parsePapers(await getClient().callTool(dair.weeklyTool, dair.weeklyArguments ?? {}, options.signal), dair.weeklyResultsPath);
    },
    /** The configured DAIR tools, for `bb self-improve doctor --research-tools`. */
    tools: () => getClient().tools(options.signal),
    /** Drops the client so the next request uses the current token and endpoint. */
    reset: () => { client = null; },
  };
}
