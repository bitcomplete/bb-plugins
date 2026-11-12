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

/** The realtime signal the server publishes when a session is opened. */
export const REALTIME_SIGNAL_CHANNEL = "realtime-session";

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
