// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REALTIME_CALLS_URL,
  REALTIME_STOP_FALLBACK_MS,
  RealtimeSessionClient,
  RealtimeSessionTakenError,
  type RealtimeClientCallbacks,
} from "./realtime-client.js";
import type { MintedRealtimeSession } from "./realtime-shared.js";

const MINTED: MintedRealtimeSession = {
  value: "ek_test",
  expiresAt: 0,
  model: "gpt-realtime",
  voice: "alloy",
  instructions: "Say hi.",
  tools: [],
  maxDurationMs: 20 * 60 * 1000,
  speaksFirst: false,
};

class FakeDataChannel {
  readyState = "open";
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  send(data: string): void {
    this.sent.push(data);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  /** Deliver a channel event to the client, as the real data channel would. */
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  close(): void {
    this.readyState = "closed";
  }
}

class FakePeerConnection {
  static readonly instances: FakePeerConnection[] = [];
  readonly channel = new FakeDataChannel();
  readonly tracks: unknown[] = [];
  readonly createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" }));
  readonly setLocalDescription = vi.fn(async () => {});
  readonly setRemoteDescription = vi.fn(async () => {});
  readonly close = vi.fn(() => {});
  constructor() {
    FakePeerConnection.instances.push(this);
  }
  addEventListener(): void {
    // No track arrives in these tests.
  }
  addTrack(track: unknown): void {
    this.tracks.push(track);
  }
  createDataChannel(): FakeDataChannel {
    return this.channel;
  }
}

function callbacks(overrides: Partial<RealtimeClientCallbacks> = {}): RealtimeClientCallbacks {
  return {
    mint: async () => MINTED,
    toolCall: async () => ({ output: "" }),
    close: async () => {},
    onLine: () => {},
    onStatus: () => {},
    onSecondsLeft: () => {},
    ...overrides,
  };
}

/** Wire the browser media and fetch so a client can reach the data channel. */
function stubConnect(minted: MintedRealtimeSession = MINTED): void {
  const track = { enabled: true, stop: vi.fn() };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => streamOf(track)) } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp", { status: 200 })));
}

function streamOf(track: FakeTrack): MediaStream {
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

type FakeTrack = {
  enabled: boolean;
  stop: ReturnType<typeof vi.fn>;
  getSettings?: () => MediaTrackSettings;
};

beforeEach(() => {
  FakePeerConnection.instances.length = 0;
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RealtimeSessionClient", () => {
  it("does not end a session it did not mint when it loses the 409 race", async () => {
    const close = vi.fn(async () => {});
    const onStatus = vi.fn();
    const client = new RealtimeSessionClient(
      callbacks({
        mint: async () => {
          throw new RealtimeSessionTakenError();
        },
        close,
        onStatus,
      }),
    );

    await client.start();

    expect(close).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("closed");
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
  });

  it("tears down a stop during connect and never opens the session", async () => {
    const track = { enabled: true, stop: vi.fn() };
    let resolveMedia!: (value: MediaStream) => void;
    const media = new Promise<MediaStream>((resolve) => {
      resolveMedia = resolve;
    });
    const getUserMedia = vi.fn(() => media);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response("answer", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const close = vi.fn(async () => {});
    const client = new RealtimeSessionClient(callbacks({ close }));

    const started = client.start();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await client.stop();
    resolveMedia(streamOf(track));
    await started;

    const pc = FakePeerConnection.instances[0]!;
    expect(pc.createOffer).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("asks the microphone for echo cancellation, noise suppression and auto gain control", async () => {
    const track: FakeTrack = { enabled: true, stop: vi.fn(), getSettings: () => ({}) };
    const getUserMedia = vi.fn(async () => streamOf(track));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp", { status: 200 })));
    const client = new RealtimeSessionClient(callbacks());

    await client.start();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await client.stop();
  });

  it("retries once with a plain microphone when the constrained call is overconstrained", async () => {
    const track: FakeTrack = { enabled: true, stop: vi.fn(), getSettings: () => ({}) };
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("overconstrained"), { name: "OverconstrainedError" }))
      .mockResolvedValueOnce(streamOf(track));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const fetchMock = vi.fn(async () => new Response("answer-sdp", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onStatus = vi.fn();
    const client = new RealtimeSessionClient(callbacks({ onStatus }));

    await client.start();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[0]![0]).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(getUserMedia.mock.calls[1]![0]).toEqual({ audio: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());
    await client.stop();
  });

  it("does not retry a microphone error that is not overconstrained", async () => {
    const getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const onStatus = vi.fn();
    const client = new RealtimeSessionClient(callbacks({ onStatus }));

    await client.start();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith("error", "Permission denied");
  });

  it("reports the applied processing settings once at connect", async () => {
    const track: FakeTrack = {
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ echoCancellation: true, noiseSuppression: false }),
    };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => streamOf(track)) } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp", { status: 200 })));
    const onStatus = vi.fn();
    const client = new RealtimeSessionClient(callbacks({ onStatus }));

    await client.start();
    const pc = FakePeerConnection.instances[0]!;
    pc.channel.emit("open", {});

    expect(onStatus).toHaveBeenCalledWith(
      "live",
      "echoCancellation=true noiseSuppression=false autoGainControl=unknown",
    );
    expect(onStatus.mock.calls.filter(([status]) => status === "live")).toHaveLength(1);
    await client.stop();
  });

  it("opens the GA WebRTC endpoint with the ephemeral secret and no session.update", async () => {
    const track = { enabled: true, stop: vi.fn() };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => streamOf(track)) } });
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response("answer-sdp", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new RealtimeSessionClient(callbacks());

    await client.start();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(REALTIME_CALLS_URL);
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer ek_test");
    const pc = FakePeerConnection.instances[0]!;
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer-sdp" });
    // The session config comes from the minted secret; the channel is never
    // used to send a session.update.
    expect(pc.channel.sent).toEqual([]);
    await client.stop();
  });

  it("sends no opening response.create unless the session opts into speaksFirst", async () => {
    stubConnect();
    const client = new RealtimeSessionClient(callbacks());
    await client.start();
    const pc = FakePeerConnection.instances[0]!;
    pc.channel.emit("open", {});
    expect(pc.channel.sent).toEqual([]);
    await client.stop();

    FakePeerConnection.instances.length = 0;
    const speaking = new RealtimeSessionClient(
      callbacks({ mint: async () => ({ ...MINTED, speaksFirst: true }) }),
    );
    await speaking.start();
    const speakingPc = FakePeerConnection.instances[0]!;
    speakingPc.channel.emit("open", {});
    expect(speakingPc.channel.sent).toEqual([JSON.stringify({ type: "response.create" })]);
    await speaking.stop();
  });

  it("stops after the goodbye's audio finishes when a tool reply is last", async () => {
    stubConnect();
    const close = vi.fn(async () => {});
    const toolCall = vi.fn(async () => ({ output: "done", last: true }));
    const client = new RealtimeSessionClient(callbacks({ toolCall, close }));
    await client.start();
    const pc = FakePeerConnection.instances[0]!;
    pc.channel.emit("open", {});
    pc.channel.emit("message", {
      data: JSON.stringify({ type: "response.function_call_arguments.done", response_id: "resp_call", call_id: "c1", name: "end_standup", arguments: "{}" }),
    });
    await vi.waitFor(() => expect(toolCall).toHaveBeenCalled());
    await vi.waitFor(() => expect(pc.channel.sent.some((m) => m.includes("function_call_output"))).toBe(true));
    expect(close).not.toHaveBeenCalled();
    // The response that made the call finishing does not stop the session, and
    // a late event of that response is not mistaken for the goodbye.
    pc.channel.emit("message", { data: JSON.stringify({ type: "response.done", response_id: "resp_call" }) });
    pc.channel.emit("message", { data: JSON.stringify({ type: "response.output_item.done", response_id: "resp_call" }) });
    expect(close).not.toHaveBeenCalled();
    // The goodbye's response.done only arms a fallback; its audio finishing closes.
    pc.channel.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "resp_goodbye" } }) });
    pc.channel.emit("message", { data: JSON.stringify({ type: "response.done", response_id: "resp_goodbye" }) });
    expect(close).not.toHaveBeenCalled();
    pc.channel.emit("message", { data: JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "resp_goodbye" }) });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("does not mistake a late event of the calling response for the goodbye", async () => {
    stubConnect();
    const close = vi.fn(async () => {});
    const toolCall = vi.fn(async () => ({ output: "done", last: true }));
    const client = new RealtimeSessionClient(callbacks({ toolCall, close }));
    await client.start();
    const pc = FakePeerConnection.instances[0]!;
    pc.channel.emit("open", {});
    pc.channel.emit("message", {
      data: JSON.stringify({ type: "response.function_call_arguments.done", response_id: "resp_call", call_id: "c1", name: "end_standup", arguments: "{}" }),
    });
    await vi.waitFor(() => expect(pc.channel.sent.some((m) => m.includes("function_call_output"))).toBe(true));
    // The calling response's own audio-finished signal must not stop the session.
    pc.channel.emit("message", { data: JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "resp_call" }) });
    expect(close).not.toHaveBeenCalled();
    // The goodbye's does.
    pc.channel.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "resp_goodbye" } }) });
    pc.channel.emit("message", { data: JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "resp_goodbye" }) });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("closes on the fallback when the goodbye's audio signal never arrives", async () => {
    vi.useFakeTimers();
    try {
      stubConnect();
      const close = vi.fn(async () => {});
      const toolCall = vi.fn(async () => ({ output: "done", last: true }));
      const client = new RealtimeSessionClient(callbacks({ toolCall, close }));
      await client.start();
      const pc = FakePeerConnection.instances[0]!;
      pc.channel.emit("open", {});
      pc.channel.emit("message", {
        data: JSON.stringify({ type: "response.function_call_arguments.done", response_id: "resp_call", call_id: "c1", name: "end_standup", arguments: "{}" }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(pc.channel.sent.some((m) => m.includes("function_call_output"))).toBe(true);
      pc.channel.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "resp_goodbye" } }) });
      pc.channel.emit("message", { data: JSON.stringify({ type: "response.done", response_id: "resp_goodbye" }) });
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(REALTIME_STOP_FALLBACK_MS);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the session open when a tool reply has no last flag", async () => {
    stubConnect();
    const close = vi.fn(async () => {});
    const toolCall = vi.fn(async () => ({ output: "ok" }));
    const client = new RealtimeSessionClient(callbacks({ toolCall, close }));
    await client.start();
    const pc = FakePeerConnection.instances[0]!;
    pc.channel.emit("open", {});
    pc.channel.emit("message", {
      data: JSON.stringify({ type: "response.function_call_arguments.done", call_id: "c1", name: "echo", arguments: "{}" }),
    });
    await vi.waitFor(() => expect(toolCall).toHaveBeenCalled());
    await vi.waitFor(() => expect(pc.channel.sent.some((m) => m.includes("function_call_output"))).toBe(true));
    pc.channel.emit("message", { data: JSON.stringify({ type: "response.created", response: { id: "resp_2" } }) });
    pc.channel.emit("message", { data: JSON.stringify({ type: "response.done", response_id: "resp_2" }) });
    expect(close).not.toHaveBeenCalled();
    await client.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
