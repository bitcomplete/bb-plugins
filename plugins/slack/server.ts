// Slack: the one team Slack app routed to this developer's bb. Each Slack
// conversation (phase 1: a DM thread) becomes one bb thread; a follow-up in
// the same Slack thread continues it, and `slack_reply` posts back through
// bb-gate-hooks, which holds the bot token. The pod never holds a Slack bot
// credential.
//
// Identity is per-developer "Sign in with Slack" (bb-gate/docs/hooks.md,
// "Slack agent"): the settings page sends the browser to Slack through the
// service, the callback below runs on this developer's own server, and the
// exchange happens in bb-gate-hooks, which holds the OAuth client secret. The
// user token that comes back is stored in a secret setting and presented at
// `/v1/identify`; the service binds the Slack user to this server's stream.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { Context } from "hono";
import { z } from "zod";
import { createHooksLoop, HOOKS_URL_ENV, HooksRequestError, REPLY_BODY_MAX_BYTES, type IdentifyResponse, type SessionEvent } from "./hooks-client.js";
import { isFromOwner, sessionsSchema, wakeText, type SessionRecord } from "./sessions.js";
import { CONNECTION_CHANGED } from "./channels.js";

export { CONNECTION_CHANGED };

/** The plugin's sign-in callback on the developer's own server. */
export const CALLBACK_PATH = "/signin/callback";

/** Sessions are remembered for a day: the service accepts replies that long. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** A sign-in state the plugin started is good for as long as the service's own. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

const SESSIONS_KEY = "sessions";
const IDENTITY_KEY = "identity";
const PENDING_PREFIX = "signin/pending/";

const identityRecord = z.object({ id: z.string(), name: z.string(), at: z.number() });
type Identity = z.infer<typeof identityRecord>;

const pendingSignin = z.object({ connection: z.string().min(1), createdAt: z.number() });
type PendingSignin = z.infer<typeof pendingSignin>;

export interface SlackPluginDeps {
  fetch: typeof fetch;
  now: () => number;
  env: Record<string, string | undefined>;
}

export function settingDescriptors(_env: Record<string, string | undefined>) {
  return {
    token: {
      type: "string",
      secret: true,
      label: "Slack sign-in token",
      description: "Filled in by Sign in with Slack below and used only to prove who you are. Do not edit or paste by hand.",
    },
    project: {
      type: "string",
      label: "Project",
      description: "Which bb project a Slack conversation starts its thread in. Leave empty to use the first project on this server.",
    },
  } as const;
}

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      signedIn: z.boolean(),
      user: z.object({ id: z.string(), name: z.string() }).nullable(),
      project: z.object({ id: z.string(), name: z.string() }).nullable(),
      projects: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })),
      hooks: z.object({ configured: z.boolean(), connected: z.boolean(), state: z.string() }),
    }),
  },
  /** Start a "Sign in with Slack" flow and return the URL to open. */
  signinStart: {
    input: z.null(),
    output: z.object({ url: z.string() }),
  },
  /** Forget the stored token and drop the service's binding to this connection. */
  signout: {
    input: z.null(),
    output: z.object({ ok: z.boolean() }),
  },
  /** Choose the project a Slack conversation starts its bb thread in. */
  setProject: {
    input: z.object({ projectId: z.string().min(1) }),
    output: z.object({ ok: z.boolean() }),
  },
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** The projects a Slack thread can be started in, in bb's own order. */
type Project = { id: string; name: string; kind: string };

/** The environment a spawned thread runs in: `threads.spawn`'s `environment`. */
type SpawnEnvironment = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]["environment"];

/** The project a Slack conversation goes to: the chosen one, else the first. */
export function chooseProject(projects: Project[], chosen: string): Project | null {
  const named = chosen.trim();
  if (named !== "") {
    const found = projects.find((p) => p.id === named || p.name.toLowerCase() === named.toLowerCase());
    if (found !== undefined) return found;
  }
  return projects.find((p) => p.kind === "standard") ?? projects[0] ?? null;
}

export function createSlackPlugin(deps: SlackPluginDeps): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const settings = bb.settings.define(settingDescriptors(deps.env));
    const hooksUrl = deps.env[HOOKS_URL_ENV]?.trim() ?? "";
    const checkSignal = () => AbortSignal.timeout(30_000);

    // ---- the conversation → thread map -------------------------------------
    //
    // One Slack conversation is one bb thread. Sessions are kept in kv so a
    // restart does not lose the mapping or forget which wakes were answered.

    const sessions = new Map<string, SessionRecord>(Object.entries(sessionsSchema.parse(await bb.storage.kv.get(SESSIONS_KEY))));
    async function saveSessions(): Promise<void> {
      const cutoff = deps.now() - SESSION_TTL_MS;
      for (const [id, r] of sessions) if (r.eventAt < cutoff) sessions.delete(id);
      await bb.storage.kv.set(SESSIONS_KEY, Object.fromEntries(sessions));
    }
    const answered = (r: SessionRecord) => r.answered >= r.events;
    function markAnswered(session: string): void {
      const r = sessions.get(session);
      if (r === undefined) return;
      sessions.set(session, { ...r, answered: Math.min(r.events, r.answered + 1) });
      void saveSessions();
    }
    /** The conversation this thread is answering, when a tool leaves the session out. */
    function sessionForThread(threadId: string): string | null {
      let best: { id: string; at: number } | null = null;
      for (const [id, r] of sessions) {
        if (r.threadId !== threadId) continue;
        if (best === null || r.eventAt > best.at) best = { id, at: r.eventAt };
      }
      return best?.id ?? null;
    }

    // ---- identity ----------------------------------------------------------
    //
    // The token is the developer's own "Sign in with Slack" token and lives in
    // a secret setting. The name bb-gate-hooks answered with is in kv, for the
    // settings page; it is never the token.

    const parsedIdentity = identityRecord.safeParse(await bb.storage.kv.get(IDENTITY_KEY));
    let identity: Identity | null = parsedIdentity.success ? parsedIdentity.data : null;

    function announceConnection(signedIn: boolean): void {
      bb.realtime.publish(CONNECTION_CHANGED, { signedIn });
    }

    function rememberIdentity(who: IdentifyResponse): void {
      const before = identity;
      identity = { id: who.user.id, name: who.user.name, at: deps.now() };
      void bb.storage.kv.set(IDENTITY_KEY, identity);
      const changed = before === null || before.id !== identity.id || before.name !== identity.name;
      if (changed) bb.log.info(`bb-gate-hooks knows this server as Slack user ${who.user.name}`);
      if (changed) announceConnection(true);
    }

    /**
     * Forget the stored token and the identity, and reconnect so the service
     * drops the binding. `refused`, when given, is the token the service
     * refused: if a newer one has been stored since (a sign-in that completed
     * while the old identify was in flight), it is left alone.
     */
    async function forgetSignin(reason: string, refused?: string): Promise<void> {
      if (refused !== undefined && ((await settings.get()).token ?? "").trim() !== refused) return;
      await settings.experimental_set({ token: null });
      cachedToken = "";
      identity = null;
      await bb.storage.kv.delete(IDENTITY_KEY);
      // Drop the stream so the service forgets the identity bound to this
      // connection; the new connection has no token to prove.
      hooks.reconnect();
      announceConnection(false);
      bb.log.info(`signed out of Slack: ${reason}`);
    }

    // ---- projects ----------------------------------------------------------

    async function projects(): Promise<Project[]> {
      try {
        return (await bb.sdk.projects.list({ includePersonal: true })).map((p) => ({ id: p.id, name: p.name, kind: p.kind }));
      } catch (error) {
        bb.log.warn(`could not list bb projects: ${errorMessage(error)}`);
        return [];
      }
    }

    async function targetProject(): Promise<Project | null> {
      return chooseProject(await projects(), (await settings.get()).project ?? "");
    }

    /**
     * Where a Slack conversation's thread runs. A plugin has no composer to
     * resolve "the project's default", and on a bb-gate server the pod itself
     * is no machine (the local host daemon is never initialised), so the
     * thread must name a connected machine. The project's newest environment
     * says what the developer actually uses: its provider and inputs are
     * replayed on its machine when that machine is connected. Otherwise the
     * project's checkout on its default source's machine, and only when the
     * project has no connected machine at all is the choice left to bb.
     */
    async function environmentFor(project: Project): Promise<SpawnEnvironment> {
      const [hosts, full, environments] = await Promise.all([
        bb.sdk.hosts.list().catch(() => []),
        bb.sdk.projects.get({ projectId: project.id }).catch(() => null),
        bb.sdk.environments.list({ projectId: project.id }).catch(() => []),
      ]);
      const connected = new Set(hosts.filter((h) => h.status === "connected").map((h) => h.id));
      const newest = environments
        .filter((e) => e.environmentProviderId !== null && e.lifecycle.phase === "active" && connected.has(e.hostId))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (newest !== undefined && newest.environmentProviderId !== null) {
        return { type: "provider", environmentProviderId: newest.environmentProviderId, inputs: newest.environmentProviderSelection?.inputs ?? null, machine: { type: "existing", hostId: newest.hostId } };
      }
      const sources = (full?.sources ?? []).filter((source) => source.type === "local_path");
      const source = sources.find((s) => s.isDefault && connected.has(s.hostId)) ?? sources.find((s) => connected.has(s.hostId));
      if (source !== undefined) {
        const providerId = project.kind === "personal" ? "personal-workspace" : "project-checkout";
        return { type: "provider", environmentProviderId: providerId, inputs: null, machine: { type: "existing", hostId: source.hostId } };
      }
      return { type: "project-default" };
    }

    // ---- the hooks stream --------------------------------------------------

    // The cached sign-in token, so the stream's identify can answer without an
    // await. Kept in step with the setting.
    let cachedToken = ((await settings.get()).token ?? "").trim();

    const hooks = createHooksLoop({
      fetch: deps.fetch,
      baseUrl: hooksUrl,
      now: deps.now,
      log: bb.log,
      identity: () => {
        // The loop calls this synchronously on a hello, before settings can be
        // awaited; the cached token is kept in step by the settings listener.
        return cachedToken;
      },
      onSession: (event) => onSession(event),
      onIdentified: (who) => rememberIdentity(who),
      onHello: () => void prunePending(),
      onTokenRefused: (token) => void forgetSignin("bb-gate-hooks refused the sign-in token", token),
    });

    settings.onChange((next, prev) => {
      const before = (prev.token ?? "").trim();
      const after = (next.token ?? "").trim();
      cachedToken = after;
      if ((before === "") !== (after === "")) announceConnection(after !== "");
    });

    // ---- posting back ------------------------------------------------------

    /** What a refused reply means, for the agent. */
    function replyError(error: unknown): Error {
      if (!(error instanceof HooksRequestError)) return error instanceof Error ? error : new Error(String(error));
      if (error.status === 403 && error.code === "not-identified") return new Error("bb-gate-hooks does not know which Slack user this server is yet (it proves that on connecting, every half hour, and after sign-in). Try again in a minute.");
      if (error.status === 403) return new Error("bb-gate-hooks refused: this Slack conversation was not routed to this server's Slack user, or its last message was more than a day ago, or the service restarted since. Nothing was posted.");
      if (error.unknownConnection) return new Error("This bb server is reconnecting to bb-gate-hooks. Try again in a minute.");
      if (error.status === 400) return new Error("bb-gate-hooks refused the reply as malformed.");
      if (error.status === 413) return new Error(`The reply is larger than Slack allows (${REPLY_BODY_MAX_BYTES / 1024} KiB). Shorten it.`);
      if (error.status === 502) return new Error("Slack refused the message. Nothing was posted; try again in a moment.");
      if (error.status === 503) return new Error("bb-gate-hooks cannot post to Slack right now (Slack is unreachable, or the team app's credentials are not set up there). Try again later.");
      return new Error(`bb-gate-hooks answered HTTP ${error.status} to the reply.`);
    }

    /** Post a reply on a session and count it answered. Throws what replyError makes. */
    async function postReply(session: string, text: string, signal: AbortSignal): Promise<void> {
      try {
        await hooks.reply(session, text, signal);
      } catch (error) {
        throw replyError(error);
      }
      markAnswered(session);
      void hooks.status(session, "", checkSignal()).catch(() => undefined);
    }

    /** The plugin's own reply when a turn ends without one. Logged, never thrown. */
    async function backstop(session: string, text: string): Promise<void> {
      try {
        await postReply(session, text, checkSignal());
      } catch (error) {
        bb.log.warn(`could not post the backstop reply for Slack session ${session}: ${errorMessage(error)}`);
      }
    }

    /** Push the bb thread's title to Slack for every conversation it answers. */
    async function pushTitle(threadId: string): Promise<void> {
      const mine = [...sessions].filter(([, r]) => r.threadId === threadId);
      if (mine.length === 0) return;
      let title: string | null = null;
      try {
        const info = (await bb.sdk.threads.get({ threadId })) as unknown as { title?: string | null; titleFallback?: string | null };
        const named = (info.title ?? info.titleFallback ?? "").trim();
        title = named === "" ? null : named;
      } catch (error) {
        bb.log.warn(`could not read thread ${threadId}'s title for Slack: ${errorMessage(error)}`);
        return;
      }
      if (title === null) return;
      const clipped = clipBytes(title, 256);
      for (const [session, r] of mine) {
        if (r.title === clipped) continue;
        try {
          await hooks.title(session, clipped, checkSignal());
          const now = sessions.get(session);
          if (now !== undefined) {
            sessions.set(session, { ...now, title: clipped });
            void saveSessions();
          }
        } catch (error) {
          bb.log.warn(`could not set the Slack title for session ${session}: ${errorMessage(error)}`);
        }
      }
    }

    /** A string cut to at most `max` bytes of UTF-8, without splitting a character. */
    function clipBytes(text: string, max: number): string {
      const bytes = new TextEncoder().encode(text);
      if (bytes.length <= max) return text;
      let end = max;
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
      return new TextDecoder().decode(bytes.slice(0, end));
    }

    // ---- the wake ----------------------------------------------------------

    /** A short, deterministic bb thread title for the first wake of a conversation. */
    function threadTitle(event: SessionEvent): string {
      const first = event.comment.text.replace(/\s+/gu, " ").trim();
      if (first === "") return event.action === "assistant_thread_started" ? "Slack assistant pane" : "Slack message";
      return first.length <= 80 ? first : `${first.slice(0, 77)}…`;
    }

    /** Message a thread; "gone" when it no longer exists, "failed" for a transient error. */
    async function sendToThread(threadId: string, text: string): Promise<"sent" | "gone" | "failed"> {
      try {
        await bb.sdk.threads.send({ threadId, input: [{ type: "text", text, mentions: [] }], mode: "auto" });
        return "sent";
      } catch (error) {
        const e = error as { code?: string; status?: number };
        if (e.code === "NOT_FOUND" || e.status === 404 || e.status === 410) return "gone";
        bb.log.warn(`Slack could not message thread ${threadId}: ${errorMessage(error)}`);
        return "failed";
      }
    }

    async function markHanded(session: string, handedAt: number): Promise<void> {
      const r = sessions.get(session);
      if (r === undefined) return;
      sessions.set(session, { ...r, handedAt });
      await saveSessions();
    }

    /** Start the bb thread for a conversation, or answer with the reason it cannot. */
    async function spawnThread(event: SessionEvent, text: string, handedAt: number): Promise<void> {
      const project = await targetProject();
      if (project === null) {
        await backstop(event.session, "No bb project is available on this server, so a Slack thread cannot be started. Create a project in bb, then DM again.");
        return;
      }
      const thread = await bb.sdk.threads.spawn({ projectId: project.id, environment: await environmentFor(project), prompt: text, title: threadTitle(event) });
      const after = sessions.get(event.session);
      if (after !== undefined) {
        sessions.set(event.session, { ...after, threadId: thread.id, projectId: project.id, handedAt });
        await saveSessions();
      }
      bb.log.info(`Slack session ${event.session} started bb thread ${thread.id} in ${project.name}`);
    }

    /**
     * A Slack conversation woke this server. The first message spawns a bb
     * thread; a follow-up is sent to the same one. The words are marked
     * untrusted whenever they are not the owner's. A context change carries no
     * words and needs no reply: it keeps the conversation mapped and runs no
     * turn, so it never trips the backstop.
     */
    async function handleSession(event: SessionEvent): Promise<void> {
      const previous = sessions.get(event.session);
      const needsReply = event.action !== "assistant_thread_context_changed";
      const record: SessionRecord = {
        channel: event.channel,
        thread: event.thread,
        threadId: previous?.threadId ?? null,
        projectId: previous?.projectId ?? null,
        eventAt: deps.now(),
        events: (previous?.events ?? 0) + (needsReply ? 1 : 0),
        answered: previous?.answered ?? 0,
        handedAt: previous?.handedAt ?? null,
        title: previous?.title ?? null,
      };
      sessions.set(event.session, record);
      await saveSessions();
      if (!needsReply) {
        bb.log.info(`Slack session ${event.session} context changed; nothing to answer`);
        return;
      }
      bb.log.info(`Slack session ${event.session} (${event.action}) from ${isFromOwner(event) ? "the owner" : "someone else"}; handing it to a bb thread`);

      // The thinking indicator, best effort: the service only accepts it for a
      // session routed here, which this one is.
      void hooks.status(event.session, "is thinking…", checkSignal()).catch(() => undefined);

      const text = wakeText(event);
      // Marked before the thread is touched, so a turn the wake starts is
      // after it and the backstop can tell the handling turn from an older one.
      const handedAt = deps.now();
      try {
        if (record.threadId === null) {
          await spawnThread(event, text, handedAt);
          return;
        }
        const outcome = await sendToThread(record.threadId, text);
        if (outcome === "sent") {
          await markHanded(event.session, handedAt);
        } else if (outcome === "gone") {
          bb.log.info(`Slack session ${event.session}'s bb thread ${record.threadId} is gone; starting a new one`);
          const after = sessions.get(event.session);
          if (after !== undefined) {
            sessions.set(event.session, { ...after, threadId: null, projectId: null });
            await saveSessions();
          }
          await spawnThread(event, text, handedAt);
        } else {
          // A transient error keeps the mapping: the thread still exists and
          // the next message must continue it, not start a second one.
          await backstop(event.session, "Your bb could not deliver this Slack message to its thread. Try again in a moment.");
        }
      } catch (error) {
        bb.log.warn(`Slack session ${event.session} could not reach a bb thread: ${errorMessage(error)}`);
        await backstop(event.session, `Your bb could not start or continue a thread for this Slack conversation: ${errorMessage(error)}`);
      }
    }

    /** One wake at a time per conversation, so two quick messages cannot both spawn a thread. */
    const sessionChains = new Map<string, Promise<void>>();
    function onSession(event: SessionEvent): void {
      const run = (sessionChains.get(event.session) ?? Promise.resolve())
        .then(() => handleSession(event))
        .catch((error: unknown) => bb.log.warn(`Slack session ${event.session} failed: ${errorMessage(error)}`));
      sessionChains.set(event.session, run);
      void run.then(() => {
        if (sessionChains.get(event.session) === run) sessionChains.delete(event.session);
      });
    }

    /** A bb thread that went away stops answering its Slack conversation; the next message starts a new one. */
    function forgetThread(threadId: string): void {
      let changed = false;
      for (const [session, r] of sessions) {
        if (r.threadId !== threadId) continue;
        sessions.set(session, { ...r, threadId: null, projectId: null });
        changed = true;
      }
      if (changed) void saveSessions();
    }
    bb.events.on("thread.archived", ({ thread }) => forgetThread(thread.id));
    bb.events.on("thread.deleted", ({ thread }) => forgetThread(thread.id));

    /**
     * The backstop for "one reply per message": a bb turn that handled a wake
     * ended without `slack_reply`. The turn that handled it is the one whose
     * input named the session, so a turn already running when the wake arrived
     * does not count. The title is pushed from the bb thread's own title here.
     */
    async function onThreadIdle(threadId: string): Promise<void> {
      await pushTitle(threadId);
      const waiting = [...sessions].filter(([, r]) => r.threadId === threadId && !answered(r));
      if (waiting.length === 0) return;
      let starts: Array<{ createdAt: number; data: unknown }>;
      try {
        starts = (await bb.sdk.threads.events.list({ threadId, types: ["client/turn/start"], order: "desc", limit: "10" })) as Array<{ createdAt: number; data: unknown }>;
      } catch (error) {
        bb.log.warn(`could not read thread ${threadId}'s turns to check its Slack replies: ${errorMessage(error)}`);
        return;
      }
      for (const [session, r] of waiting) {
        const handled = starts.some((e) => e.createdAt >= (r.handedAt ?? 0) && JSON.stringify(e.data ?? {}).includes(session));
        if (!handled) continue;
        bb.log.warn(`thread ${threadId} ended the turn that handled Slack session ${session} without replying; answering for it`);
        await backstop(session, "The bb thread finished its turn without sending a reply here. Send another message to try again.");
      }
    }
    bb.events.on("thread.idle", ({ thread }) => {
      void onThreadIdle(thread.id).catch((error: unknown) => bb.log.warn(`checking thread ${thread.id}'s Slack replies failed: ${errorMessage(error)}`));
    });

    // ---- the settings and sign-in surface ----------------------------------

    async function status() {
      const cfg = await settings.get();
      const all = await projects();
      const chosen = chooseProject(all, cfg.project ?? "");
      return {
        signedIn: (cfg.token ?? "").trim() !== "",
        user: identity === null ? null : { id: identity.id, name: identity.name },
        project: chosen === null ? null : { id: chosen.id, name: chosen.name },
        projects: all,
        hooks: { configured: hooksUrl !== "", connected: hooks.connected, state: hooks.state().state },
      };
    }

    bb.rpc.register(rpcContract, {
      status,
      async signinStart() {
        if (hooksUrl === "") throw new Error(`Sign in with Slack is not available on this bb server: it has no bb-gate-hooks service (${HOOKS_URL_ENV} is not set).`);
        if (!hooks.connected) throw new Error("This bb server is not connected to bb-gate-hooks yet. Wait a moment and try again.");
        await prunePending();
        const connection = hooks.connectionId;
        if (connection === null) throw new Error("This bb server is not connected to bb-gate-hooks yet. Wait a moment and try again.");
        const { authorizeUrl, state } = await hooks.signinStart(checkSignal());
        await bb.storage.kv.set(`${PENDING_PREFIX}${state}`, { connection, createdAt: deps.now() } satisfies PendingSignin);
        return { url: authorizeUrl };
      },
      async signout() {
        await forgetSignin("the developer signed out");
        return { ok: true };
      },
      async setProject({ projectId }) {
        const all = await projects();
        const found = all.find((p) => p.id === projectId);
        if (found === undefined) throw new Error(`No bb project ${JSON.stringify(projectId)} on this server.`);
        await settings.experimental_set({ project: found.id });
        return { ok: true };
      },
    });

    async function prunePending(): Promise<void> {
      const now = deps.now();
      for (const key of await bb.storage.kv.list(PENDING_PREFIX)) {
        const p = await bb.storage.kv.get<PendingSignin>(key);
        if (p === undefined || now - p.createdAt > PENDING_TTL_MS) await bb.storage.kv.delete(key);
      }
    }

    // Slack sends the browser here after sign-in. The request is routed by
    // tsjwt to the server of whoever completed it, so the callback runs on the
    // connection's own server. "none" because it is a top-level navigation from
    // Slack's origin; the single-use state is the credential.
    bb.http.route(
      "GET",
      CALLBACK_PATH,
      async (c: Context) => {
        const state = c.req.query("state") ?? "";
        const pending = /^[A-Za-z0-9_-]{1,200}$/u.test(state) ? await bb.storage.kv.get<PendingSignin>(`${PENDING_PREFIX}${state}`) : undefined;
        if (pending === undefined || deps.now() - pending.createdAt > PENDING_TTL_MS) {
          return resultPage("This link has expired", "Start again from Sign in with Slack in bb's settings.", 400);
        }
        await bb.storage.kv.delete(`${PENDING_PREFIX}${state}`);
        if (c.req.query("error") !== undefined) {
          return resultPage("Not signed in", "Slack did not complete the sign-in. Start again from bb's settings.", 200);
        }
        const code = c.req.query("code") ?? "";
        if (code === "") return resultPage("Not signed in", "Slack sent no code. Start again from bb's settings.", 400);
        try {
          const { token } = await hooks.signinExchange(pending.connection, state, code, checkSignal());
          await settings.experimental_set({ token });
          cachedToken = token;
          // Prove it right away so the settings page can say who.
          await hooks.reidentify();
          announceConnection(true);
          const who = identity;
          return resultPage("Signed in to Slack", who === null ? "You can close this tab." : `Signed in as ${who.name}. You can close this tab.`, 200);
        } catch (error) {
          // The state is single-use, so a failure here means the flow is gone:
          // the developer must start it again rather than retry.
          const message =
            error instanceof HooksRequestError && error.status === 403 && error.code === "not-yours"
              ? "This sign-in was completed in a different browser or server than it started in."
              : "The sign-in link was already used, expired, or could not be completed.";
          bb.log.warn(`Slack sign-in failed: ${errorMessage(error)}`);
          return resultPage("Not signed in", `${message} Start again from Sign in with Slack in bb's settings.`, 502);
        }
      },
      { auth: "none" },
    );

    // ---- the tools ---------------------------------------------------------

    const toolError = (error: unknown) => ({ content: [{ type: "text" as const, text: errorMessage(error) }], isError: true });

    bb.agents.registerTool({
      name: "slack_reply",
      description:
        "Reply in Slack on the conversation that woke this thread. The message is posted by bb-gate-hooks, which holds the team app's bot token; this server sends only the connection id and the text. Use it once, at the end of the turn that handled a Slack message.",
      instructions:
        "A Slack DM that reached this thread is answered with slack_reply. The session id is in the message that woke the thread. Post one reply per Slack message, in Slack's mrkdwn, and say in one line who did it. Do not paste secrets or tokens.",
      presentation: { label: { pending: "Replying in Slack", completed: "Replied in Slack" } },
      parameters: z.object({
        text: z.string().trim().min(1).max(30_000).describe("The reply, in Slack's mrkdwn."),
        session: z.string().trim().min(1).max(200).optional().describe("The Slack session id from the wake. Leave it out: this thread's Slack conversation is used."),
      }),
      async execute({ text, session }, { threadId, signal }) {
        if (hooksUrl === "") return toolError(new Error("Replying in Slack is not available on this bb server: it has no bb-gate-hooks service (BB_HOOKS_URL is not set)."));
        const id = session ?? sessionForThread(threadId);
        if (id === null) return toolError(new Error("This thread is not answering a Slack conversation, so there is nothing to reply to."));
        const r = sessions.get(id);
        if (r !== undefined && answered(r)) {
          return toolError(new Error("Every message in this Slack conversation already has its reply; each gets exactly one. Send a new Slack message to continue."));
        }
        if (new TextEncoder().encode(text).length > REPLY_BODY_MAX_BYTES) return toolError(new Error(`The reply is larger than Slack allows (${REPLY_BODY_MAX_BYTES / 1024} KiB). Shorten it.`));
        try {
          await postReply(id, text, signal);
          void pushTitle(threadId);
          return `Replied in Slack (session ${id}). That is this message's one reply.`;
        } catch (error) {
          return toolError(error);
        }
      },
    });

    // ---- the stream service ------------------------------------------------

    if (hooksUrl !== "") {
      bb.background.service("slack", {
        async start(signal) {
          await hooks.run(signal);
        },
      });
    }
  };
}

export default createSlackPlugin({ fetch: (url, init) => fetch(url, init), now: () => Date.now(), env: process.env });
