// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REALTIME_CALLS_URL,
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
};

class FakeDataChannel {
  readyState = "open";
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  addEventListener(): void {
    // The tests never deliver a channel message.
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
    toolCall: async () => "",
    close: async () => {},
    onLine: () => {},
    onStatus: () => {},
    onSecondsLeft: () => {},
    ...overrides,
  };
}

function streamOf(track: { enabled: boolean; stop: ReturnType<typeof vi.fn> }): MediaStream {
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

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
});
