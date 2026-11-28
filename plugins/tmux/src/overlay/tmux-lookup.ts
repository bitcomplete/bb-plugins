import { useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfigFileChanges } from "../config-file-changes";
import { PLUGIN_ID } from "../constants";
import type { rpcContract } from "../contract";
import type { TmuxSource } from "../keymap";
import { stockTmuxConfig, wasAllRead } from "../tmux-keymap";
import type { ConfigReload } from "../types";

export interface TmuxLookupState {
  source: TmuxSource | null;
  reload: () => Promise<ConfigReload>;
}

export const TMUX_LOOKUP_LIMIT_MS = 2000;

function stockSource(): TmuxSource {
  return { config: stockTmuxConfig(), isFromServer: false };
}

// Asks the server for the tmux config while it is wanted: once it becomes
// wanted, again whenever configText changes, and again when the server says
// that another config file was chosen. configText is the Config text
// setting. The server reads it and the chosen file itself, so here both only
// say that its last answer is out of date. source is null while the config
// is not wanted and while the first answer is awaited. The wait ends after
// TMUX_LOOKUP_LIMIT_MS or with a failed call, stock tmux then stands in, and
// an answer that arrives later still replaces it. reload asks again and says
// whether the server answered, and whether its answer leaves out a source
// that could not be read. An answer to an older question never replaces a
// newer one, and an answer that arrives when the config is no longer wanted
// is dropped.
export function useTmuxLookup(
  isWanted: boolean,
  configText: string,
): TmuxLookupState {
  const rpc = useRpc<typeof rpcContract>();
  const [source, setSource] = useState<TmuxSource | null>(null);
  const [isWaiting, setIsWaiting] = useState(false);
  const askedWith = useRef<string | null>(null);
  const latestRequest = useRef(0);

  const reload = useCallback(async (): Promise<ConfigReload> => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    try {
      const config = await rpc.call("tmuxConfig", null);
      if (request === latestRequest.current) {
        setSource({ config, isFromServer: true });
      }
      return wasAllRead(config) ? "read" : "incomplete";
    } catch (error) {
      console.warn(`[${PLUGIN_ID}] reading the tmux config failed`, error);
      if (request === latestRequest.current) {
        setSource((current) => current ?? stockSource());
      }
      return "failed";
    }
  }, [rpc]);

  useEffect(() => {
    if (!isWanted) {
      askedWith.current = null;
      latestRequest.current += 1;
      setSource(null);
      setIsWaiting(false);
      return;
    }
    if (askedWith.current === configText) return;
    askedWith.current = configText;
    setIsWaiting(true);
    void reload();
  }, [isWanted, configText, reload]);

  useConfigFileChanges(() => {
    if (isWanted) void reload();
  });

  useEffect(() => {
    if (!isWaiting || source !== null) return;
    const timer = setTimeout(() => {
      setSource((current) => current ?? stockSource());
    }, TMUX_LOOKUP_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [isWaiting, source]);

  return useMemo(
    () => ({ source: isWanted ? source : null, reload }),
    [isWanted, source, reload],
  );
}
