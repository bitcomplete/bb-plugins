import type { ExperimentalAppOverlayProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useMemo, type ReactElement } from "react";
import { updateUiState } from "../bridge";
import { SWITCHED_ON_ATTRIBUTE } from "../constants";
import { buildKeymap } from "../keymap";
import type { SwitchState } from "../types";
import { BridgePublisher } from "./BridgePublisher";
import { Chooser } from "./Chooser";
import { forgetStoredSnapshot } from "./cold-start";
import { CopyCursor } from "./CopyCursor";
import { CopyModeIndicator } from "./CopyModeIndicator";
import { Help } from "./Help";
import { usePluginSettings } from "./hooks";
import { Notices } from "./Notices";
import { PillAnnouncer } from "./PillAnnouncer";
import { PrefixIndicator } from "./PrefixIndicator";
import { useTmuxLookup } from "./tmux-lookup";
import { UiErrorBoundary } from "./UiErrorBoundary";

function markDocument(isSwitchedOn: boolean): void {
  document.documentElement.toggleAttribute(SWITCHED_ON_ATTRIBUTE, isSwitchedOn);
}

// Tells the key handler and the palette commands, which are plain functions,
// whether the plugin is switched on, and marks the page for the rules of
// app.css, which only apply while it is. A layout effect, so that all of them
// know it in the same step in which the bridge is taken away.
function useSwitchState(switchState: SwitchState): void {
  useLayoutEffect(() => {
    updateUiState({ switchState });
    markDocument(switchState === "on");
  }, [switchState]);

  useLayoutEffect(
    () => () => {
      updateUiState({ switchState: "unknown" });
      markDocument(false);
    },
    [],
  );

  // The snapshot names the thread that had the focus when the plugin last
  // saw the window. That is out of date once the plugin has been off.
  useEffect(() => {
    if (switchState === "off") forgetStoredSnapshot();
  }, [switchState]);
}

function switchStateOf(isLoaded: boolean, isEnabled: boolean): SwitchState {
  if (!isLoaded) return "unknown";
  return isEnabled ? "on" : "off";
}

// No key may be handled until the keys are known: the settings have loaded,
// they switch the plugin on, and the server has answered about the tmux
// config, or stock tmux stands in for an answer that did not come. The bridge
// is published only then. While the plugin is switched off, the server is not
// asked and nothing is published or awaited.
export function TmuxOverlay(_props: ExperimentalAppOverlayProps): ReactElement | null {
  const { settings, isLoaded } = usePluginSettings();
  const switchState = switchStateOf(isLoaded, settings.enabled);
  useSwitchState(switchState);
  const { source, reload } = useTmuxLookup(
    switchState === "on",
    settings.tmuxConfigText,
  );
  const keymap = useMemo(
    () => (source === null ? null : buildKeymap(source.config)),
    [source],
  );
  return (
    <>
      {source !== null ? (
        <BridgePublisher
          settings={settings}
          tmux={source.config}
          reloadTmuxConfig={reload}
        />
      ) : null}
      <UiErrorBoundary>
        <Notices />
        <CopyCursor />
        <CopyModeIndicator />
        <PrefixIndicator keymap={keymap} />
        {switchState === "on" ? <PillAnnouncer keymap={keymap} /> : null}
        <Chooser keymap={keymap} />
        <Help settings={settings} keymap={keymap} source={source} />
      </UiErrorBoundary>
    </>
  );
}
