// Voice transcription: a server-process voice-input service for bb that posts
// a recording to any OpenAI-compatible `/audio/transcriptions` endpoint. It
// runs entirely on the bb server, so it needs no primary machine, no bb
// account and no Codex login; the wire format is the one OpenAI, Groq,
// Mistral, OpenRouter, Fireworks and self-hosted Whisper servers all speak.
//
// bb owns the microphone and the composer; this plugin owns the request. The
// registration contract is `PluginAiServiceDeclaration` from
// `bb.experimental_aiServices` (bb desktop-v0.44.0 and later; plugin services
// are listed in Automatic since desktop-v0.45.0).
import type { BbPluginApi, PluginAiServiceStatus } from "@get-bb/plugin-sdk";

export const PLUGIN_ID = "voice-transcription";
/** Stable service id: the picker names it `voice-transcription:openai-compatible`. */
export const SERVICE_ID = "openai-compatible";
/** The OpenAI endpoint. Left here, an empty key is refused (see `statusFor`). */
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** Appended to `baseUrl`; both carry no trailing slash. */
export const TRANSCRIBE_PATH = "/audio/transcriptions";
/** OpenAI's audio limit; refused before anything is sent. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** How much of a non-2xx body an error message carries. */
export const ERROR_BODY_CHARS = 200;
export const NOT_CONFIGURED_MESSAGE =
  "Set the endpoint and model in Settings → Plugins → Voice transcription";
export const MISSING_KEY_MESSAGE =
  "Set the API key in Settings → Plugins → Voice transcription";

export const SETTING_DESCRIPTORS = {
  baseUrl: {
    type: "string",
    label: "Endpoint base URL",
    description:
      "No trailing slash; /audio/transcriptions is appended. Defaults to OpenAI; point it at Groq, Mistral, OpenRouter, Fireworks or a self-hosted Whisper server to use those.",
    default: DEFAULT_BASE_URL,
  },
  apiKey: {
    type: "string",
    label: "API key",
    description:
      "Sent only as `Authorization: Bearer` to the endpoint above, and never to the frontend. Leave empty for a self-hosted server with no auth.",
    secret: true,
    default: "",
  },
  model: {
    type: "string",
    label: "Model",
    description:
      "Passed through verbatim: gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper-1, whisper-large-v3-turbo, voxtral-mini-latest, …",
    default: "gpt-4o-transcribe",
  },
  language: {
    type: "string",
    label: "Language",
    description:
      "ISO-639-1 code such as `en`. Empty lets the endpoint auto-detect.",
    default: "",
  },
} as const;

/** The extensions a Whisper-family server reads to pick a decoder. */
const AUDIO_EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

/** A credential-shaped run in an error body, for `redactLine`. */
const SECRET =
  /((?:authorization|token|secret|password|passwd|api[_-]?key|cookie|set-cookie)["']?\s*[:=]\s*["']?(?:bearer\s+)?|bearer\s+)([^\s"',;]+)/giu;

type SettingsValues = {
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
};

/** `https://api.openai.com/v1/` and the default compare equal. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/u, "");
}

/**
 * The upload's extension: the MIME type's when it names a known format
 * (`audio/webm;codecs=opus` → "webm", `audio/mp4` → "m4a"), otherwise the
 * recording's own name's.
 */
export function audioExtension(audio: File): string | null {
  const mime = audio.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const byMime = AUDIO_EXTENSION_BY_MIME[mime];
  if (byMime !== undefined) return byMime;
  const dot = audio.name.lastIndexOf(".");
  const extension = dot === -1 ? "" : audio.name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/u.test(extension) ? extension : null;
}

/** The filename the multipart part carries, extension matched to the MIME type. */
export function audioFileName(audio: File): string {
  const stem = audio.name.replace(/\.[^./\\]+$/u, "") || "audio";
  const extension = audioExtension(audio);
  return extension === null ? stem : `${stem}.${extension}`;
}

/**
 * One line of an error body with obvious credentials replaced and its length
 * clipped. Everything that reaches a user or a log passes here.
 */
export function redactLine(line: string, max = ERROR_BODY_CHARS): string {
  const clean = line.replace(SECRET, "$1[redacted]");
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * The first `max` characters of a non-2xx body, with credential-shaped runs
 * redacted and the configured key removed. Vendors echo the key in a 401
 * body, and that body must never reach a user or a log.
 */
export function errorExcerpt(
  body: string,
  apiKey: string,
  max = ERROR_BODY_CHARS,
): string {
  const excerpt = redactLine(body.slice(0, max), max);
  const key = apiKey.trim();
  return key === "" ? excerpt : excerpt.split(key).join("[redacted]");
}

/** Whether the service can answer, from the settings alone; no network. */
export function statusFor(values: SettingsValues): PluginAiServiceStatus {
  const baseUrl = normalizeBaseUrl(values.baseUrl);
  const model = values.model.trim();
  if (baseUrl === "" || model === "") {
    return { ready: false, message: NOT_CONFIGURED_MESSAGE };
  }
  // An empty key is a self-hosted server's normal state, but against the
  // default OpenAI endpoint it only means unauthenticated traffic to OpenAI,
  // so Automatic must not pick it.
  if (values.apiKey.trim() === "" && baseUrl === DEFAULT_BASE_URL) {
    return { ready: false, message: MISSING_KEY_MESSAGE };
  }
  return { ready: true };
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createVoiceTranscriptionPlugin() {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const settings = bb.settings.define(SETTING_DESCRIPTORS);

    async function status(): Promise<PluginAiServiceStatus> {
      return statusFor(await settings.get());
    }

    async function transcribe(
      audio: File,
      { signal, hint }: { signal: AbortSignal; hint: string | null },
    ): Promise<string> {
      const values = await settings.get();
      const baseUrl = normalizeBaseUrl(values.baseUrl);
      const model = values.model.trim();
      if (baseUrl === "" || model === "") throw new Error(NOT_CONFIGURED_MESSAGE);
      if (audio.size > MAX_AUDIO_BYTES) {
        throw new Error(
          `Recordings over ${MAX_AUDIO_BYTES / (1024 * 1024)} MB are too large for ${baseUrl}`,
        );
      }
      const apiKey = values.apiKey.trim();
      const language = values.language.trim();
      const file = new File([audio], audioFileName(audio), { type: audio.type });
      const form = new FormData();
      form.set("file", file);
      form.set("model", model);
      form.set("response_format", "json");
      if (hint !== null) form.set("prompt", hint);
      if (language !== "") form.set("language", language);
      const headers: Record<string, string> = {};
      if (apiKey !== "") headers.Authorization = `Bearer ${apiKey}`;
      const url = `${baseUrl}${TRANSCRIBE_PATH}`;

      const started = Date.now();
      // The first answer is used unless it is a rate limit or a server error
      // and the caller is still waiting; a timeout, an abort and every 4xx are
      // final. FormData is replayable, so a retry sends the same parts.
      let response = await fetch(url, {
        method: "POST",
        headers,
        body: form,
        signal,
      });
      if (retryable(response.status) && !signal.aborted) {
        // Release the first body's socket before opening the retry.
        await response.body?.cancel();
        response = await fetch(url, {
          method: "POST",
          headers,
          body: form,
          signal,
        });
      }
      const durationMs = Date.now() - started;
      // One line per call: how long, how many bytes, what the endpoint said.
      // Never the audio and never the transcript.
      bb.log.info(
        `voice-transcription: ${url} answered HTTP ${response.status} in ${durationMs} ms for ${audio.size} bytes`,
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Voice transcription failed: HTTP ${response.status} from ${url}: ${errorExcerpt(body, apiKey)}`,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error(
          `Voice transcription failed: ${url} returned a reply that is not JSON`,
        );
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("text" in payload) ||
        typeof (payload as { text: unknown }).text !== "string"
      ) {
        throw new Error(
          `Voice transcription failed: ${url} returned a reply without a text field`,
        );
      }
      return (payload as { text: string }).text.trim();
    }

    bb.experimental_aiServices.register({
      id: SERVICE_ID,
      displayName: "OpenAI-compatible",
      transcribe,
      status,
    });
  };
}

export default createVoiceTranscriptionPlugin();
