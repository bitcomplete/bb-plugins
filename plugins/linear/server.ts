// Linear: connect a developer's Linear account to this bb server once, and
// give every thread a few native tools that read and update issues as them.
//
// The connection is OAuth with PKCE (oauth.ts): Connect sends the browser to
// Linear, the callback below exchanges the code, and the access and refresh
// tokens land in secret settings. Every Linear call is made here on the
// server with that token; a thread sees results, never the token. Access
// tokens last a day, so each call refreshes first when one is about to
// expire, and once more on a 401.
import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { Context } from "hono";
import { z } from "zod";
import {
  COMMENT_CREATE,
  ISSUE_CREATE,
  ISSUE_QUERY,
  ISSUE_REF_QUERY,
  ISSUE_UPDATE,
  ISSUES_QUERY,
  LinearRequestError,
  PRIORITIES,
  SEARCH_LIMIT_MAX,
  SEARCH_QUERY,
  TEAM_QUERY,
  USERS_QUERY,
  VIEWER_QUERY,
  findLabels,
  findState,
  formatIssue,
  formatIssueList,
  graphql,
  graphqlErrors,
  isReadOnlyDocument,
  issueFilter,
  parseCommentCreate,
  parseIssue,
  parseIssueCreate,
  parseIssueList,
  parseIssueRef,
  parseIssueUpdate,
  parseTeam,
  parseUsers,
  parseViewer,
  searchLimit,
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

export const CALLBACK_PATH = "/connect/callback";
export const CONNECTION_CHANGED = "connection-changed";
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

    bb.rpc.register(rpcContract, {
      async status() {
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
      },
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
        bb.realtime.publish(CONNECTION_CHANGED, { connected: false });
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
          bb.realtime.publish(CONNECTION_CHANGED, { connected: true });
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

    // ---- the tools --------------------------------------------------------

    const toolError = (error: unknown) => ({ content: [{ type: "text" as const, text: errorMessage(error) }], isError: true });

    // Comments and state changes name the thread that made them so a
    // reader in Linear can find the conversation.
    const signature = (threadId: string) => `\n\n_— from bb thread ${threadId}_`;

    bb.agents.registerTool({
      name: "linear_issue",
      description:
        "Read one Linear issue by key (for example ENG-123): title, state, assignee, labels, project, parent and sub-issues, the description, and the latest comments.",
      instructions:
        "Linear is connected to this bb server as the user. Use linear_issue to read a ticket named in the task, a branch or a PR before working on it, and linear_search to find tickets; prefer them over asking the user to paste ticket contents. Use linear_create_issue when the user asks to file, create or open a ticket.",
      presentation: { label: { pending: "Reading a Linear issue", completed: "Read a Linear issue" } },
      parameters: z.object({ key: issueKey.describe("The issue key, such as ENG-123.") }),
      async execute({ key }, { signal }) {
        try {
          const issue = parseIssue(await query(ISSUE_QUERY, { id: key }, signal));
          return issue === null ? toolError(new Error(`No Linear issue ${key}, or it is not visible to the connected user.`)) : formatIssue(issue);
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
          return formatIssueList(issues, `Linear issues${what === "" ? "" : ` matching ${what}`}`);
        } catch (error) {
          return toolError(error);
        }
      },
    });

    bb.agents.registerTool({
      name: "linear_comment",
      description: "Add a comment to a Linear issue, as the connected user. Markdown is supported. The comment is signed with this thread's id.",
      presentation: { label: { pending: "Commenting on a Linear issue", completed: "Commented on a Linear issue" } },
      parameters: z.object({
        key: issueKey.describe("The issue key, such as ENG-123."),
        body: z.string().trim().min(1).max(20_000).describe("The comment, in Markdown."),
      }),
      async execute({ key, body }, { threadId, signal }) {
        try {
          const ref = parseIssueRef(await query(ISSUE_REF_QUERY, { id: key }, signal));
          if (ref === null) return toolError(new Error(`No Linear issue ${key}, or it is not visible to the connected user.`));
          const created = parseCommentCreate(await query(COMMENT_CREATE, { input: { issueId: ref.id, body: body + signature(threadId) } }, signal));
          return `Commented on ${ref.identifier}${created.url === null ? "" : `: ${created.url}`}`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

    bb.agents.registerTool({
      name: "linear_set_state",
      description: "Move a Linear issue to a workflow state by name (for example In Progress, In Review, Done). The names a team uses are listed when the name does not match.",
      presentation: { label: { pending: "Moving a Linear issue", completed: "Moved a Linear issue" } },
      parameters: z.object({
        key: issueKey.describe("The issue key, such as ENG-123."),
        state: z.string().trim().min(1).max(60).describe("The state's name, matched ignoring case."),
      }),
      async execute({ key, state }, { signal }) {
        try {
          const ref = parseIssueRef(await query(ISSUE_REF_QUERY, { id: key }, signal));
          if (ref === null) return toolError(new Error(`No Linear issue ${key}, or it is not visible to the connected user.`));
          const target = findState(ref.team.states, state);
          if (target === null) {
            const names = [...ref.team.states].sort((a, b) => a.position - b.position).map((s) => `${s.name} (${s.type})`);
            return toolError(new Error(`Team ${ref.team.key} has no state named ${JSON.stringify(state)}. Its states: ${names.join(", ")}.`));
          }
          const updated = parseIssueUpdate(await query(ISSUE_UPDATE, { id: ref.id, input: { stateId: target.id } }, signal));
          return `${updated.identifier} is now ${updated.state ?? target.name}.`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

    bb.agents.registerTool({
      name: "linear_create_issue",
      description:
        "File a new Linear issue in a team, as the connected user. Give the team key and a title; optionally a Markdown description, a state name, an assignee ('me' for the connected user), label names, a priority, and a parent issue key. The description is signed with this thread's id. Returns the new issue's key and URL.",
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
          const description = input.description?.trim() ?? "";
          create.description = description === "" ? signature(threadId).trimStart() : description + signature(threadId);

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
            if (assignee.toLowerCase() === "me") {
              create.assigneeId = parseViewer(await query(VIEWER_QUERY, undefined, signal)).user.id;
            } else {
              const users = parseUsers(await query(USERS_QUERY, { who: assignee }, signal)).filter((u) => u.active);
              const exact = users.filter((u) => u.name.toLowerCase() === assignee.toLowerCase() || u.email?.toLowerCase() === assignee.toLowerCase());
              const chosen = exact.length === 1 ? exact[0] : users.length === 1 ? users[0] : null;
              if (chosen === null) {
                return toolError(
                  new Error(
                    users.length === 0
                      ? `No Linear user matches ${JSON.stringify(assignee)}.`
                      : `${JSON.stringify(assignee)} matches several Linear users: ${users.map((u) => (u.email === null ? u.name : `${u.name} <${u.email}>`)).join(", ")}. Give an email.`,
                  ),
                );
              }
              create.assigneeId = chosen.id;
            }
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
        if (!isReadOnlyDocument(document)) {
          return toolError(new Error("linear_query runs queries only. Use linear_create_issue, linear_comment or linear_set_state to change issues."));
        }
        try {
          const payload = await query(document, variables, signal);
          const errors = graphqlErrors(payload);
          const data = payload !== null && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
          if (data === undefined || data === null) return toolError(new Error(errors.length > 0 ? `Linear: ${errors.join("; ")}` : "Linear answered without data"));
          const text = JSON.stringify(data, null, 1);
          return errors.length > 0 ? `${text}\n\nErrors: ${errors.join("; ")}` : text;
        } catch (error) {
          return toolError(error);
        }
      },
    });
  };
}

export default createLinearPlugin({ fetch: (url, init) => fetch(url, init), now: () => Date.now(), env: process.env });
