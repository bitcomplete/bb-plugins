import type { PluginCommandRegistration } from "@get-bb/plugin-sdk/app";
import { runAction } from "./actions";
import { getUiState, showNotice, updateUiState } from "./bridge";
import { PLUGIN_ID } from "./constants";
import { exitCopyMode } from "./copy-mode";
import { BRIDGE_MISSING_NOTICE } from "./open-thread";
import { ENABLED_LABEL } from "./settings";

const PAUSED_NOTICE =
  "Tmux keys are paused in this window. Run the same command to resume them.";
const RESUMED_NOTICE = "Tmux keys are on again in this window.";
const SWITCHED_OFF_NOTICE = `Tmux keys are off. Turn on "${ENABLED_LABEL}" in the settings of the plugin, or run: bb plugin config ${PLUGIN_ID} set enabled true`;

function togglePaused(): void {
  const paused = !getUiState().paused;
  if (paused) exitCopyMode();
  updateUiState({ paused });
  showNotice(paused ? PAUSED_NOTICE : RESUMED_NOTICE);
}

// A command of the palette stays in the palette while the plugin is switched
// off, and says how to switch it on in the place of what it does. While the
// settings are not known, the plugin may be off, so the command does not run
// then either.
function whenSwitchedOn(run: () => void): () => void {
  return () => {
    const { switchState } = getUiState();
    if (switchState === "off") {
      showNotice(SWITCHED_OFF_NOTICE);
      return;
    }
    if (switchState === "unknown") {
      showNotice(BRIDGE_MISSING_NOTICE);
      return;
    }
    run();
  };
}

export const PALETTE_COMMANDS: readonly PluginCommandRegistration[] = [
  {
    id: "open-thread-chooser",
    title: "Tmux: Open thread chooser",
    run: whenSwitchedOn(() =>
      runAction({ type: "chooser.open", placement: "replace" }),
    ),
  },
  {
    id: "show-keys",
    title: "Tmux: Show keys",
    run: whenSwitchedOn(() => runAction({ type: "help.open" })),
  },
  {
    id: "toggle-paused",
    title: "Tmux: Pause or resume keys in this window",
    run: whenSwitchedOn(togglePaused),
  },
];
