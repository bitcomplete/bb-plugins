// Linear: connect a developer's Linear account to this bb server once, and
// give every thread a few native tools that read and update issues as them.
//
// The connection is OAuth with PKCE (oauth.ts): Connect sends the browser to
// Linear, the callback below exchanges the code, and the access and refresh
// tokens land in secret settings. Every Linear call is made here on the
// server with that token; a thread sees results, never the token. Access
// tokens last a day, so each call refreshes first when one is about to
// expire, and once more on a 401.
//
// The same reads are a `bb linear` command, so a script automation on this
// server (which has no thread and therefore no tools) can poll Linear
// without a credential of its own.
//
// A thread can also watch an issue (watch.ts, hooks-client.ts): when the
// deployment runs bb-gate-hooks, Linear's webhooks reach it and it rings
// this plugin, which re-reads the issue as the developer and messages the
// thread with what changed. The thread ends its turn instead of polling.
//
// The stewards plugin reads Linear through this one too (source-contract.ts):
// snapshots, validation, adoption, and doorbells for the issues and teams it
// manages, forwarded as rings.
import { createHash } from "node:crypto";
import { PluginCliError, cliCommand, defineCli, defineRpcContract, type BbPluginApi, type JsonValue } from "@get-bb/plugin-sdk";
import type { Context } from "hono";
import { z } from "zod";
import {
  ADOPTABLE_QUERY,
  COMMENT_CREATE,
  ISSUE_CREATE,
  ISSUE_ID_QUERY,
  ISSUE_KEYS_QUERY,
  ISSUE_QUERY,
  ISSUE_REF_QUERY,
  ISSUE_UPDATE,
  ISSUES_QUERY,
  LinearRequestError,
  MY_TEAMS_QUERY,
  PRIORITIES,
  PRIORITY_NAMES,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_QUERY,
  SNAPSHOT_QUERY,
  TEAM_QUERY,
  TEAMS_QUERY,
  USERS_QUERY,
  VIEWER_QUERY,
  adoptableFilter,
  findLabels,
  findState,
  formatIssue,
  formatIssueList,
  graphql,
  graphqlErrors,
  isReadOnlyDocument,
  issueFilter,
  parseAdoptablePage,
  parseCommentCreate,
  parseIssue,
  parseIssueCreate,
  parseIssueId,
  parseIssueKeys,
  parseIssueList,
  parseIssueRef,
  parseIssueUpdate,
  parseSnapshotIssue,
  parseTeam,
  parseTeams,
  parseUsers,
  parseViewer,
  searchLimit,
  snapshotOfIssue,
  type Issue,
  type SearchInput,
  type Viewer,
} from "./linear.js";
import {
  authorizeUrl,
  exchangeCode,
  LINEAR_API_URL,
  LINEAR_URL,
  newPendingConnect,
  PENDING_TTL_MS,
  refreshTokens,
  revokeToken,
  type PendingConnect,
  type Tokens,
} from "./oauth.js";
import { createHooksLoop, HOOKS_URL_ENV, type Lease, type Rejection } from "./hooks-client.js";
import { ringStewards, sourceContract, STEWARDS_PLUGIN_ID, type AdoptableEntity } from "./source-contract.js";
import { CONNECTION_CHANGED, WATCHES_CHANGED } from "./channels.js";
import { buildUsage, createRefusals, formatUsage, usageViewSchema, type InterestView } from "./usage.js";
import { compare, createCheckQueue, createWatchStore, initialCursors, signed, snapshotOf, WATCH_MIGRATIONS, type WatchRow } from "./watch.js";

export const CALLBACK_PATH = "/connect/callback";
export { CONNECTION_CHANGED, WATCHES_CHANGED };
/**
 * The server's environment can carry the deployment's OAuth client ID, so a
 * fleet of servers behind one hostname shares one Linear application without
 * anyone typing it. A stored setting wins over it; an empty stored setting
 * falls back to it.
 */
export const ENV_CLIENT_ID = "LINEAR_CLIENT_ID";

/** A token this close to expiry is refreshed before it is used. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const userSchema = z.object({ id: z.string(), name: z.string(), email: z.string().nullable() });
const organizationSchema = z.object({ name: z.string(), urlKey: z.string() });

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      connected: z.boolean(),
      configured: z.boolean(),
      user: userSchema.nullable(),
      organization: organizationSchema.nullable(),
      linearUrl: z.string(),
    }),
  },
  connect: {
    input: z.null(),
    output: z.object({ url: z.string() }),
  },
  disconnect: {
    input: z.null(),
    output: z.object({ ok: z.boolean() }),
  },
  /** Every watch on this server and what the doorbell stream is doing. */
  watches: {
    input: z.null(),
    output: usageViewSchema,
  },
  /** Forget one watch; the thread is not told. */
  unwatch: {
    input: z.object({ threadId: z.string().min(1), targetId: z.string().min(1) }),
    output: z.object({ removed: z.boolean() }),
  },
  // sourceSnapshot, sourceValidate, sourceAdoptable, sourceSetInterest: what
  // stewards calls. The shapes are the shared file's, so they cannot drift
  // from what stewards and github expect.
  ...sourceContract,
});

export function settingDescriptors(env: Record<string, string | undefined>) {
  return {
    clientId: {
      type: "string",
      label: "OAuth client ID",
      description: `The Linear OAuth application this server connects through. Its redirect URI must be this server's callback; see the README. Unset, the server's ${ENV_CLIENT_ID} is used when the deployment sets one.`,
      default: env[ENV_CLIENT_ID]?.trim() ?? "",
    },
  linearUrl: {
    type: "string",
    label: "Linear address",
    description: "Where your browser approves the connection.",
    default: LINEAR_URL,
  },
  apiUrl: {
    type: "string",
    label: "Linear API",
    description: "Where tokens are exchanged and queries are sent.",
    default: LINEAR_API_URL,
  },
  accessToken: {
    type: "string",
    secret: true,
    label: "Access token",
    description: "Filled in by Connect Linear below, and refreshed by the plugin. Paste one only if you got it another way.",
  },
  refreshToken: {
    type: "string",
    secret: true,
    label: "Refresh token",
    description: "Filled in by Connect Linear below.",
  },
  } as const;
}

export interface LinearPluginDeps {
  fetch: typeof fetch;
  now: () => number;
  env: Record<string, string | undefined>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
}

function resultPage(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#222;background:#fafafa}@media (prefers-color-scheme:dark){body{color:#ddd;background:#161616}}main{max-width:32rem;padding:2rem;text-align:center}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

const NOT_CONNECTED = "Linear is not connected. Ask the user to open Settings → Plugins → Linear and choose Connect Linear.";

const issueKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9]*-\d+$/u, "an issue key such as ENG-123")
  .transform((s) => s.toUpperCase());

export function createLinearPlugin(deps: LinearPluginDeps): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const settings = bb.settings.define(settingDescriptors(deps.env));
    const clientIdOf = (cfg: { clientId: string }) => (cfg.clientId.trim() === "" ? (deps.env[ENV_CLIENT_ID]?.trim() ?? "") : cfg.clientId.trim());

    // ---- the connection ---------------------------------------------------

    const pendingKey = (state: string) => `connect/pending/${state}`;
    const CONNECTION_KEY = "connection";
    const EXPIRY_KEY = "expiresAt";
    const connectionRecord = z.object({ tokenFingerprint: z.string(), user: userSchema, organization: organizationSchema });

    function redirectUri(): string {
      const appUrl = bb.server.experimental_appUrl;
      if (appUrl === null) {
        throw new Error("This bb server has no public address (BB_APP_URL), so Linear cannot send you back to it.");
      }
      return new URL(`/api/v1/plugins/${bb.pluginId}/http${CALLBACK_PATH}`, appUrl).toString();
    }

    async function prunePending(): Promise<void> {
      const now = deps.now();
      for (const key of await bb.storage.kv.list("connect/pending/")) {
        const p = await bb.storage.kv.get<PendingConnect>(key);
        if (p === undefined || now - p.createdAt > PENDING_TTL_MS) await bb.storage.kv.delete(key);
      }
    }

    async function storeTokens(tokens: Tokens): Promise<void> {
      await settings.experimental_set({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      if (tokens.expiresAt === null) await bb.storage.kv.delete(EXPIRY_KEY);
      else await bb.storage.kv.set(EXPIRY_KEY, tokens.expiresAt);
    }

    // The developer the token belongs to. Asked of Linear once per token and
    // remembered by the token's fingerprint, so a pasted token is asked too.
    async function whoIs(accessToken: string, apiUrl: string, signal: AbortSignal): Promise<Viewer> {
      const fp = tokenFingerprint(accessToken);
      const stored = connectionRecord.safeParse(await bb.storage.kv.get(CONNECTION_KEY));
      if (stored.success && stored.data.tokenFingerprint === fp) return { user: stored.data.user, organization: stored.data.organization };
      const viewer = parseViewer(await graphql(apiUrl, accessToken, VIEWER_QUERY, undefined, deps.fetch, signal));
      await bb.storage.kv.set(CONNECTION_KEY, { tokenFingerprint: fp, ...viewer });
      return viewer;
    }

    // The settings section and the watch service both want to know when the
    // connection comes or goes. A pasted or cleared token changes it too, so
    // settings changes count alongside Connect and Disconnect.
    const connectionListeners = new Set<() => void>();
    function announceConnection(connected: boolean): void {
      bb.realtime.publish(CONNECTION_CHANGED, { connected });
      for (const listener of connectionListeners) listener();
    }
    settings.onChange((next, prev) => {
      if ((next.accessToken?.trim() ?? "") !== (prev.accessToken?.trim() ?? "")) for (const listener of connectionListeners) listener();
    });
    async function isConnected(): Promise<boolean> {
      return ((await settings.get()).accessToken?.trim() ?? "") !== "";
    }

    // One refresh at a time: two tools on the same expiring token must not
    // both refresh, or the second would hand Linear a refresh token the first
    // may already have rotated.
    let refreshing: Promise<string> | null = null;
    function refresh(reason: string): Promise<string> {
      if (refreshing !== null) return refreshing;
      refreshing = (async () => {
        const cfg = await settings.get();
        const refreshToken = cfg.refreshToken?.trim() ?? "";
        if (refreshToken === "") throw new Error(`The Linear token ${reason} and there is no refresh token. Connect Linear again.`);
        const tokens = await refreshTokens(cfg.apiUrl, clientIdOf(cfg), refreshToken, deps.fetch, AbortSignal.timeout(REQUEST_TIMEOUT_MS), deps.now());
        await storeTokens(tokens);
        // The developer is the same; carry the record to the new fingerprint.
        const stored = connectionRecord.safeParse(await bb.storage.kv.get(CONNECTION_KEY));
        if (stored.success) await bb.storage.kv.set(CONNECTION_KEY, { ...stored.data, tokenFingerprint: tokenFingerprint(tokens.accessToken) });
        bb.log.info(`Linear token refreshed (${reason})`);
        return tokens.accessToken;
      })().finally(() => {
        refreshing = null;
      });
      return refreshing;
    }

    /** A usable access token: refreshed first when it is about to expire. */
    async function accessToken(): Promise<string> {
      const cfg = await settings.get();
      const token = cfg.accessToken?.trim() ?? "";
      if (token === "") throw new Error(NOT_CONNECTED);
      const expiresAt = await bb.storage.kv.get<number>(EXPIRY_KEY);
      if (typeof expiresAt === "number" && expiresAt - deps.now() < REFRESH_MARGIN_MS && (cfg.refreshToken?.trim() ?? "") !== "") {
        return refresh("is about to expire");
      }
      return token;
    }

    /** A query as the developer, refreshing once if Linear says the token is gone. */
    async function query(document: string, variables: Record<string, unknown> | undefined, signal: AbortSignal): Promise<unknown> {
      const { apiUrl } = await settings.get();
      let token = await accessToken();
      try {
        return await graphql(apiUrl, token, document, variables, deps.fetch, signal);
      } catch (error) {
        if (!(error instanceof LinearRequestError) || error.status !== 401) throw error;
        token = await refresh("was refused");
        return graphql(apiUrl, token, document, variables, deps.fetch, signal);
      }
    }

    /** The connection as the settings section and `bb linear status` show it. */
    async function connectionStatus() {
      const cfg = await settings.get();
      const token = cfg.accessToken?.trim() ?? "";
      let user: Viewer["user"] | null = null;
      let organization: Viewer["organization"] | null = null;
      if (token !== "") {
        const stored = connectionRecord.safeParse(await bb.storage.kv.get(CONNECTION_KEY));
        if (stored.success && stored.data.tokenFingerprint === tokenFingerprint(token)) {
          user = stored.data.user;
          organization = stored.data.organization;
        }
      }
      return { connected: token !== "", configured: clientIdOf(cfg) !== "", user, organization, linearUrl: cfg.linearUrl };
    }

    bb.rpc.register(rpcContract, {
      status: connectionStatus,
      async connect() {
        const cfg = await settings.get();
        if (clientIdOf(cfg) === "") {
          throw new Error("No OAuth client ID is set. Open Settings → Plugins → Linear and enter the Linear OAuth application's client ID.");
        }
        await prunePending();
        const pending = newPendingConnect(redirectUri(), deps.now());
        await bb.storage.kv.set(pendingKey(pending.state), pending);
        return { url: authorizeUrl(cfg.linearUrl, clientIdOf(cfg), pending) };
      },
      async disconnect() {
        const cfg = await settings.get();
        const token = cfg.accessToken?.trim() ?? "";
        if (token !== "") {
          try {
            await revokeToken(cfg.apiUrl, token, deps.fetch, AbortSignal.timeout(10_000));
          } catch (error) {
            bb.log.warn(`could not revoke the Linear token: ${errorMessage(error)}`);
          }
        }
        await settings.experimental_set({ accessToken: null, refreshToken: null });
        await bb.storage.kv.delete(CONNECTION_KEY);
        await bb.storage.kv.delete(EXPIRY_KEY);
        announceConnection(false);
        return { ok: true };
      },
      watches: () => usage(),
      async unwatch({ threadId, targetId }) {
        const removed = watches.get(threadId, targetId) !== null;
        if (removed) {
          watches.remove(threadId, targetId);
          bb.log.info(`watch on ${targetId} by thread ${threadId} removed from settings`);
          announceWatches();
        }
        return { removed };
      },
      sourceSnapshot: ({ id }) => sourceSnapshot(id),
      sourceValidate: (input) => sourceValidate(input),
      sourceAdoptable: (input) => sourceAdoptable(input),
      async sourceSetInterest({ units, entities }, { experimental_caller: caller }) {
        // The interest decides what this server leases and whom it rings, so
        // only stewards itself may set it; the app and the CLI are clients.
        if (caller.kind !== "plugin" || caller.pluginId !== STEWARDS_PLUGIN_ID) throw new Error(`sourceSetInterest is for the ${STEWARDS_PLUGIN_ID} plugin only.`);
        await setInterest(units, entities);
        return { ok: true };
      },
    });

    // Linear sends the browser here after approval. "none" because the
    // request is a top-level navigation from Linear's origin; the state is
    // the credential: 256 random bits, single-use, and minted for this
    // server, so a forged or replayed callback finds nothing.
    bb.http.route(
      "GET",
      CALLBACK_PATH,
      async (c: Context) => {
        const state = c.req.query("state") ?? "";
        const pending = /^[A-Za-z0-9_-]{43}$/u.test(state) ? await bb.storage.kv.get<PendingConnect>(pendingKey(state)) : undefined;
        if (pending === undefined || deps.now() - pending.createdAt > PENDING_TTL_MS) {
          return resultPage("This link has expired", "Start again from Connect Linear in bb's settings.", 400);
        }
        await bb.storage.kv.delete(pendingKey(state));
        if (c.req.query("error") !== undefined) {
          return resultPage("Not connected", "Linear was not connected. You can close this tab.", 200);
        }
        const code = c.req.query("code") ?? "";
        const cfg = await settings.get();
        try {
          const tokens = await exchangeCode(cfg.apiUrl, clientIdOf(cfg), pending, code, deps.fetch, AbortSignal.timeout(15_000), deps.now());
          await storeTokens(tokens);
          await bb.storage.kv.delete(CONNECTION_KEY);
          const viewer = await whoIs(tokens.accessToken, cfg.apiUrl, AbortSignal.timeout(15_000));
          announceConnection(true);
          bb.log.info(`connected to Linear as ${viewer.user.name} in ${viewer.organization.name}`);
          return resultPage(
            "Linear connected",
            `bb threads can now read and update Linear issues in ${viewer.organization.name} as ${viewer.user.name}. You can close this tab.`,
            200,
          );
        } catch (error) {
          bb.log.warn(`Linear connect failed: ${errorMessage(error)}`);
          return resultPage("Not connected", `${errorMessage(error)}. Start again from bb's settings.`, 502);
        }
      },
      { auth: "none" },
    );

    // ---- the reads the tools and the CLI share -----------------------------

    const notFound = (key: string) => new Error(`No Linear issue ${key}, or it is not visible to the connected user.`);

    async function readIssue(key: string, signal: AbortSignal): Promise<Issue | null> {
      return parseIssue(await query(ISSUE_QUERY, { id: key }, signal));
    }

    async function searchIssues(input: SearchInput, signal: AbortSignal): Promise<{ issues: Issue[]; heading: string }> {
      const openOnly = input.openOnly ?? true;
      const filter = issueFilter({ ...input, openOnly });
      const first = searchLimit(input.limit);
      const term = input.query?.trim() ?? "";
      const issues =
        term === ""
          ? parseIssueList(await query(ISSUES_QUERY, { filter, first }, signal), "issues")
          : parseIssueList(await query(SEARCH_QUERY, { term, filter, first }, signal), "searchIssues");
      const what = [term === "" ? null : JSON.stringify(term), input.team ? `team ${input.team}` : null, input.state ? `state ${input.state}` : null, input.assignee ? `assignee ${input.assignee}` : null]
        .filter((s): s is string => s !== null)
        .join(", ");
      return { issues, heading: `Linear issues${what === "" ? "" : ` matching ${what}`}` };
    }

    /** A read-only document's data, with Linear's GraphQL errors alongside. */
    async function readOnlyQuery(document: string, variables: Record<string, unknown> | undefined, signal: AbortSignal): Promise<{ data: unknown; errors: string[] }> {
      if (!isReadOnlyDocument(document)) throw new Error("Only queries are allowed here. Use linear_create_issue, linear_comment or linear_update_issue to change issues.");
      const payload = await query(document, variables, signal);
      const errors = graphqlErrors(payload);
      const data = payload !== null && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
      if (data === undefined || data === null) throw new Error(errors.length > 0 ? `Linear: ${errors.join("; ")}` : "Linear answered without data");
      return { data, errors };
    }

    // ---- the tools --------------------------------------------------------

    const toolError = (error: unknown) => ({ content: [{ type: "text" as const, text: errorMessage(error) }], isError: true });

    // Comments and state changes name the thread that made them (watch.ts
    // `signature`) so a reader in Linear can find the conversation, and so a
    // watch can tell the thread's own comments from everyone else's.

    // "me" is the connected user. Anyone else is matched by exact name or
    // email first, then as the only partial match; several matches ask for
    // an email rather than guessing.
    async function resolveAssignee(who: string, signal: AbortSignal): Promise<{ id: string } | { error: string }> {
      if (who.toLowerCase() === "me") return { id: parseViewer(await query(VIEWER_QUERY, undefined, signal)).user.id };
      const users = parseUsers(await query(USERS_QUERY, { who }, signal)).filter((u) => u.active);
      const exact = users.filter((u) => u.name.toLowerCase() === who.toLowerCase() || u.email?.toLowerCase() === who.toLowerCase());
      const chosen = exact.length === 1 ? exact[0] : users.length === 1 ? users[0] : null;
      if (chosen === null) {
        return {
          error:
            users.length === 0
              ? `No Linear user matches ${JSON.stringify(who)}.`
              : `${JSON.stringify(who)} matches several Linear users: ${users.map((u) => (u.email === null ? u.name : `${u.name} <${u.email}>`)).join(", ")}. Give an email.`,
        };
      }
      return { id: chosen.id };
    }

    bb.agents.registerTool({
      name: "linear_issue",
      description:
        "Read one Linear issue by key (for example ENG-123): title, state, assignee, labels, project, parent and sub-issues, the description, and the latest comments.",
      instructions:
        "Linear is connected to this bb server as the user. Use linear_issue to read a ticket named in the task, a branch or a PR before working on it, and linear_search to find tickets; prefer them over asking the user to paste ticket contents. Use linear_create_issue when the user asks to file, create or open a ticket, and linear_update_issue to move, assign, relabel, reprioritize or rewrite the description of one. When nothing can be done until a ticket changes, linear_watch_issue and then ending the turn beats polling: the thread is messaged when it changes.",
      presentation: { label: { pending: "Reading a Linear issue", completed: "Read a Linear issue" } },
      parameters: z.object({ key: issueKey.describe("The issue key, such as ENG-123.") }),
      async execute({ key }, { signal }) {
        try {
          const issue = await readIssue(key, signal);
          return issue === null ? toolError(notFound(key)) : formatIssue(issue);
        } catch (error) {
          return toolError(error);
        }
      },
    });

    bb.agents.registerTool({
      name: "linear_search",
      description:
        "Find Linear issues. Give free text to search titles and descriptions, and/or narrow by team key, state name, or assignee ('me' for the connected user). Returns one line per issue, newest first.",
      presentation: { label: { pending: "Searching Linear", completed: "Searched Linear" } },
      parameters: z.object({
        query: z.string().trim().max(500).optional().describe("Free-text search over titles and descriptions."),
        team: z.string().trim().max(20).optional().describe("A team key such as ENG."),
        state: z.string().trim().max(60).optional().describe("A workflow state name such as In Progress."),
        assignee: z.string().trim().max(100).optional().describe("A person's name or email, or 'me'."),
        openOnly: z.boolean().optional().describe("Leave out completed and canceled issues. Default true unless a state is given."),
        limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional().describe("At most this many issues (default 20)."),
      }),
      async execute(input, { signal }) {
        try {
          const { issues, heading } = await searchIssues(input, signal);
          return formatIssueList(issues, heading);
        } catch (error) {
          return toolError(error);
        }
      },
    });

    bb.agents.registerTool({
      name: "linear_comment",
      description: "Add a comment to a Linear issue, as the connected user. Markdown is supported. The comment is signed with this thread's id; do not sign it yourself.",
      presentation: { label: { pending: "Commenting on a Linear issue", completed: "Commented on a Linear issue" } },
      parameters: z.object({
        key: issueKey.describe("The issue key, such as ENG-123."),
        body: z.string().trim().min(1).max(20_000).describe("The comment, in Markdown."),
      }),
      async execute({ key, body }, { threadId, signal }) {
        try {
          const ref = parseIssueRef(await query(ISSUE_REF_QUERY, { id: key }, signal));
          if (ref === null) return toolError(new Error(`No Linear issue ${key}, or it is not visible to the connected user.`));
          const created = parseCommentCreate(await query(COMMENT_CREATE, { input: { issueId: ref.id, body: signed(body, threadId) } }, signal));
          return `Commented on ${ref.identifier}${created.url === null ? "" : `: ${created.url}`}`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

    bb.agents.registerTool({
      name: "linear_update_issue",
      description:
        "Change a Linear issue: its workflow state (for example In Progress, Done), assignee ('me' for the connected user, a name or email, or 'nobody' to clear), labels to add or remove, priority, and description. Give only the fields to change; they are applied together. A new description replaces the whole old one and is signed with this thread's id (do not sign it yourself); read the issue first and keep what still holds. A state, label or person that does not match is an error that lists the choices.",
      presentation: { label: { pending: "Updating a Linear issue", completed: "Updated a Linear issue" } },
      parameters: z
        .object({
          key: issueKey.describe("The issue key, such as ENG-123."),
          state: z.string().trim().min(1).max(60).optional().describe("A workflow state name, matched ignoring case."),
          assignee: z.string().trim().min(1).max(100).optional().describe("A person's name or email, 'me' for the connected user, or 'nobody' to unassign."),
          addLabels: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe("Label names to add, matched ignoring case."),
          removeLabels: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe("Label names to remove, matched ignoring case."),
          priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional().describe("The priority."),
          description: z.string().trim().min(1).max(50_000).optional().describe("The whole new description, in Markdown. Replaces the old one."),
        })
        .refine(
          (v) => v.state !== undefined || v.assignee !== undefined || (v.addLabels?.length ?? 0) > 0 || (v.removeLabels?.length ?? 0) > 0 || v.priority !== undefined || v.description !== undefined,
          { message: "Give at least one of state, assignee, addLabels, removeLabels, priority or description." },
        ),
      async execute(input, { threadId, signal }) {
        try {
          const ref = parseIssueRef(await query(ISSUE_REF_QUERY, { id: input.key }, signal));
          if (ref === null) return toolError(new Error(`No Linear issue ${input.key}, or it is not visible to the connected user.`));
          const update: Record<string, unknown> = {};
          const changed: string[] = [];

          if (input.state !== undefined) {
            const target = findState(ref.team.states, input.state);
            if (target === null) {
              const names = [...ref.team.states].sort((a, b) => a.position - b.position).map((s) => `${s.name} (${s.type})`);
              return toolError(new Error(`Team ${ref.team.key} has no state named ${JSON.stringify(input.state)}. Its states: ${names.join(", ")}.`));
            }
            update.stateId = target.id;
          }

          if (input.assignee !== undefined) {
            if (input.assignee.toLowerCase() === "nobody") {
              update.assigneeId = null;
            } else {
              const resolved = await resolveAssignee(input.assignee, signal);
              if ("error" in resolved) return toolError(new Error(resolved.error));
              update.assigneeId = resolved.id;
            }
          }

          const adding = (input.addLabels ?? []).filter((l) => l !== "");
          const removing = (input.removeLabels ?? []).filter((l) => l !== "");
          if (adding.length > 0 || removing.length > 0) {
            const add = findLabels(ref.team.labels, adding);
            const remove = findLabels([...ref.labels, ...ref.team.labels], removing);
            const missing = [...add.missing, ...remove.missing];
            if (missing.length > 0) {
              const names = ref.team.labels.map((l) => l.name);
              return toolError(new Error(`No label named ${missing.map((m) => JSON.stringify(m)).join(", ")} for team ${ref.team.key}. Its labels: ${names.length > 0 ? names.join(", ") : "(none)"}.`));
            }
            const ids = ref.labels.map((l) => l.id).filter((id) => !remove.ids.includes(id));
            for (const id of add.ids) if (!ids.includes(id)) ids.push(id);
            update.labelIds = ids;
          }

          if (input.priority !== undefined) update.priority = PRIORITIES[input.priority];
          if (input.description !== undefined) update.description = signed(input.description, threadId);

          const updated = parseIssueUpdate(await query(ISSUE_UPDATE, { id: ref.id, input: update }, signal));
          if (input.state !== undefined) changed.push(`now ${updated.state ?? input.state}`);
          if (input.assignee !== undefined) changed.push(updated.assignee === null ? "unassigned" : `assigned to ${updated.assignee}`);
          if (update.labelIds !== undefined) changed.push(updated.labels.length === 0 ? "no labels" : `labels ${updated.labels.join(", ")}`);
          if (input.priority !== undefined) changed.push(`priority ${updated.priority === null ? input.priority : (PRIORITY_NAMES[updated.priority] ?? String(updated.priority))}`);
          if (input.description !== undefined) changed.push("description replaced");
          return `${updated.identifier}: ${changed.join("; ")}.`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

    bb.agents.registerTool({
      name: "linear_create_issue",
      description:
        "File a new Linear issue in a team, as the connected user. Give the team key and a title; optionally a Markdown description, a state name, an assignee ('me' for the connected user), label names, a priority, and a parent issue key. The description is signed with this thread's id; do not sign it yourself. Returns the new issue's key and URL.",
      presentation: { label: { pending: "Filing a Linear issue", completed: "Filed a Linear issue" } },
      parameters: z.object({
        team: z.string().trim().min(1).max(20).describe("The team key, such as ENG."),
        title: z.string().trim().min(1).max(500).describe("The issue's title."),
        description: z.string().trim().max(50_000).optional().describe("The issue's description, in Markdown."),
        state: z.string().trim().max(60).optional().describe("A workflow state name such as Backlog or Todo. The team's default when left out."),
        assignee: z.string().trim().max(100).optional().describe("A person's name or email, or 'me'."),
        labels: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe("Label names, matched ignoring case."),
        priority: z.enum(["none", "urgent", "high", "medium", "low"]).optional().describe("The priority."),
        parent: issueKey.optional().describe("The parent issue's key, to file this as a sub-issue."),
      }),
      async execute(input, { threadId, signal }) {
        try {
          const teamKey = input.team.trim().toUpperCase();
          const team = parseTeam(await query(TEAM_QUERY, { key: teamKey }, signal));
          if (team === null) return toolError(new Error(`No Linear team ${teamKey}, or it is not visible to the connected user.`));

          const create: Record<string, unknown> = { teamId: team.id, title: input.title.trim() };
          create.description = signed(input.description?.trim() ?? "", threadId);

          const state = input.state?.trim() ?? "";
          if (state !== "") {
            const target = findState(team.states, state);
            if (target === null) {
              const names = [...team.states].sort((a, b) => a.position - b.position).map((s) => `${s.name} (${s.type})`);
              return toolError(new Error(`Team ${team.key} has no state named ${JSON.stringify(state)}. Its states: ${names.join(", ")}.`));
            }
            create.stateId = target.id;
          }

          const labels = (input.labels ?? []).filter((l) => l.trim() !== "");
          if (labels.length > 0) {
            const found = findLabels(team.labels, labels);
            if (found.missing.length > 0) {
              const names = team.labels.map((l) => l.name);
              return toolError(new Error(`No label named ${found.missing.map((m) => JSON.stringify(m)).join(", ")} for team ${team.key}. Its labels: ${names.length > 0 ? names.join(", ") : "(none)"}.`));
            }
            create.labelIds = found.ids;
          }

          const assignee = input.assignee?.trim() ?? "";
          if (assignee !== "") {
            const resolved = await resolveAssignee(assignee, signal);
            if ("error" in resolved) return toolError(new Error(resolved.error));
            create.assigneeId = resolved.id;
          }

          if (input.priority !== undefined) create.priority = PRIORITIES[input.priority];

          if (input.parent !== undefined) {
            const parent = parseIssueRef(await query(ISSUE_REF_QUERY, { id: input.parent }, signal));
            if (parent === null) return toolError(new Error(`No Linear issue ${input.parent}, or it is not visible to the connected user.`));
            if (parent.team.key !== team.key) return toolError(new Error(`${parent.identifier} is in team ${parent.team.key}, so a sub-issue of it must be filed in ${parent.team.key}, not ${team.key}.`));
            create.parentId = parent.id;
          }

          const created = parseIssueCreate(await query(ISSUE_CREATE, { input: create }, signal));
          return `Filed ${created.identifier}: ${input.title.trim()}${created.url === null ? "" : `\n${created.url}`}`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

    bb.agents.registerTool({
      name: "linear_query",
      description:
        "Run a read-only GraphQL query against Linear's API as the connected user, for anything the other Linear tools do not cover (projects, cycles, teams, documents). Mutations are refused. Returns the JSON data.",
      presentation: { label: { pending: "Querying Linear", completed: "Queried Linear" } },
      parameters: z.object({
        query: z.string().trim().min(1).max(20_000).describe("A GraphQL query document."),
        variables: z.record(z.string(), z.unknown()).optional().describe("Variables for the query."),
      }),
      async execute({ query: document, variables }, { signal }) {
        try {
          const { data, errors } = await readOnlyQuery(document, variables, signal);
          const text = JSON.stringify(data, null, 1);
          return errors.length > 0 ? `${text}\n\nErrors: ${errors.join("; ")}` : text;
        } catch (error) {
          return toolError(error);
        }
      },
    });

    // ---- watching an issue -----------------------------------------------
    //
    // A watch is a row in the plugin's SQLite plus a lease on bb-gate-hooks.
    // The row is the truth: it carries what the thread last saw, and every
    // check compares a fresh read against it. The lease only makes the check
    // prompt. Without BB_HOOKS_URL there is no service to lease from and the
    // tool says so; a watch that merely polled would be a different feature.

    const hooksUrl = deps.env[HOOKS_URL_ENV]?.trim() ?? "";
    const db = bb.storage.database();
    bb.storage.migrate(db, WATCH_MIGRATIONS);
    const watches = createWatchStore(db, deps.now);
    const checkSignal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    /** The settings section re-reads the usage view on this. */
    const announceWatches = () => bb.realtime.publish(WATCHES_CHANGED, {});

    /** Message a thread. "gone" when the thread no longer exists, so the caller drops the watch. */
    async function wake(threadId: string, text: string): Promise<"sent" | "gone" | "failed"> {
      try {
        await bb.sdk.threads.send({ threadId, input: [{ type: "text", text, mentions: [] }], mode: "auto" });
        return "sent";
      } catch (error) {
        const e = error as { code?: string; status?: number };
        if (e.code === "NOT_FOUND" || e.status === 404 || e.status === 410) return "gone";
        bb.log.warn(`could not wake thread ${threadId} for a Linear change: ${errorMessage(error)}`);
        return "failed";
      }
    }

    /** The issue is gone or no longer readable as the developer: tell the thread once and forget the watch. */
    async function dropInvisible(watch: WatchRow): Promise<void> {
      watches.remove(watch.threadId, watch.issueId);
      announceWatches();
      await wake(watch.threadId, `Linear issue ${watch.issueKey} is no longer visible to the connected user (deleted, moved, or access removed), so this thread has stopped watching it.`);
    }

    /** Read the issue once and settle every watch on it against what it remembers. */
    async function checkIssue(issueId: string): Promise<void> {
      const watching = watches.forIssue(issueId);
      if (watching.length === 0) return;
      let issue: Issue | null;
      try {
        issue = await readIssue(issueId, checkSignal());
      } catch (error) {
        // Left as it was: the cursors still point at the last thing seen, so
        // the next doorbell or sweep reports everything since then.
        bb.log.warn(`could not read Linear issue ${watching[0]!.issueKey} for its watchers: ${errorMessage(error)}`);
        return;
      }
      for (const watch of watching) {
        if (issue === null) {
          await dropInvisible(watch);
          continue;
        }
        const outcome = compare(watch, issue);
        if (outcome.message === null) {
          watches.advance(watch.threadId, watch.issueId, outcome, false);
          continue;
        }
        const sent = await wake(watch.threadId, outcome.message);
        if (sent === "gone") watches.remove(watch.threadId, watch.issueId);
        else if (sent === "sent") watches.advance(watch.threadId, watch.issueId, outcome, true);
        if (sent !== "failed") announceWatches();
      }
    }

    const checks = createCheckQueue(checkIssue, { onError: (issueId, error) => bb.log.warn(`Linear watch check of ${issueId} failed: ${errorMessage(error)}`) });
    bb.onDispose(() => checks.stop());

    async function sweep(reason: string): Promise<void> {
      const expired = watches.expire();
      if (expired > 0) {
        bb.log.info(`forgot ${expired} Linear watch${expired === 1 ? "" : "es"} idle for a week`);
        announceWatches();
      }
      const ids = watches.issueIds();
      if (ids.length > 0) bb.log.info(`checking ${ids.length} watched Linear issue${ids.length === 1 ? "" : "s"} (${reason})`);
      await checks.sweep(ids);
    }

    // ---- stewards --------------------------------------------------------
    //
    // stewards (source-contract.ts) reads issues through the snapshot RPC and
    // says which teams and issues it manages through sourceSetInterest. The
    // interest is stored in kv so a restart leases it again without waiting
    // for stewards to repeat itself. Teams come as keys and are leased by
    // UUID, which is also what a doorbell's unit names; issues come as UUIDs
    // or keys, and keys are resolved with a read. Anything that cannot be
    // resolved yet (Linear not connected, or down) stays as given and is
    // tried again when the stream next connects or the interest next changes.

    const INTEREST_KEY = "stewards/interest";
    const TEAM_IDS_KEY = "stewards/teamIds";
    const interestRecord = z.object({ units: z.array(z.string()), entities: z.array(z.string()) });
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    /** Team keys, and issues as UUIDs or keys not yet resolved. */
    let interest = interestRecord.catch({ units: [], entities: [] }).parse(await bb.storage.kv.get(INTEREST_KEY));
    /** Team key to UUID, for every team the connected user could see when last asked. */
    let teamIds = z.record(z.string(), z.string()).catch({}).parse(await bb.storage.kv.get(TEAM_IDS_KEY));
    /** What a doorbell is matched against: issue UUIDs, and team UUIDs as a doorbell's unit names them. */
    let ringFor = { issues: new Set<string>(), teams: new Set<string>() };
    function recomputeRings(): void {
      ringFor = {
        issues: new Set(interest.entities.filter((e) => UUID.test(e))),
        teams: new Set(interest.units.map((key) => teamIds[key]).filter((id): id is string => id !== undefined)),
      };
    }
    recomputeRings();
    /** Issue UUID to key, for naming stewards' issues in the usage view; learned on resolution, asked for when missing. */
    const issueKeys = new Map<string, string>();
    /** Issue keys stewards asked about that the connected user cannot see, as of the last resolution. */
    let invisible: string[] = [];
    /** Stewards' leases bb-gate-hooks refused: `team:<uuid>` or an issue UUID. */
    const refusals = createRefusals(deps.now);

    /** Every lease the stream holds: watched issues, stewards' issues, stewards' teams. */
    function leases(): Lease[] {
      const issues = new Set([...watches.issueIds(), ...ringFor.issues]);
      return [...[...issues].map((id) => ({ kind: "issue" as const, id })), ...[...ringFor.teams].map((id) => ({ kind: "team" as const, id }))];
    }

    // The SDK's callRpc takes JSON input; ringStewards hands it the
    // contract's own input object, which is JSON by construction.
    const callRpc = <T>(args: { pluginId: string; method: string; input: unknown; outputSchema: z.ZodType<T> }) =>
      bb.sdk.plugins.callRpc<T>({ ...args, input: args.input as JsonValue });
    const warn = (message: string) => bb.log.warn(message);

    // Rings are debounced per issue like watch checks: Linear sends several
    // webhooks per edit, and stewards would only compare the same snapshot.
    const stewardRings = createCheckQueue((issueId) => ringStewards(callRpc, { source: "linear", id: issueId }, warn), {
      onError: (issueId, error) => bb.log.warn(`ringing stewards for Linear issue ${issueId} failed: ${errorMessage(error)}`),
    });
    bb.onDispose(() => stewardRings.stop());

    /** Linear says "Entity not found" for an id that names nothing, rather than a null issue. */
    const isNotFound = (error: unknown) => /entity not found|could not find/iu.test(errorMessage(error));

    async function refreshTeamIds(): Promise<Record<string, string>> {
      teamIds = Object.fromEntries(parseTeams(await query(TEAMS_QUERY, undefined, checkSignal())).map((t) => [t.key.toUpperCase(), t.id]));
      await bb.storage.kv.set(TEAM_IDS_KEY, teamIds);
      return teamIds;
    }

    /** The team map, asked of Linear again when one of these keys is missing from it: the team may be new. */
    async function teamIdsFor(keys: string[]): Promise<Record<string, string>> {
      return keys.some((k) => teamIds[k] === undefined) ? refreshTeamIds() : teamIds;
    }

    // One change to the interest at a time: a resolution finishing after a
    // newer set would otherwise write the older set back.
    let interestChain: Promise<void> = Promise.resolve();
    function serially(task: () => Promise<void>): Promise<void> {
      const next = interestChain.then(task, task);
      interestChain = next.catch(() => undefined);
      return next;
    }

    /** Resolve what can be resolved, store the result, and lease whatever is new right away. */
    async function resolveAndLease(why: string): Promise<void> {
      const before = ringFor;
      if (await isConnected()) {
        try {
          if (interest.units.length > 0) await teamIdsFor(interest.units);
        } catch (error) {
          bb.log.warn(`could not list Linear teams for stewards (${why}): ${errorMessage(error)}`);
        }
        const entities: string[] = [];
        invisible = [];
        for (const entity of interest.entities) {
          if (UUID.test(entity)) {
            entities.push(entity);
            continue;
          }
          try {
            const found = parseIssueId(await query(ISSUE_ID_QUERY, { id: entity }, checkSignal()));
            if (found === null) {
              bb.log.warn(`stewards asked about Linear issue ${entity}, which the connected user cannot see; leaving it out`);
              invisible.push(entity);
            } else {
              entities.push(found.id.toLowerCase());
              issueKeys.set(found.id.toLowerCase(), found.identifier);
            }
          } catch (error) {
            if (isNotFound(error)) {
              bb.log.warn(`stewards asked about Linear issue ${entity}, which the connected user cannot see; leaving it out`);
              invisible.push(entity);
              continue;
            }
            bb.log.warn(`could not resolve Linear issue ${entity} for stewards (${why}): ${errorMessage(error)}`);
            entities.push(entity);
          }
        }
        interest = { units: interest.units, entities: [...new Set(entities)] };
        await bb.storage.kv.set(INTEREST_KEY, interest);
      }
      recomputeRings();
      announceWatches();
      const issues = [...ringFor.issues].filter((id) => !before.issues.has(id));
      const teams = [...ringFor.teams].filter((id) => !before.teams.has(id));
      await Promise.all([
        hooks.added("issue", ...issues).catch((error: unknown) => bb.log.warn(`could not lease stewards' issues right away: ${errorMessage(error)}`)),
        hooks.added("team", ...teams).catch((error: unknown) => bb.log.warn(`could not lease stewards' teams right away: ${errorMessage(error)}`)),
      ]);
    }

    const resolveInterest = (why: string) =>
      serially(() => resolveAndLease(why)).catch((error: unknown) => bb.log.warn(`could not resolve stewards' interest (${why}): ${errorMessage(error)}`));

    /** Replace the interest. Leases for what it drops simply stop being renewed and lapse within the hour. */
    function setInterest(units: string[], entities: string[]): Promise<void> {
      return serially(async () => {
        interest = {
          units: [...new Set(units.map((u) => u.trim().toUpperCase()))],
          entities: [...new Set(entities.map((e) => e.trim()).map((e) => (UUID.test(e) ? e.toLowerCase() : e.toUpperCase())))],
        };
        await bb.storage.kv.set(INTEREST_KEY, interest);
        await resolveAndLease("interest changed");
      });
    }

    /** The connected user's name, for a snapshot's `viewer`; null when it cannot be learned. */
    async function viewerName(): Promise<string | null> {
      try {
        return (await whoIs(await accessToken(), (await settings.get()).apiUrl, checkSignal())).user.name;
      } catch (error) {
        bb.log.warn(`could not learn who Linear is connected as: ${errorMessage(error)}`);
        return null;
      }
    }

    async function sourceSnapshot(id: string) {
      let issue;
      try {
        issue = parseSnapshotIssue(await query(SNAPSHOT_QUERY, { id: id.trim() }, checkSignal()));
      } catch (error) {
        if (isNotFound(error)) return { snapshot: null };
        throw error;
      }
      return { snapshot: issue === null ? null : snapshotOfIssue(issue, await viewerName()) };
    }

    // Validation answers rather than throws: `bb stewards check` reports a
    // disconnected Linear as one line, beside whatever github says.
    async function sourceValidate(input: { units: string[]; label: string; states: string[] }) {
      if (!(await isConnected())) return { viewer: null, units: [], mine: [], error: NOT_CONNECTED };
      try {
        const viewer = await viewerName();
        const mine = parseTeams(await query(MY_TEAMS_QUERY, undefined, checkSignal())).map((t) => ({ unit: t.key, name: t.name }));
        const units = [];
        for (const unit of input.units) {
          const team = parseTeam(await query(TEAM_QUERY, { key: unit.trim().toUpperCase() }, checkSignal()));
          units.push(
            team === null
              ? { unit, found: false, labelFound: false, missingStates: [] }
              : { unit, found: true, labelFound: findLabels(team.labels, [input.label]).missing.length === 0, missingStates: input.states.filter((s) => findState(team.states, s) === null) },
          );
        }
        return { viewer, units, mine, error: null };
      } catch (error) {
        return { viewer: null, units: [], mine: [], error: errorMessage(error) };
      }
    }

    /** At most this many labelled open issues are read per team, a page at a time. */
    const ADOPTABLE_PAGE = 250;
    const ADOPTABLE_PAGES_MAX = 4;

    // Each team is asked on its own so one failing team costs only its own
    // issues. Linear's order is not the one wanted, so the pages are sorted
    // here: oldest first, which is the order a capped nightly pass adopts in.
    async function sourceAdoptable(input: { units: string[]; label: string; limit: number }) {
      if (!(await isConnected())) return { viewer: null, entities: [], errors: [NOT_CONNECTED] };
      const viewer = await viewerName();
      const keys = [...new Set(input.units.map((u) => u.trim().toUpperCase()))];
      const entities: AdoptableEntity[] = [];
      const errors: string[] = [];
      let known: Record<string, string> | null = null;
      try {
        known = await teamIdsFor(keys);
      } catch (error) {
        errors.push(`Linear teams: ${errorMessage(error)}`);
      }
      for (const key of keys) {
        if (known !== null && known[key] === undefined) {
          errors.push(`${key}: no such Linear team, or it is not visible to the connected user`);
          continue;
        }
        try {
          let after: string | null = null;
          let pages = 0;
          do {
            const page = parseAdoptablePage(await query(ADOPTABLE_QUERY, { filter: adoptableFilter(key, input.label), first: ADOPTABLE_PAGE, after }, checkSignal()));
            entities.push(...page.entities);
            after = page.next;
          } while (after !== null && ++pages < ADOPTABLE_PAGES_MAX);
          if (after !== null) errors.push(`${key}: more than ${ADOPTABLE_PAGE * ADOPTABLE_PAGES_MAX} open issues carry ${input.label}; only those were read`);
        } catch (error) {
          errors.push(`${key}: ${errorMessage(error)}`);
        }
      }
      entities.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      return { viewer, entities: entities.slice(0, input.limit), errors };
    }

    // ---- the doorbell stream ---------------------------------------------
    //
    // The service refusing a lease is not proof the developer lost access:
    // with the token expired on the service's side, or Linear briefly down,
    // every watch would come back `forbidden`. The developer's own read is
    // the ground truth, so a refused issue is read here before the thread is
    // told it is gone; one that reads fine keeps its watch and is leased
    // again at the next renewal.
    //
    // A refused team lease only costs stewards its early rings for that
    // team's issues: each bound issue holds its own lease, and the nightly
    // pass re-lists the rest. It is logged and left to the next renewal.
    async function onRejected(rejected: Rejection[]): Promise<void> {
      for (const r of rejected) {
        if (r.kind === "team") {
          refusals.add(`team:${r.id}`, r.reason);
          const key = Object.entries(teamIds).find(([, id]) => id === r.id)?.[0] ?? r.id;
          bb.log.warn(`bb-gate-hooks refused a lease on Linear team ${key} (${r.reason}); stewards hears of its issues only through their own leases until a renewal succeeds`);
          continue;
        }
        if (r.kind === "issue" && ringFor.issues.has(r.id)) refusals.add(r.id, r.reason);
        if (r.kind !== "issue" || r.reason !== "forbidden") continue;
        const watching = watches.forIssue(r.id);
        if (watching.length === 0) continue;
        try {
          if ((await readIssue(r.id, checkSignal())) !== null) {
            bb.log.warn(`bb-gate-hooks refused a lease on ${watching[0]!.issueKey} that the connected user can read; keeping the watch`);
            continue;
          }
        } catch (error) {
          bb.log.warn(`could not confirm a refused lease on ${watching[0]!.issueKey}: ${errorMessage(error)}`);
          continue;
        }
        for (const watch of watching) await dropInvisible(watch);
      }
    }

    const hooks = createHooksLoop({
      fetch: deps.fetch,
      baseUrl: hooksUrl,
      now: deps.now,
      log: bb.log,
      token: accessToken,
      refreshToken: () => refresh("was refused by bb-gate-hooks"),
      leases,
      // A watch check reads the issue only when a thread watches it, so every
      // doorbell goes to it; stewards hears of the ones it asked about.
      onDoorbell: (issueId, unit) => {
        checks.ring(issueId);
        if (ringFor.issues.has(issueId) || (unit !== null && ringFor.teams.has(unit))) stewardRings.ring(issueId);
      },
      onRejected,
      sweep,
    });
    hooks.onStateChange(announceWatches);

    /**
     * The usage view: every watch with its counters, flags and thread title,
     * and the doorbell stream's state. Titles come from bb per thread; a
     * thread that cannot be read shows its id.
     */
    async function usage() {
      const rows = watches.all();
      const status = await connectionStatus();
      const base = status.organization === null ? null : `${status.linearUrl.replace(/\/$/u, "")}/${status.organization.urlKey}/issue/`;
      const titles = new Map<string, string | null>();
      await Promise.all(
        [...new Set(rows.map((r) => r.threadId))].map(async (threadId) => {
          try {
            const thread = (await bb.sdk.threads.get({ threadId })) as { title?: string | null; titleFallback?: string | null };
            titles.set(threadId, thread.title ?? thread.titleFallback ?? null);
          } catch {
            titles.set(threadId, null);
          }
        }),
      );
      return buildUsage({
        rows,
        hooks: hooks.status(),
        configured: hooksUrl !== "",
        now: deps.now(),
        titles,
        target: (row) => ({ id: row.issueId, key: row.issueKey, kind: "issue", title: row.snapshot.title, url: base === null ? null : `${base}${row.issueKey}` }),
        interest: await interestView(status.connected, base),
      });
    }

    /**
     * Stewards' interest as a person reads it: team keys, issue keys, and
     * what is asked for but not leased. Keys missing from the cache are
     * asked of Linear in one query; an issue Linear cannot name shows its UUID.
     */
    async function interestView(connected: boolean, base: string | null): Promise<InterestView> {
      for (const row of watches.all()) issueKeys.set(row.issueId, row.issueKey);
      const uuids = interest.entities.filter((e) => UUID.test(e));
      const missing = uuids.filter((id) => !issueKeys.has(id));
      if (connected && missing.length > 0) {
        try {
          for (let i = 0; i < missing.length; i += 250) {
            for (const found of parseIssueKeys(await query(ISSUE_KEYS_QUERY, { ids: missing.slice(i, i + 250) }, checkSignal()))) issueKeys.set(found.id.toLowerCase(), found.identifier);
          }
        } catch (error) {
          bb.log.warn(`could not name stewards' Linear issues: ${errorMessage(error)}`);
        }
      }
      const keyOf = (id: string) => issueKeys.get(id) ?? id;
      const teamKeyOf = (id: string) => Object.entries(teamIds).find(([, t]) => t === id)?.[0] ?? id;
      const unleased: InterestView["unleased"] = [];
      for (const unit of interest.units) if (teamIds[unit] === undefined) unleased.push({ key: unit, reason: "no such team, or not visible to the connected Linear user" });
      for (const entity of interest.entities) if (!UUID.test(entity)) unleased.push({ key: entity, reason: "not resolved to a Linear issue yet" });
      for (const key of invisible) unleased.push({ key, reason: "not visible to the connected Linear user" });
      for (const [id, reason] of refusals.current()) {
        if (id.startsWith("team:")) {
          if (ringFor.teams.has(id.slice(5))) unleased.push({ key: teamKeyOf(id.slice(5)), reason: `refused by bb-gate-hooks (${reason})` });
        } else if (ringFor.issues.has(id)) unleased.push({ key: keyOf(id), reason: `refused by bb-gate-hooks (${reason})` });
      }
      return {
        nouns: { unit: ["team", "teams"], entity: ["issue", "issues"] },
        units: interest.units,
        entities: uuids.map((id) => ({ key: keyOf(id), url: base === null || !issueKeys.has(id) ? null : `${base}${keyOf(id)}` })).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })),
        unleased,
      };
    }

    if (hooksUrl !== "") {
      // Runs the stream only while Linear is connected: a lease is proven
      // with the token, so without one there is nothing to subscribe with.
      // Disconnect stops the stream; Connect starts it again.
      bb.background.service("watches", {
        async start(signal) {
          while (!signal.aborted) {
            // Listen before looking, so a change between the two is not missed.
            let changed!: () => void;
            const change = new Promise<void>((resolve) => {
              changed = () => {
                connectionListeners.delete(changed);
                signal.removeEventListener("abort", changed);
                resolve();
              };
              connectionListeners.add(changed);
              signal.addEventListener("abort", changed, { once: true });
            });
            if (!(await isConnected())) {
              await change;
              continue;
            }
            changed();
            const session = new AbortController();
            const stop = () => session.abort();
            signal.addEventListener("abort", stop, { once: true });
            const onChange = () => void isConnected().then((connected) => (connected ? undefined : session.abort()));
            connectionListeners.add(onChange);
            // Interest stored while Linear was disconnected, or before a
            // restart, may still name keys; resolve them now there is a token.
            void resolveInterest("connected");
            try {
              await hooks.run(session.signal);
            } finally {
              connectionListeners.delete(onChange);
              signal.removeEventListener("abort", stop);
            }
          }
        },
      });
    }

    const forgetThread = (threadId: string) => {
      const removed = watches.removeThread(threadId);
      if (removed > 0) {
        bb.log.info(`thread ${threadId} is gone; forgot its ${removed} Linear watch${removed === 1 ? "" : "es"}`);
        announceWatches();
      }
    };
    bb.events.on("thread.archived", ({ thread }) => forgetThread(thread.id));
    bb.events.on("thread.deleted", ({ thread }) => forgetThread(thread.id));

    bb.agents.registerTool({
      name: "linear_watch_issue",
      description:
        "Watch a Linear issue from this thread: when its state, assignee, priority, labels, title or other fields change, or someone else comments, this thread is sent a message describing the change (which starts a new turn if the thread is idle). Use it when there is nothing to do until the ticket moves, then end the turn instead of polling. A thread can watch up to 10 issues; a watch nobody has woken in a week is dropped.",
      presentation: { label: { pending: "Watching a Linear issue", completed: "Watching a Linear issue" } },
      parameters: z.object({ key: issueKey.describe("The issue key, such as ENG-123.") }),
      async execute({ key }, { threadId, projectId, signal }) {
        if (hooksUrl === "") {
          return toolError(new Error("Watching Linear issues is not available on this bb server: it has no bb-gate-hooks service (BB_HOOKS_URL is not set). Read the issue again later instead."));
        }
        try {
          const issue = await readIssue(key, signal);
          if (issue === null) return toolError(notFound(key));
          const added = watches.add({
            threadId,
            projectId,
            issueId: issue.id,
            issueKey: issue.identifier,
            snapshot: snapshotOf(issue),
            ...initialCursors(issue, new Date(deps.now()).toISOString()),
          });
          const title = issue.title ?? "(untitled)";
          if (added.outcome === "full") {
            return toolError(new Error(`This thread already watches ${added.limit} Linear issues, the most it can. It is still watching them; it cannot add ${issue.identifier}.`));
          }
          if (added.outcome === "already") return `Already watching ${issue.identifier}: ${title}. This thread will be messaged when it changes; you can end the turn.`;
          // Not awaited: the lease lands within seconds when the stream is up,
          // and the next hello covers it when it is not. The tool need not wait.
          hooks.added("issue", issue.id).catch((error: unknown) => bb.log.warn(`could not lease ${issue.identifier} right away: ${errorMessage(error)}`));
          announceWatches();
          return `Watching ${issue.identifier}: ${title}. This thread will be messaged when its fields change or someone else comments; end the turn rather than polling.`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

    // ---- the CLI ----------------------------------------------------------
    //
    // `bb linear …` runs here on the server, as the connected user, with the
    // same reads as the tools. It exists for script automations: they run on
    // the server with `bb` on their PATH and no thread, so this is how a
    // cron script asks "which issues are build-ready?" without a token of
    // its own. The token never appears in its output.

    const cliSignal = (ctx: { signal?: AbortSignal }) => (ctx.signal === undefined ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
    const cliError = (error: unknown): never => {
      const message = errorMessage(error);
      throw new PluginCliError(message, {
        code: message.startsWith("Linear is not connected") ? "not_connected" : error instanceof LinearRequestError ? "linear_request_failed" : "linear_error",
        ...(message.startsWith("Linear is not connected") ? { hint: "Connect Linear in Settings → Plugins → Linear, then run this again." } : {}),
      });
    };
    const parseVariables = (raw: string | undefined): Record<string, unknown> | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new PluginCliError("--variables must be a JSON object.", { code: "invalid_variables", hint: 'For example --variables \'{"first": 10}\'.' });
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new PluginCliError("--variables must be a JSON object.", { code: "invalid_variables", hint: 'For example --variables \'{"first": 10}\'.' });
      }
      return parsed as Record<string, unknown>;
    };
    const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;

    bb.cli.register(
      defineCli({
        name: "linear",
        summary: "Read Linear issues as the connected user, from scripts and automations",
        description:
          "Runs on the bb server with the Linear connection made in Settings → Plugins → Linear. Reads only; " +
          "the token never appears in output. Made for script automations, which have no thread and no tools.",
        commands: {
          status: cliCommand({
            summary: "Who Linear is connected as on this server",
            options: { json: JSON_OPTION },
            async run(input) {
              const status = await connectionStatus();
              if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(status) };
              if (!status.connected) return { exitCode: 0, stdout: status.configured ? "Linear is not connected." : "Linear is not connected, and no OAuth client ID is set." };
              const who = status.user === null ? "an unknown user" : status.user.name;
              return { exitCode: 0, stdout: `Connected to Linear as ${who}${status.organization === null ? "" : ` in ${status.organization.name}`}.` };
            },
          }),

          watches: cliCommand({
            summary: "Every watch on this server, how busy each has been, what stewards has leased, and the doorbell stream's state",
            description:
              "The same view as Settings → Plugins → Linear → Watches. Flags: idle (old and not woken in days), noisy (woken often in the last hour), expiring (forgotten within a day unless something happens). With --json the output is the full view object.",
            options: { json: JSON_OPTION },
            async run(input) {
              const view = await usage();
              return { exitCode: 0, stdout: input.options.json ? JSON.stringify(view) : formatUsage(view) };
            },
          }),

          issue: cliCommand({
            summary: "Read one issue by key, with its description and latest comments",
            positionals: [{ name: "key", description: "The issue key, such as ENG-123", required: true }],
            options: { json: JSON_OPTION },
            async run(input, ctx) {
              const key = issueKey.safeParse(input.positionals.key);
              if (!key.success) throw new PluginCliError(`${JSON.stringify(input.positionals.key)} is not an issue key.`, { code: "invalid_issue_key", hint: "Pass a key such as ENG-123." });
              const issue = await readIssue(key.data, cliSignal(ctx)).catch(cliError);
              if (issue === null) throw new PluginCliError(notFound(key.data).message, { code: "issue_not_found" });
              return { exitCode: 0, stdout: input.options.json ? JSON.stringify(issue) : formatIssue(issue) };
            },
          }),

          search: cliCommand({
            summary: "List issues by free text, team, state, or assignee; newest first",
            description: "Without --state, completed and canceled issues are left out unless --all is given. With --json the output is a JSON array of issues, one object per issue with id, identifier, title, state, team, assignee, labels, url and timestamps.",
            options: {
              query: { type: "string", description: "Free text searched in titles and descriptions (at most 500 characters)", aliases: ["q", "text"] },
              team: { type: "string", description: "A team key such as ENG" },
              state: { type: "string", description: "A workflow state name such as Build Ready, matched ignoring case", aliases: ["status"] },
              assignee: { type: "string", description: "A person's name or email, or 'me' for the connected user" },
              all: { type: "boolean", description: "Include completed and canceled issues (default when --state is given)", aliases: ["include-closed"] },
              limit: { type: "integer", min: 1, max: SEARCH_LIMIT_MAX, default: SEARCH_LIMIT_DEFAULT, description: `At most this many issues (1 to ${SEARCH_LIMIT_MAX})` },
              json: JSON_OPTION,
            },
            async run(input, ctx) {
              const o = input.options;
              if (o.query !== undefined && o.query.length > 500) throw new PluginCliError("--query is at most 500 characters.", { code: "invalid_query" });
              const search: SearchInput = {
                ...(o.query === undefined ? {} : { query: o.query }),
                ...(o.team === undefined ? {} : { team: o.team }),
                ...(o.state === undefined ? {} : { state: o.state }),
                ...(o.assignee === undefined ? {} : { assignee: o.assignee }),
                openOnly: !o.all,
                limit: o.limit,
              };
              const { issues, heading } = await searchIssues(search, cliSignal(ctx)).catch(cliError);
              return { exitCode: 0, stdout: o.json ? JSON.stringify(issues) : formatIssueList(issues, heading) };
            },
          }),

          query: cliCommand({
            summary: "Run a read-only GraphQL query and print its data as JSON",
            description: "Mutations are refused. The output is the query's `data` object; Linear's GraphQL errors, if any, go to stderr.",
            positionals: [{ name: "document", description: "A GraphQL query document", required: true }],
            options: {
              variables: { type: "string", description: "Variables for the query, as a JSON object", aliases: ["vars"] },
              json: JSON_OPTION,
            },
            async run(input, ctx) {
              const document = input.positionals.document;
              if (document.trim() === "" || document.length > 20_000) throw new PluginCliError("The document must be 1 to 20000 characters.", { code: "invalid_document" });
              const variables = parseVariables(input.options.variables);
              const { data, errors } = await readOnlyQuery(document, variables, cliSignal(ctx)).catch(cliError);
              return { exitCode: 0, stdout: JSON.stringify(data), ...(errors.length > 0 ? { stderr: `Linear: ${errors.join("; ")}` } : {}) };
            },
          }),
        },
      }),
    );
  };
}

export default createLinearPlugin({ fetch: (url, init) => fetch(url, init), now: () => Date.now(), env: process.env });
