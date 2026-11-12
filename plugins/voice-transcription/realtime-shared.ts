/**
 * The Realtime surface the server and the overlay both describe.
 *
 * This module imports nothing, so the frontend bundle can pull it in without
 * dragging the server module (and the plugin's stored-key path) along. The
 * server mints an ephemeral OpenAI client secret; the overlay connects
 * straight to OpenAI over WebRTC with that secret. The plugin's own key never
 * leaves the server.
 */

/** The plugin's id; the overlay builds its own route URLs from it. */
export const PLUGIN_ID = "voice-transcription";

/** What a user line shows until its transcription completes. */
export const REALTIME_USER_PLACEHOLDER = "…";

/**
 * One line of the overlay transcript, keyed by the Realtime `item_id` so an
 * update lands in place and two assistant turns never merge into one bubble.
 * The client hands the overlay one line at a time and the overlay upserts it.
 */
export type RealtimeLine = {
  /** The Realtime item id; the overlay's key and the React key. */
  id: string;
  role: "user" | "assistant";
  text: string;
  /** The response an assistant line belongs to, from `response_id`. */
  responseId?: string;
  /**
   * For a user line, the item it follows in conversation order, from
   * `conversation.item.created.previous_item_id`; `null` is the start of the
   * conversation. An assistant line omits it and is appended.
   */
  previousId?: string | null;
  /** True once the item was truncated, so the overlay marks it cut off. */
  truncated?: boolean;
};

/**
 * Insert or update one transcript line by `id`. An existing line is merged in
 * place, never by position, so a streaming delta updates its own bubble and a
 * new assistant response opens a new one. A new user line goes where its
 * `previousId` puts it (at the start for `null`, at the end when the anchor
 * has not arrived); every other new line is appended.
 */
export function upsertRealtimeLine(lines: RealtimeLine[], line: RealtimeLine): RealtimeLine[] {
  const existing = lines.findIndex((candidate) => candidate.id === line.id);
  if (existing !== -1) {
    const next = [...lines];
    next[existing] = {
      ...next[existing],
      ...line,
      truncated: line.truncated ?? next[existing]!.truncated,
    };
    return next;
  }
  if (line.previousId === undefined) return [...lines, line];
  const anchor =
    line.previousId === null
      ? -1
      : lines.findIndex((candidate) => candidate.id === line.previousId);
  const at = anchor === -1 && line.previousId !== null ? lines.length : anchor + 1;
  const next = [...lines];
  next.splice(at, 0, line);
  return next;
}

/** The realtime signal the server publishes when a session is opened. */
export const REALTIME_SIGNAL_CHANNEL = "realtime-session";

/**
 * Where the overlay keeps this tab's client id, so an opener's own frontend
 * can read it and hand it to its backend. `bb.realtime.publish` reaches every
 * connected client and the rpc caller carries no client identity, so without
 * this the first tab to answer the signal takes the session, whichever tab
 * asked for it. `sessionStorage` is per tab and per origin: every plugin's
 * frontend runs on bb's page, so the opener reads the same entry the overlay
 * wrote. An opener that passes the id as `client` to `realtime.open` gets a
 * session only that tab's overlay will answer; one that passes none keeps the
 * old behaviour, every overlay racing for it.
 */
export const REALTIME_CLIENT_STORAGE_KEY = "voice-transcription:realtime-client";

/** The signal's payload: the session, and the one client that may take it, or null for any. */
export type RealtimeSignal = { sessionId: string; client: string | null };

/** The route that mints an ephemeral client secret for one session. */
export const REALTIME_MINT_PATH = "/realtime/session";
/** The route the overlay forwards a model tool call through. */
export const REALTIME_TOOL_PATH = "/realtime/tool";
/** The route the overlay ends a session through. */
export const REALTIME_CLOSE_PATH = "/realtime/close";

/** One function tool the model may call, as OpenAI's Realtime API expects it. */
export type RealtimeTool = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

/** The session a caller asks for: what to say, what tools it may call, and how long it may run. */
export type RealtimeSessionConfig = {
  instructions: string;
  tools: RealtimeTool[];
  model?: string;
  voice?: string;
  maxDurationMs?: number;
  /**
   * Opt in to the agent speaking first: the overlay sends one `response.create`
   * when the data channel opens, so the model greets and leads instead of
   * waiting for the owner to speak. Off by default.
   */
  speaksFirst?: boolean;
  /**
   * The ISO-639-1 code the session speaks and transcribes in: the plugin's
   * `language` setting, filled in by `realtime.open`. Empty leaves OpenAI to
   * auto-detect, which guesses wrong on the first fragment of audio.
   */
  language?: string;
};

/**
 * What the mint route returns to the browser: the ephemeral secret, and the
 * session the overlay then opens. Never the plugin's standard key.
 */
export type MintedRealtimeSession = {
  value: string;
  expiresAt: number;
  model: string;
  voice: string;
  instructions: string;
  tools: RealtimeTool[];
  maxDurationMs: number;
  /** Whether the overlay sends the opening `response.create` on channel open. */
  speaksFirst: boolean;
};

/**
 * The tool route's reply to the overlay: the tool output text, and whether the
 * model's response to it is its last. An opener returns a plain string (the
 * original contract) or this shape; the voice plugin normalises both.
 */
export type RealtimeToolReply = { output: string; last?: boolean };
