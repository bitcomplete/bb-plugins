/**
 * The browser half of a Realtime voice session: it opens OpenAI's WebRTC
 * endpoint with the ephemeral secret the server minted, plays the model's
 * audio, keeps a live transcript, and relays the model's tool calls back to
 * the server, which forwards them to the plugin that opened the session.
 *
 * Nothing here knows the plugin's standard key; it only ever sees the
 * short-lived ephemeral secret in `MintedRealtimeSession`.
 *
 * The session config — instructions, tools, voice and the input-transcription
 * model that drives the live transcript — is set once, on the server, in the
 * request that mints the ephemeral secret, so the WebRTC connection inherits
 * it and the overlay never has to send a `session.update`.
 */
import type { MintedRealtimeSession } from "./realtime-shared.js";

export type RealtimeLine = { role: "user" | "assistant"; text: string };
export type RealtimeStatus = "connecting" | "live" | "closed" | "error";

export type RealtimeClientCallbacks = {
  /** Mint the ephemeral secret for this session (the plugin's own route). */
  mint: () => Promise<MintedRealtimeSession>;
  /** Forward one model tool call to the opener; resolves to the tool output string. */
  toolCall: (call: { callId: string; name: string; arguments: string }) => Promise<string>;
  /** Tell the server the session is over. Only called by the client that minted it. */
  close: () => Promise<void>;
  onLine: (line: RealtimeLine) => void;
  onStatus: (status: RealtimeStatus, message?: string) => void;
  onSecondsLeft: (seconds: number) => void;
};

/**
 * Thrown by `mint` when the server says another client already took the
 * session (HTTP 409). The overlay that loses the race drops out quietly
 * without ending the winner's session.
 */
export class RealtimeSessionTakenError extends Error {
  constructor() {
    super("Another client already took this voice session");
    this.name = "RealtimeSessionTakenError";
  }
}

/** OpenAI's GA WebRTC endpoint; the ephemeral secret's session config picks the model. */
export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export class RealtimeSessionClient {
  private readonly callbacks: RealtimeClientCallbacks;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private timer: number | null = null;
  private deadline = 0;
  private stopped = false;
  private ownsSession = false;
  private assistant = "";

  constructor(callbacks: RealtimeClientCallbacks) {
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    try {
      this.callbacks.onStatus("connecting");
      const minted = await this.callbacks.mint();
      // The mint succeeded, so the session exists on the server; from here on
      // this client owns it and must end it, even if it was stopped while the
      // secret was being minted.
      this.ownsSession = true;
      if (this.stopped) {
        await this.endSession();
        return;
      }

      const pc = new RTCPeerConnection();
      this.pc = pc;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audio.style.display = "none";
      document.body.append(audio);
      this.audio = audio;
      pc.addEventListener("track", (event) => {
        const [stream] = event.streams;
        if (stream !== undefined) {
          audio.srcObject = stream;
          void audio.play().catch(() => {});
        }
      });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.stopped) {
        this.stopStream(stream);
        return;
      }
      this.stream = stream;
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
      const channel = pc.createDataChannel("oai-events");
      this.channel = channel;
      channel.addEventListener("message", (event) => this.onMessage(event.data));
      channel.addEventListener("open", () => this.callbacks.onStatus("live"));

      const offer = await pc.createOffer();
      if (this.stopped) return;
      await pc.setLocalDescription(offer);
      if (this.stopped) return;
      const answer = await fetch(REALTIME_CALLS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minted.value}`,
          "content-type": "application/sdp",
        },
        body: offer.sdp ?? "",
      });
      if (this.stopped) return;
      if (!answer.ok) {
        const detail = await answer.text().catch(() => "");
        throw new Error(
          `OpenAI refused the WebRTC offer: HTTP ${answer.status}${detail === "" ? "" : `: ${detail.slice(0, 200)}`}`,
        );
      }
      await pc.setRemoteDescription({ type: "answer", sdp: await answer.text() });
      if (this.stopped) return;
      this.startClock(minted.maxDurationMs);
    } catch (error) {
      if (error instanceof RealtimeSessionTakenError) {
        // Another client won the race for this session. This overlay goes away
        // without ending the winner's session.
        this.stopped = true;
        this.teardown();
        this.callbacks.onStatus("closed");
        return;
      }
      // A stop can race an in-flight WebRTC step and make it reject; that is a
      // teardown, not an error to show.
      if (this.stopped) {
        this.teardown();
        return;
      }
      this.callbacks.onStatus("error", error instanceof Error ? error.message : String(error));
      await this.stop();
    }
  }

  /** Mute or unmute the microphone. */
  setMuted(muted: boolean): void {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.teardown();
    await this.endSession();
    this.callbacks.onStatus("closed");
  }

  /** Close the resources this client opened. Idempotent. */
  private teardown(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.channel?.close();
    } catch {
      // already closed
    }
    this.channel = null;
    try {
      this.pc?.close();
    } catch {
      // already closed
    }
    this.pc = null;
    if (this.stream !== null) {
      this.stopStream(this.stream);
      this.stream = null;
    }
    if (this.audio !== null) {
      this.audio.srcObject = null;
      this.audio.remove();
      this.audio = null;
    }
  }

  private stopStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) track.stop();
  }

  /** End the server session, but only once, and only if this client minted it. */
  private async endSession(): Promise<void> {
    if (!this.ownsSession) return;
    this.ownsSession = false;
    try {
      await this.callbacks.close();
    } catch {
      // the session is ending anyway
    }
  }

  private send(payload: unknown): void {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(payload));
  }

  private startClock(maxMs: number): void {
    this.deadline = Date.now() + maxMs;
    this.callbacks.onSecondsLeft(Math.round(maxMs / 1000));
    this.timer = window.setInterval(() => {
      const left = Math.max(0, Math.round((this.deadline - Date.now()) / 1000));
      this.callbacks.onSecondsLeft(left);
      if (left <= 0) void this.stop();
    }, 1000);
  }

  private onMessage(raw: unknown): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(typeof raw === "string" ? raw : String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof event.type === "string" ? event.type : "";
    switch (type) {
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta !== "") {
          this.assistant += delta;
          this.callbacks.onLine({ role: "assistant", text: this.assistant });
        }
        break;
      }
      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const transcript =
          typeof event.transcript === "string" ? event.transcript : this.assistant;
        this.assistant = "";
        if (transcript !== "") this.callbacks.onLine({ role: "assistant", text: transcript });
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = typeof event.transcript === "string" ? event.transcript : "";
        if (transcript !== "") this.callbacks.onLine({ role: "user", text: transcript });
        break;
      }
      case "response.function_call_arguments.done":
        void this.handleToolCall(event);
        break;
      case "error": {
        const error = event.error;
        const message =
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof (error as { message: unknown }).message === "string"
            ? (error as { message: string }).message
            : "Realtime error";
        this.callbacks.onStatus("error", message);
        break;
      }
    }
  }

  private async handleToolCall(event: Record<string, unknown>): Promise<void> {
    const callId =
      typeof event.call_id === "string"
        ? event.call_id
        : typeof event.item_id === "string"
          ? event.item_id
          : "";
    const name = typeof event.name === "string" ? event.name : "";
    const args = typeof event.arguments === "string" ? event.arguments : "{}";
    let output: string;
    try {
      output = await this.callbacks.toolCall({ callId, name, arguments: args });
    } catch (error) {
      output = JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
    this.send({ type: "response.create" });
  }
}
