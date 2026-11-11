/**
 * The browser half of a Realtime voice session: it opens OpenAI's WebRTC
 * endpoint with the ephemeral secret the server minted, plays the model's
 * audio, keeps a live transcript, and relays the model's tool calls back to
 * the server, which forwards them to the plugin that opened the session.
 *
 * Nothing here knows the plugin's standard key; it only ever sees the
 * short-lived ephemeral secret in `MintedRealtimeSession`.
 */
import type { MintedRealtimeSession } from "./realtime-shared.js";

export type RealtimeLine = { role: "user" | "assistant"; text: string };
export type RealtimeStatus = "connecting" | "live" | "closed" | "error";

export type RealtimeClientCallbacks = {
  /** Mint the ephemeral secret for this session (the plugin's own route). */
  mint: () => Promise<MintedRealtimeSession>;
  /** Forward one model tool call to the opener; resolves to the tool output string. */
  toolCall: (call: { callId: string; name: string; arguments: string }) => Promise<string>;
  /** Tell the server the session is over. */
  close: () => Promise<void>;
  onLine: (line: RealtimeLine) => void;
  onStatus: (status: RealtimeStatus, message?: string) => void;
  onSecondsLeft: (seconds: number) => void;
};

/** OpenAI's WebRTC endpoint, with the session's model selected. */
export function realtimeWebRtcUrl(model: string): string {
  return `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

export class RealtimeSessionClient {
  private readonly callbacks: RealtimeClientCallbacks;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private timer: number | null = null;
  private deadline = 0;
  private stopped = false;
  private assistant = "";

  constructor(callbacks: RealtimeClientCallbacks) {
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    try {
      this.callbacks.onStatus("connecting");
      const minted = await this.callbacks.mint();
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
      this.stream = stream;
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
      const channel = pc.createDataChannel("oai-events");
      this.channel = channel;
      channel.addEventListener("message", (event) => this.onMessage(event.data));
      channel.addEventListener("open", () => {
        this.sendSessionUpdate(minted);
        this.callbacks.onStatus("live");
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answer = await fetch(realtimeWebRtcUrl(minted.model), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minted.value}`,
          "content-type": "application/sdp",
        },
        body: offer.sdp ?? "",
      });
      if (!answer.ok) {
        const detail = await answer.text().catch(() => "");
        throw new Error(
          `OpenAI refused the WebRTC offer: HTTP ${answer.status}${detail === "" ? "" : `: ${detail.slice(0, 200)}`}`,
        );
      }
      await pc.setRemoteDescription({ type: "answer", sdp: await answer.text() });
      this.startClock(minted.maxDurationMs);
    } catch (error) {
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
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.channel?.close();
    } catch {
      // already closed
    }
    try {
      this.pc?.close();
    } catch {
      // already closed
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    if (this.audio !== null) {
      this.audio.srcObject = null;
      this.audio.remove();
    }
    try {
      await this.callbacks.close();
    } catch {
      // the session is ending anyway
    }
    this.callbacks.onStatus("closed");
  }

  private send(payload: unknown): void {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(payload));
  }

  private sendSessionUpdate(minted: MintedRealtimeSession): void {
    this.send({
      type: "session.update",
      session: {
        instructions: minted.instructions,
        tools: minted.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
        })),
        audio: { output: { voice: minted.voice } },
      },
    });
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
