/**
 * Deployment-wide voice-transcription defaults, read from the server's
 * environment.
 *
 * A fleet of servers — one per developer behind bb-gate — should share one
 * key and endpoint without each developer finding and pasting them. The
 * server pod carries them as environment variables; the plugin runs in that
 * process and reads them here. A developer's own setting still wins: `unset`
 * it to fall back to the deployment's.
 *
 * The key is never a descriptor default. Descriptors are what the settings
 * form is built from, and a secret setting's whole point is that its value
 * never reaches the frontend, so the key is resolved at use instead.
 *
 * The environment is read once, when the plugin loads. Rotation therefore
 * needs a server restart; there is no live re-read.
 */
export const ENV_API_KEY = "VOICE_TRANSCRIPTION_API_KEY";
export const ENV_BASE_URL = "VOICE_TRANSCRIPTION_BASE_URL";
export const ENV_MODEL = "VOICE_TRANSCRIPTION_MODEL";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-transcribe";

export type Env = Readonly<Record<string, string | undefined>>;

function fromEnv(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Defaults for the non-secret voice settings: the environment's value where
 * it sets one, else the plugin's own. Used as descriptor defaults, so the
 * settings form shows what is actually in use and a stored value — the only
 * thing the host persists — takes precedence by construction.
 */
export function settingDefaults(env: Env): {
  baseUrl: string;
  model: string;
} {
  return {
    baseUrl: fromEnv(env, ENV_BASE_URL) ?? DEFAULT_BASE_URL,
    model: fromEnv(env, ENV_MODEL) ?? DEFAULT_MODEL,
  };
}

/** The stored key if there is one, else the environment's, else null. */
export function resolveApiKey(stored: unknown, env: Env): string | null {
  const own = typeof stored === "string" ? stored.trim() : "";
  if (own !== "") return own;
  return fromEnv(env, ENV_API_KEY) ?? null;
}
