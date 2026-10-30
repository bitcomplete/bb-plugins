// Slack's own `conversations.list`, called with the developer's own sign-in
// token (bb-gate/docs/hooks.md, "Slack agent"). The pod holds that user token
// to prove who the developer is; this is the one Slack read it also does with
// it, and the reason the token needs the user scopes `channels:read` and
// `groups:read`. It returns what the signed-in developer can see, never what
// the bot can see.
//
// The token goes into the Authorization header of one request and nowhere
// else: not a log line, not an error message. Only Slack's own `error` code
// is ever surfaced.
import { z } from "zod";

type FetchLike = (url: string | URL, init: RequestInit) => Promise<Response>;

/**
 * Slack refused the token: it is the wrong kind (an OpenID identity token from
 * a sign-in before this change), revoked, or lacks the user scopes. The
 * developer must sign in again.
 */
export class SlackTokenError extends Error {
  constructor(readonly code: string) {
    super(`Slack refused the sign-in token (${code}); sign in again`);
    this.name = "SlackTokenError";
  }
}

/** Slack could not be reached, or answered an error to retry later. */
export class SlackUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`Slack did not answer the channel list (${code})`);
    this.name = "SlackUnavailableError";
  }
}

/**
 * The Slack errors that mean "this token cannot list channels; sign in again".
 * `missing_scope` is a user token whose scopes a Slack admin has not granted
 * yet; `not_allowed_token_type` is an OpenID identity token.
 */
const TOKEN_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "invalid_token",
  "missing_scope",
  "not_allowed_token_type",
  "no_permission",
]);

/** One channel the developer can see, as the settings picker shows it. */
export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
  extShared: boolean;
}

/** A page of the developer's channels, and whether the page cap cut it short. */
export interface SlackChannelList {
  channels: SlackChannel[];
  truncated: boolean;
}

/** How long a channel list is reused before Slack is called again. */
export const CHANNELS_CACHE_TTL_MS = 5 * 60 * 1000;
/** Slack's largest page. */
const CHANNEL_PAGE_LIMIT = 200;
/** A cursor that never ends stops here, so a bad Slack cannot spin the handler. */
const CHANNEL_PAGE_CAP = 20;

const conversationsListResponse = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  channels: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        is_private: z.boolean().optional(),
        is_ext_shared: z.boolean().optional(),
      }),
    )
    .optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

export interface SlackChannelsDeps {
  fetch: FetchLike;
  now: () => number;
  log: { warn(message: string): void };
}

export interface SlackChannels {
  /** The channels the token can see, cached in memory for a few minutes. */
  list(token: string): Promise<SlackChannelList>;
}

/**
 * A per-server cache of the developer's visible channels. Keyed by the token,
 * so a fresh sign-in never serves the previous token's list. Throws
 * {@link SlackTokenError} or {@link SlackUnavailableError}.
 */
export function createSlackChannels(deps: SlackChannelsDeps): SlackChannels {
  let cache: { token: string; at: number; list: SlackChannelList } | null = null;
  return {
    async list(token: string): Promise<SlackChannelList> {
      if (cache !== null && cache.token === token && deps.now() - cache.at < CHANNELS_CACHE_TTL_MS) return cache.list;
      const list = await fetchChannels(deps, token);
      cache = { token, at: deps.now(), list };
      return list;
    },
  };
}

async function fetchChannels(deps: SlackChannelsDeps, token: string): Promise<SlackChannelList> {
  const out: SlackChannel[] = [];
  let truncated = false;
  let cursor = "";
  for (let page = 0; ; page += 1) {
    if (page >= CHANNEL_PAGE_CAP) {
      deps.log.warn("slack conversations.list: page cap reached");
      truncated = true;
      break;
    }
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: String(CHANNEL_PAGE_LIMIT),
    });
    if (cursor !== "") params.set("cursor", cursor);
    let response: Response;
    try {
      response = await deps.fetch(`https://slack.com/api/conversations.list?${params.toString()}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (error) {
      throw new SlackUnavailableError(error instanceof Error ? error.message : "unreachable");
    }
    if (!response.ok) throw new SlackUnavailableError(`HTTP ${response.status}`);
    const parsed = conversationsListResponse.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new SlackUnavailableError("unreadable response");
    if (!parsed.data.ok) {
      const code = parsed.data.error ?? "unknown";
      if (TOKEN_ERRORS.has(code)) throw new SlackTokenError(code);
      throw new SlackUnavailableError(code);
    }
    for (const channel of parsed.data.channels ?? []) {
      if (channel.id === "") continue;
      out.push({ id: channel.id, name: channel.name ?? "", private: channel.is_private === true, extShared: channel.is_ext_shared === true });
    }
    cursor = parsed.data.response_metadata?.next_cursor ?? "";
    if (cursor === "") break;
  }
  return { channels: out, truncated };
}
