import type { CompletionConfig } from "./summarize.js";

/**
 * Deployment-wide summarizer defaults, read from the server's environment.
 *
 * A fleet of servers — one per developer behind bb-gate — should share one
 * key and endpoint without each developer finding and pasting it. The server
 * pod carries them as environment variables; the plugin runs in that process
 * and reads them here. A developer's own setting still wins: `unset` it to
 * fall back to the deployment's.
 *
 * The key is never a descriptor default. Descriptors are what the settings
 * form is built from, and a secret setting's whole point is that its value
 * never reaches the frontend, so the key is resolved at use instead.
 */
export const ENV_API_KEY = "THREAD_BRIEFS_API_KEY";
export const ENV_BASE_URL = "THREAD_BRIEFS_BASE_URL";
export const ENV_MODEL = "THREAD_BRIEFS_MODEL";
export const ENV_JSON_MODE = "THREAD_BRIEFS_JSON_MODE";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";

export type Env = Readonly<Record<string, string | undefined>>;

function fromEnv(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

/**
 * Defaults for the non-secret summarizer settings: the environment's value
 * where it sets one, else the plugin's own. Used as descriptor defaults, so
 * the settings form shows what is actually in use and a stored value — the
 * only thing the host persists — takes precedence by construction.
 */
export function settingDefaults(env: Env): {
  baseUrl: string;
  model: string;
  jsonMode: boolean;
} {
  return {
    baseUrl: fromEnv(env, ENV_BASE_URL) ?? DEFAULT_BASE_URL,
    model: fromEnv(env, ENV_MODEL) ?? DEFAULT_MODEL,
    jsonMode: parseBoolean(fromEnv(env, ENV_JSON_MODE)) ?? true,
  };
}

/** The stored key if there is one, else the environment's, else null. */
export function resolveApiKey(stored: unknown, env: Env): string | null {
  const own = typeof stored === "string" ? stored.trim() : "";
  if (own !== "") return own;
  return fromEnv(env, ENV_API_KEY) ?? null;
}

/** A stored string setting, or undefined when it is missing or blank. */
function stored(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : undefined;
}

/**
 * The request configuration for one summary, or null when no key is
 * configured anywhere. Settings already carry the environment's defaults for
 * everything but the key — but only until something is stored, and the host
 * persists a cleared field as `""`, which then wins over the default by
 * construction. A blank `baseUrl` or `model` therefore reads as unset here
 * too: a request to `/chat/completions` with no host cannot be what anyone
 * meant, and the description on each setting says "unset" is the way back
 * to the deployment's value.
 */
export function resolveCompletion(
  values: { baseUrl?: unknown; apiKey?: unknown; model?: unknown; jsonMode: boolean },
  env: Env,
): CompletionConfig | null {
  const apiKey = resolveApiKey(values.apiKey, env);
  if (apiKey === null) return null;
  const defaults = settingDefaults(env);
  return {
    baseUrl: stored(values.baseUrl) ?? defaults.baseUrl,
    apiKey,
    model: stored(values.model) ?? defaults.model,
    jsonMode: values.jsonMode,
  };
}
