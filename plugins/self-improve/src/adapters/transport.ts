import type { Clock, Fetch } from "./types.js";

export class AdapterError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) { super(message); this.name = "AdapterError"; }
}
export const clock: Clock = {
  now: () => Date.now(),
  sleep(ms, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, Math.max(0, ms));
      function done() { signal?.removeEventListener("abort", abort); resolve(); }
      function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new AdapterError("aborted", "Request cancelled")); }
      signal?.addEventListener("abort", abort, {once: true});
    });
  },
};
export function endpoint(base: string, path: string, allowLoopback = false): URL {
  let url: URL;
  try { url = new URL(base); } catch { throw new AdapterError("invalid-url", "Endpoint must be an absolute HTTPS URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new AdapterError("invalid-url", "Endpoint must use HTTPS without URL credentials, query or fragment");
  }
  url.pathname = url.pathname.replace(/\/$/, "") + path;
  return url;
}
export async function boundedText(response: Response, limit = 2_000_000): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let total = 0; const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new AdapterError("response-too-large", "Remote response exceeds the configured size limit"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder("utf-8", {fatal:true}).decode(bytes);
}
export async function jsonResponse(response: Response, limit?: number): Promise<unknown> {
  const text = await boundedText(response, limit);
  try { return JSON.parse(text); } catch { throw new AdapterError("invalid-json", "Remote response is not valid JSON"); }
}
export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdapterError("invalid-response", "Remote response has an invalid shape");
  return value as Record<string, unknown>;
}
export function retryAfter(headers: Headers, now = Date.now(), max = 60_000): number | null {
  const value = headers.get("retry-after"); if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(max, Math.max(0, ms)) : null;
}
export function requestSignal(signal?: AbortSignal, timeoutMs = 60_000): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new AdapterError("invalid-timeout", "Timeout must be between 1 ms and 15 minutes");
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
}
export const defaultFetch: Fetch = (input, init) => fetch(input, init);
