/**
 * The app-wide Realtime voice overlay.
 *
 * Another plugin's backend opens a session through the `realtime.open` RPC;
 * the server publishes a signal, and this overlay mints an ephemeral secret
 * and opens the WebRTC session. It is inert until then: no signal, no UI, and
 * the plugin's ordinary transcription is untouched. When the overlay closes,
 * or its time limit runs out, the session is ended on the server.
 */
import { useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime } from "@get-bb/plugin-sdk/app";
import {
  PLUGIN_ID,
  REALTIME_CLIENT_STORAGE_KEY,
  REALTIME_CLOSE_PATH,
  REALTIME_MINT_PATH,
  REALTIME_SIGNAL_CHANNEL,
  REALTIME_TOOL_PATH,
  type MintedRealtimeSession,
} from "./realtime-shared.js";
import {
  RealtimeSessionClient,
  RealtimeSessionTakenError,
  type RealtimeLine,
  type RealtimeStatus,
} from "./realtime-client.js";

/** A failed route call, carrying the HTTP status so the overlay can tell a lost race from an error. */
class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RouteError";
  }
}

/** POST JSON to one of this plugin's own routes and unwrap the error envelope. */
async function callRoute(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`/api/v1/plugins/${PLUGIN_ID}/http${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof (payload as { error: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `HTTP ${response.status}`;
    throw new RouteError(response.status, message);
  }
  return payload;
}

/**
 * This tab's client id, made once per tab and kept in `sessionStorage` under
 * `REALTIME_CLIENT_STORAGE_KEY` so an opener's frontend in the same tab can
 * read it. A tab whose storage is unavailable gets an id that nothing else can
 * read; the opener then passes no client and every overlay races as before.
 */
function realtimeClientId(): string {
  try {
    const stored = window.sessionStorage.getItem(REALTIME_CLIENT_STORAGE_KEY);
    if (stored !== null && stored !== "") return stored;
    const fresh = crypto.randomUUID();
    window.sessionStorage.setItem(REALTIME_CLIENT_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

function RealtimeVoiceOverlay() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Made on mount, before any click can ask for a session, so the opener
  // always finds it.
  const [clientId] = useState(realtimeClientId);
  const [status, setStatus] = useState<RealtimeStatus | "idle">("idle");
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<RealtimeLine[]>([]);
  const [muted, setMuted] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const clientRef = useRef<RealtimeSessionClient | null>(null);

  useRealtime(REALTIME_SIGNAL_CHANNEL, (payload) => {
    if (typeof payload !== "object" || payload === null || !("sessionId" in payload)) return;
    const { sessionId: id, client } = payload as { sessionId: unknown; client?: unknown };
    // A session opened for another tab is not this overlay's: the signal
    // reaches every tab, and only the one that asked may answer. A signal
    // with no client (an older server, or an opener that passed none) is
    // open to any tab, as before.
    if (typeof client === "string" && client !== "" && client !== clientId) return;
    if (typeof id === "string" && id !== "") setSessionId(id);
  });

  useEffect(() => {
    if (sessionId === null) return;
    setStatus("connecting");
    setError(null);
    setLines([]);
    setSecondsLeft(null);
    setMuted(false);
    const client = new RealtimeSessionClient({
      mint: async () => {
        try {
          return (await callRoute(REALTIME_MINT_PATH, { sessionId, client: clientId })) as MintedRealtimeSession;
        } catch (error) {
          // 409 means another client already minted this session; drop out
          // quietly rather than ending the winner's session.
          if (error instanceof RouteError && error.status === 409) {
            throw new RealtimeSessionTakenError();
          }
          throw error;
        }
      },
      toolCall: async (tool) => {
        const result = (await callRoute(REALTIME_TOOL_PATH, {
          sessionId,
          ...tool,
        })) as { output?: unknown; last?: unknown };
        return {
          output: typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null),
          ...(result.last === true ? { last: true } : {}),
        };
      },
      close: async () => {
        await callRoute(REALTIME_CLOSE_PATH, { sessionId });
      },
      onLine: (line) =>
        setLines((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (line.role === "assistant" && last?.role === "assistant") next[next.length - 1] = line;
          else next.push(line);
          return next;
        }),
      onStatus: (next, message) => {
        setStatus(next);
        if (message !== undefined) setError(message);
        if (next === "closed") setSessionId(null);
      },
      onSecondsLeft: (seconds) => setSecondsLeft(seconds),
    });
    clientRef.current = client;
    void client.start();
    // A tab that is closing does not run the cleanup below, so nudge the close
    // route on `pagehide`; the server's own sweep is the guarantee.
    const onPageHide = (): void => {
      if (typeof navigator.sendBeacon !== "function") return;
      const body = new Blob([JSON.stringify({ sessionId })], { type: "application/json" });
      navigator.sendBeacon(`/api/v1/plugins/${PLUGIN_ID}/http${REALTIME_CLOSE_PATH}`, body);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      clientRef.current = null;
      void client.stop();
    };
  }, [sessionId, clientId]);

  useEffect(() => {
    clientRef.current?.setMuted(muted);
  }, [muted]);

  if (sessionId === null) return null;

  return (
    <div
      role="dialog"
      aria-label="Voice session"
      style={{
        position: "fixed",
        right: "1rem",
        bottom: "1rem",
        width: "min(26rem, calc(100vw - 2rem))",
        maxHeight: "min(28rem, calc(100vh - 2rem))",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        padding: "0.75rem",
        borderRadius: "0.75rem",
        border: "1px solid rgba(127,127,127,0.35)",
        background: "rgba(20,20,22,0.92)",
        color: "#f5f5f5",
        boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
        zIndex: 2147483000,
        fontSize: "0.85rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <strong style={{ flex: 1 }}>Voice session</strong>
        {secondsLeft !== null && (
          <span style={{ opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>
            {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
          </span>
        )}
        <button type="button" onClick={() => setMuted((value) => !value)}>
          {muted ? "Unmute" : "Mute"}
        </button>
        <button type="button" onClick={() => void clientRef.current?.stop()}>
          End
        </button>
      </div>
      {error !== null && (
        <div style={{ color: "#ff9b9b" }} role="alert">
          {error}
        </div>
      )}
      {status === "connecting" && <div style={{ opacity: 0.75 }}>Connecting…</div>}
      <div
        style={{
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "0.35rem",
        }}
      >
        {lines.length === 0 && status === "live" && (
          <div style={{ opacity: 0.6 }}>Listening…</div>
        )}
        {lines.map((line, index) => (
          <div
            key={index}
            style={{
              alignSelf: line.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "85%",
              padding: "0.25rem 0.5rem",
              borderRadius: "0.5rem",
              background: line.role === "user" ? "rgba(80,120,255,0.35)" : "rgba(255,255,255,0.1)",
              whiteSpace: "pre-wrap",
            }}
          >
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "realtime-voice", component: RealtimeVoiceOverlay });
});
