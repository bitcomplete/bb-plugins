// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_FILE_CHANGED } from "../settings";
import { stockTmuxConfig, type TmuxConfig } from "../tmux-keymap";
import { VI_STYLE_CONFIG, tmuxConfigOf } from "../tmux-test-support";
import type { ConfigReload } from "../types";
import { TMUX_LOOKUP_LIMIT_MS, useTmuxLookup } from "./tmux-lookup";

interface PendingCall {
  answer: (config: TmuxConfig) => void;
  fail: (error: Error) => void;
}

// signals holds what the hook listens to on each realtime channel, as it
// was at the last render, and connection is what bb reports of its
// connection to the server.
const sdk = vi.hoisted(() => {
  const call = vi.fn();
  return {
    call,
    rpc: { call },
    signals: new Map<string, (payload: unknown) => void>(),
    connection: { current: "connected" },
  };
});

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => sdk.rpc,
  useRealtime: (channel: string, handler: (payload: unknown) => void) => {
    sdk.signals.set(channel, handler);
  },
  useRealtimeConnectionState: () => sdk.connection.current,
}));

const VI_STYLE = tmuxConfigOf(VI_STYLE_CONFIG);
const OTHER = tmuxConfigOf("set -g prefix C-s");
const STOCK = { config: stockTmuxConfig(), isFromServer: false };

// The server does not answer until the test says so.
function serverThatWaits(): PendingCall {
  let answer: PendingCall["answer"] = () => {};
  let fail: PendingCall["fail"] = () => {};
  sdk.call.mockReturnValueOnce(
    new Promise<TmuxConfig>((resolve, reject) => {
      answer = resolve;
      fail = reject;
    }),
  );
  return { answer: (value) => answer(value), fail: (error) => fail(error) };
}

interface LookupProps {
  isWanted: boolean;
  configText: string;
}

const NO_CONFIG_TEXT = { configText: "" };

function renderLookup(isWanted: boolean, wrapper?: typeof StrictMode) {
  const view = renderHook(
    (props: LookupProps) => useTmuxLookup(props.isWanted, props.configText),
    { initialProps: { isWanted, ...NO_CONFIG_TEXT }, wrapper },
  );
  let props: LookupProps = { isWanted, ...NO_CONFIG_TEXT };
  const change = (patch: Partial<LookupProps>): void => {
    props = { ...props, ...patch };
    view.rerender(props);
  };
  return {
    ...view,
    rerender: (wanted: boolean) => change({ isWanted: wanted }),
    change,
  };
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function settle(): Promise<void> {
  return wait(0);
}

// What the server part does after another config file was chosen: every bb
// window gets the signal.
async function serverSaysFileChanged(): Promise<void> {
  await act(async () => sdk.signals.get(CONFIG_FILE_CHANGED)?.({}));
}

// What bb does when its connection to the server changes: the hook is drawn
// again with the new state.
async function connectionBecomes(
  state: string,
  redraw: () => void,
): Promise<void> {
  sdk.connection.current = state;
  redraw();
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sdk.call.mockReset();
  sdk.signals.clear();
  sdk.connection.current = "connected";
});

describe("useTmuxLookup while the answer is awaited", () => {
  it("does not ask the server before the settings have loaded", async () => {
    serverThatWaits();
    const { result } = renderLookup(false);

    await wait(TMUX_LOOKUP_LIMIT_MS * 2);

    expect(result.current.source).toBeNull();
    expect(sdk.call).not.toHaveBeenCalled();
  });

  it("asks the server once for the whole tmux config, and knows no keys until it answers", async () => {
    const server = serverThatWaits();
    const { result } = renderLookup(true);

    await settle();

    expect(sdk.call).toHaveBeenCalledExactlyOnceWith("tmuxConfig", null);
    expect(result.current.source).toBeNull();

    await act(async () => server.answer(VI_STYLE));

    expect(result.current.source).toEqual({ config: VI_STYLE, isFromServer: true });
  });

  it("asks once the settings have loaded", async () => {
    const server = serverThatWaits();
    const { result, rerender } = renderLookup(false);
    await settle();
    expect(sdk.call).not.toHaveBeenCalled();

    rerender(true);
    await act(async () => server.answer(VI_STYLE));

    expect(sdk.call).toHaveBeenCalledTimes(1);
    expect(result.current.source?.config).toBe(VI_STYLE);
  });

  it("waits for the answer for 2000 ms, and has no keys in all that time", async () => {
    serverThatWaits();
    const { result } = renderLookup(true);

    await wait(TMUX_LOOKUP_LIMIT_MS - 1);

    expect(TMUX_LOOKUP_LIMIT_MS).toBe(2000);
    expect(result.current.source).toBeNull();
  });

  it("does not ask again on later renders", async () => {
    const server = serverThatWaits();
    const { rerender } = renderLookup(true);
    await act(async () => server.answer(VI_STYLE));

    rerender(true);
    rerender(true);
    await settle();

    expect(sdk.call).toHaveBeenCalledTimes(1);
  });

  it("asks once and still ends the wait in strict mode", async () => {
    sdk.call.mockReturnValue(new Promise<TmuxConfig>(() => {}));
    const { result } = renderLookup(true, StrictMode);

    await wait(TMUX_LOOKUP_LIMIT_MS);

    expect(sdk.call).toHaveBeenCalledTimes(1);
    expect(result.current.source).toEqual(STOCK);
  });

  it("leaves no timer behind when it goes away while it waits", async () => {
    serverThatWaits();
    const { unmount } = renderLookup(true);
    await settle();

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useTmuxLookup when the answer does not come", () => {
  it("uses stock tmux, worked out on the page, after 2000 ms", async () => {
    serverThatWaits();
    const { result } = renderLookup(true);

    await wait(TMUX_LOOKUP_LIMIT_MS);

    expect(result.current.source).toEqual(STOCK);
    expect(result.current.source?.config.files).toEqual([]);
    expect(result.current.source?.config.options.prefix).toBeNull();
    expect(result.current.source?.config.options.modeKeys).toBe("emacs");
  });

  it("adopts an answer that arrives after the 2000 ms", async () => {
    const server = serverThatWaits();
    const { result } = renderLookup(true);
    await wait(TMUX_LOOKUP_LIMIT_MS + 500);
    expect(result.current.source).toEqual(STOCK);

    await act(async () => server.answer(VI_STYLE));

    expect(result.current.source).toEqual({ config: VI_STYLE, isFromServer: true });
  });

  it("uses stock tmux as soon as the call fails, without waiting for the 2000 ms", async () => {
    const server = serverThatWaits();
    const { result } = renderLookup(true);

    await act(async () => server.fail(new Error("no server")));

    expect(result.current.source).toEqual(STOCK);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("uses stock tmux when the call throws instead of returning a promise", async () => {
    sdk.call.mockImplementation(() => {
      throw new Error("rpc is not ready");
    });
    const { result } = renderLookup(true);

    await settle();

    expect(result.current.source).toEqual(STOCK);
  });

  it("stays on stock tmux when the call fails after the 2000 ms", async () => {
    const server = serverThatWaits();
    const { result } = renderLookup(true);
    await wait(TMUX_LOOKUP_LIMIT_MS);
    const standIn = result.current.source;

    await act(async () => server.fail(new Error("too late")));

    expect(result.current.source).toBe(standIn);
  });

  it("keeps an answer that came in time when the 2000 ms have passed", async () => {
    const server = serverThatWaits();
    const { result } = renderLookup(true);
    await act(async () => server.answer(VI_STYLE));

    await wait(TMUX_LOOKUP_LIMIT_MS * 2);

    expect(result.current.source?.config).toBe(VI_STYLE);
  });

  it("does not ask again after a failed call", async () => {
    const server = serverThatWaits();
    const { rerender } = renderLookup(true);
    await act(async () => server.fail(new Error("no server")));

    rerender(true);
    await wait(TMUX_LOOKUP_LIMIT_MS);

    expect(sdk.call).toHaveBeenCalledTimes(1);
  });
});

describe("useTmuxLookup reload", () => {
  it("asks the server again, takes the new config and says that it was read", async () => {
    sdk.call.mockResolvedValueOnce(VI_STYLE).mockResolvedValueOnce(OTHER);
    const { result } = renderLookup(true);
    await settle();
    expect(result.current.source?.config).toBe(VI_STYLE);

    let reload: ConfigReload | undefined;
    await act(async () => {
      reload = await result.current.reload();
    });

    expect(reload).toBe("read");
    expect(sdk.call).toHaveBeenCalledTimes(2);
    expect(sdk.call).toHaveBeenLastCalledWith("tmuxConfig", null);
    expect(result.current.source).toEqual({ config: OTHER, isFromServer: true });
  });

  it("keeps the config it has and says so when the server does not answer", async () => {
    sdk.call
      .mockResolvedValueOnce(VI_STYLE)
      .mockRejectedValueOnce(new Error("no server"));
    const { result } = renderLookup(true);
    await settle();

    let reload: ConfigReload | undefined;
    await act(async () => {
      reload = await result.current.reload();
    });

    expect(reload).toBe("failed");
    expect(result.current.source).toEqual({ config: VI_STYLE, isFromServer: true });
  });

  it.each<[string, Partial<TmuxConfig>]>([
    ["the config file chosen in the plugin's settings", { unreadable: true, namedFile: true }],
    ["one of tmux's own config files", { unreadable: true }],
    ["the Config text setting", { pastedText: "unreadable" }],
  ])(
    "takes the answer and says that it is incomplete when the server could not read %s",
    async (_source, missing) => {
      const answer: TmuxConfig = { ...stockTmuxConfig(), ...missing };
      sdk.call.mockResolvedValueOnce(VI_STYLE).mockResolvedValueOnce(answer);
      const { result } = renderLookup(true);
      await settle();

      let reload: ConfigReload | undefined;
      await act(async () => {
        reload = await result.current.reload();
      });

      expect(reload).toBe("incomplete");
      expect(result.current.source).toEqual({ config: answer, isFromServer: true });
    },
  );

  it("replaces the stock tmux that stood in for an answer", async () => {
    sdk.call
      .mockRejectedValueOnce(new Error("no server"))
      .mockResolvedValueOnce(VI_STYLE);
    const { result } = renderLookup(true);
    await settle();
    expect(result.current.source).toEqual(STOCK);

    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.source).toEqual({ config: VI_STYLE, isFromServer: true });
  });

  it("does not let the late answer to the first question replace the answer to a newer one", async () => {
    const first = serverThatWaits();
    sdk.call.mockResolvedValueOnce(OTHER);
    const { result } = renderLookup(true);
    await wait(TMUX_LOOKUP_LIMIT_MS);

    await act(async () => {
      await result.current.reload();
    });
    await act(async () => first.answer(VI_STYLE));

    expect(result.current.source?.config).toBe(OTHER);
  });

  it("is the same function from one render to the next", async () => {
    sdk.call.mockResolvedValue(VI_STYLE);
    const { result, rerender } = renderLookup(true);
    await settle();
    const { reload } = result.current;

    rerender(true);

    expect(result.current.reload).toBe(reload);
  });
});

describe("useTmuxLookup when the Config text setting changes", () => {
  it("asks again when the text changes, and takes the new answer", async () => {
    sdk.call.mockResolvedValueOnce(VI_STYLE).mockResolvedValueOnce(OTHER);
    const { result, change } = renderLookup(true);
    await settle();
    expect(result.current.source?.config).toBe(VI_STYLE);

    change({ configText: "bind -r H resize-pane -L 5" });
    await settle();

    expect(sdk.call).toHaveBeenCalledTimes(2);
    expect(sdk.call).toHaveBeenLastCalledWith("tmuxConfig", null);
    expect(result.current.source).toEqual({ config: OTHER, isFromServer: true });
  });

  it("asks again when the setting is emptied", async () => {
    sdk.call.mockResolvedValue(VI_STYLE);
    const { change } = renderLookup(true);
    change({ configText: "set -g mouse on" });
    await settle();
    expect(sdk.call).toHaveBeenCalledTimes(2);

    change({ configText: "" });
    await settle();

    expect(sdk.call).toHaveBeenCalledTimes(3);
  });

  it("never hands the server the text, which the server reads itself", async () => {
    sdk.call.mockResolvedValue(VI_STYLE);
    const { change } = renderLookup(true);

    change({ configText: "set -g mouse on" });
    await settle();

    expect(sdk.call.mock.calls).toEqual([
      ["tmuxConfig", null],
      ["tmuxConfig", null],
    ]);
  });

  it("keeps the keys it has while the new answer is awaited", async () => {
    sdk.call.mockResolvedValueOnce(VI_STYLE);
    const { result, change } = renderLookup(true);
    await settle();
    const server = serverThatWaits();

    change({ configText: "set -g prefix C-s" });
    await wait(TMUX_LOOKUP_LIMIT_MS * 2);

    expect(result.current.source).toEqual({ config: VI_STYLE, isFromServer: true });

    await act(async () => server.answer(OTHER));

    expect(result.current.source).toEqual({ config: OTHER, isFromServer: true });
  });

  it("keeps the keys it has when the server does not answer the new question", async () => {
    sdk.call
      .mockResolvedValueOnce(VI_STYLE)
      .mockRejectedValueOnce(new Error("no server"));
    const { result, change } = renderLookup(true);
    await settle();

    change({ configText: "set -g mouse on" });
    await settle();

    expect(result.current.source).toEqual({ config: VI_STYLE, isFromServer: true });
  });

  it("does not let the answer to the question before the change replace the answer after it", async () => {
    const first = serverThatWaits();
    sdk.call.mockResolvedValueOnce(OTHER);
    const { result, change } = renderLookup(true);
    await settle();

    change({ configText: "set -g prefix C-s" });
    await settle();
    await act(async () => first.answer(VI_STYLE));

    expect(result.current.source?.config).toBe(OTHER);
  });

  it("does not ask again when the same text is given once more", async () => {
    sdk.call.mockResolvedValue(VI_STYLE);
    const { change } = renderLookup(true);
    change({ configText: "set -g mouse on" });
    await settle();

    change({ configText: "set -g mouse on" });
    await settle();

    expect(sdk.call).toHaveBeenCalledTimes(2);
  });

  it("asks nothing for a change that is made while the config is not wanted", async () => {
    const { result, change } = renderLookup(false);

    change({ configText: "set -g mouse on" });
    await wait(TMUX_LOOKUP_LIMIT_MS * 2);

    expect(sdk.call).not.toHaveBeenCalled();
    expect(result.current.source).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useTmuxLookup when another config file is chosen", () => {
  it("listens on the one channel on which the server part says so", () => {
    renderLookup(true);

    expect(CONFIG_FILE_CHANGED).toBe("config-file-changed");
    expect([...sdk.signals.keys()]).toEqual([CONFIG_FILE_CHANGED]);
  });

  it("asks again when the server says so, and takes the new answer", async () => {
    sdk.call.mockResolvedValueOnce(VI_STYLE).mockResolvedValueOnce(OTHER);
    const { result } = renderLookup(true);
    await settle();
    expect(result.current.source?.config).toBe(VI_STYLE);

    await serverSaysFileChanged();

    expect(sdk.call.mock.calls).toEqual([
      ["tmuxConfig", null],
      ["tmuxConfig", null],
    ]);
    expect(result.current.source).toEqual({ config: OTHER, isFromServer: true });
  });

  it("asks again every time the server says so, also for the same file", async () => {
    sdk.call.mockResolvedValue(VI_STYLE);
    renderLookup(true);
    await settle();

    await serverSaysFileChanged();
    await serverSaysFileChanged();

    expect(sdk.call).toHaveBeenCalledTimes(3);
  });

  it("keeps the keys it has while the new answer is awaited", async () => {
    sdk.call.mockResolvedValueOnce(VI_STYLE);
    const { result } = renderLookup(true);
    await settle();
    const server = serverThatWaits();

    await serverSaysFileChanged();
    await wait(TMUX_LOOKUP_LIMIT_MS * 2);

    expect(result.current.source).toEqual({ config: VI_STYLE, isFromServer: true });

    await act(async () => server.answer(OTHER));

    expect(result.current.source).toEqual({ config: OTHER, isFromServer: true });
  });

  it("keeps the keys it has when the server does not answer the new question", async () => {
    sdk.call
      .mockResolvedValueOnce(VI_STYLE)
      .mockRejectedValueOnce(new Error("no server"));
    const { result } = renderLookup(true);
    await settle();

    await serverSaysFileChanged();

    expect(result.current.source).toEqual({ config: VI_STYLE, isFromServer: true });
  });

  it("does not let the answer to the question before the choice replace the answer after it", async () => {
    const first = serverThatWaits();
    sdk.call.mockResolvedValueOnce(OTHER);
    const { result } = renderLookup(true);
    await settle();

    await serverSaysFileChanged();
    await act(async () => first.answer(VI_STYLE));

    expect(result.current.source?.config).toBe(OTHER);
  });

  it("asks nothing while the config is not wanted, and asks once it is", async () => {
    sdk.call.mockResolvedValue(VI_STYLE);
    const { result, rerender } = renderLookup(false);

    await serverSaysFileChanged();
    await wait(TMUX_LOOKUP_LIMIT_MS * 2);

    expect(sdk.call).not.toHaveBeenCalled();
    expect(result.current.source).toBeNull();

    rerender(true);
    await settle();

    expect(sdk.call).toHaveBeenCalledTimes(1);
    expect(result.current.source?.config).toBe(VI_STYLE);
  });

  it("asks again when the connection to the server comes back, because a signal sent meanwhile is lost", async () => {
    sdk.call.mockResolvedValueOnce(VI_STYLE).mockResolvedValueOnce(OTHER);
    const { result, rerender } = renderLookup(true);
    await settle();

    await connectionBecomes("reconnecting", () => rerender(true));
    expect(sdk.call).toHaveBeenCalledTimes(1);

    await connectionBecomes("connected", () => rerender(true));

    expect(sdk.call).toHaveBeenCalledTimes(2);
    expect(result.current.source).toEqual({ config: OTHER, isFromServer: true });
  });

  it("asks once when the window connects for the first time", async () => {
    sdk.call.mockResolvedValue(VI_STYLE);
    sdk.connection.current = "connecting";
    const { rerender } = renderLookup(true);
    await settle();

    await connectionBecomes("connected", () => rerender(true));

    expect(sdk.call).toHaveBeenCalledTimes(1);
  });

  it("asks again when the connection comes back for a lookup that started while bb was reconnecting", async () => {
    sdk.call.mockResolvedValueOnce(VI_STYLE).mockResolvedValueOnce(OTHER);
    sdk.connection.current = "reconnecting";
    const { result, rerender } = renderLookup(true);
    await settle();
    expect(sdk.call).toHaveBeenCalledTimes(1);

    await connectionBecomes("connected", () => rerender(true));

    expect(sdk.call).toHaveBeenCalledTimes(2);
    expect(result.current.source).toEqual({ config: OTHER, isFromServer: true });
  });

  it("asks once in strict mode, which runs every effect twice", async () => {
    sdk.call.mockResolvedValue(VI_STYLE);
    renderLookup(true, StrictMode);

    await settle();

    expect(sdk.call).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when the connection comes back while the config is not wanted", async () => {
    const { rerender } = renderLookup(false);
    await connectionBecomes("reconnecting", () => rerender(false));

    await connectionBecomes("connected", () => rerender(false));

    expect(sdk.call).not.toHaveBeenCalled();
  });
});

describe("useTmuxLookup when the config is no longer wanted", () => {
  it("has no keys from the same render on, and waits for nothing", async () => {
    sdk.call.mockResolvedValueOnce(VI_STYLE);
    const { result, rerender } = renderLookup(true);
    await settle();
    expect(result.current.source?.config).toBe(VI_STYLE);

    rerender(false);

    expect(result.current.source).toBeNull();
    await wait(TMUX_LOOKUP_LIMIT_MS * 2);
    expect(result.current.source).toBeNull();
    expect(sdk.call).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the wait for the first answer without stock tmux standing in", async () => {
    serverThatWaits();
    const { result, rerender } = renderLookup(true);
    await wait(TMUX_LOOKUP_LIMIT_MS - 1);

    rerender(false);
    await wait(TMUX_LOOKUP_LIMIT_MS * 2);

    expect(result.current.source).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops an answer that arrives afterwards", async () => {
    const server = serverThatWaits();
    const { result, rerender } = renderLookup(true);
    await settle();
    rerender(false);

    await act(async () => server.answer(VI_STYLE));

    expect(result.current.source).toBeNull();

    serverThatWaits();
    rerender(true);
    await settle();

    expect(result.current.source).toBeNull();
  });

  it("does not let stock tmux stand in for a call that fails afterwards", async () => {
    const server = serverThatWaits();
    const { result, rerender } = renderLookup(true);
    await settle();
    rerender(false);

    await act(async () => server.fail(new Error("no server")));

    expect(result.current.source).toBeNull();

    serverThatWaits();
    rerender(true);
    await settle();

    expect(result.current.source).toBeNull();
  });

  it("asks again once the config is wanted again, and knows no keys until the server answers", async () => {
    sdk.call.mockResolvedValueOnce(VI_STYLE);
    const { result, rerender } = renderLookup(true);
    await settle();
    rerender(false);
    const server = serverThatWaits();

    rerender(true);
    await settle();

    expect(sdk.call).toHaveBeenCalledTimes(2);
    expect(result.current.source).toBeNull();

    await act(async () => server.answer(OTHER));

    expect(result.current.source).toEqual({ config: OTHER, isFromServer: true });
  });

  it("lets stock tmux stand in again after 2000 ms without an answer to the new question", async () => {
    sdk.call.mockResolvedValueOnce(VI_STYLE);
    const { result, rerender } = renderLookup(true);
    await settle();
    rerender(false);
    serverThatWaits();

    rerender(true);
    await wait(TMUX_LOOKUP_LIMIT_MS - 1);
    expect(result.current.source).toBeNull();

    await wait(1);
    expect(result.current.source).toEqual(STOCK);
  });
});

