import {
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useComposers,
  useSdk,
  useSidebarSplitLayout,
} from "@get-bb/plugin-sdk/app";
import { useLayoutEffect } from "react";
import { setBridge } from "../bridge";
import type { Settings } from "../settings";
import type { TmuxConfig } from "../tmux-keymap";
import type { ConfigReload } from "../types";
import { useColdStartRepair } from "./cold-start";
import { useKeybindingsSync } from "./keybindings-sync";
import { useSelfCheck } from "./self-check";

interface BridgePublisherProps {
  settings: Settings;
  tmux: TmuxConfig;
  reloadTmuxConfig: () => Promise<ConfigReload>;
}

export function BridgePublisher({
  settings,
  tmux,
  reloadTmuxConfig,
}: BridgePublisherProps): null {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const layout = useSidebarSplitLayout();
  const context = useBbContext();
  const { status, threads, projects } = experimental_useSidebarThreads();
  const composers = useComposers();
  const threadsReady = status === "ready";

  useLayoutEffect(() => {
    setBridge({
      navigate,
      sdk,
      layout,
      context,
      threads,
      threadsReady,
      projects,
      composers,
      settings,
      tmux,
      reloadTmuxConfig,
    });
  }, [
    navigate,
    sdk,
    layout,
    context,
    threads,
    threadsReady,
    projects,
    composers,
    settings,
    tmux,
    reloadTmuxConfig,
  ]);

  useLayoutEffect(() => () => setBridge(null), []);

  useKeybindingsSync(sdk);
  useSelfCheck(threadsReady);
  useColdStartRepair({
    navigate,
    layout,
    contextThreadId: context.threadId,
    threads,
    threadsReady,
  });

  return null;
}
