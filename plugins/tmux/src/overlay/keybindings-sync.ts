import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import { setKeybindings, type AppKeybinding } from "../bb-commands";
import { PLUGIN_ID, SDK_EVENTS } from "../constants";

async function fetchKeybindings(
  sdk: PluginBrowserBbSdk,
): Promise<readonly AppKeybinding[]> {
  const config = await sdk.system.config();
  return config.keybindings;
}

function subscribeToConfigChanges(
  sdk: PluginBrowserBbSdk,
  onChange: () => void,
): () => void {
  try {
    return sdk.subscribe({
      event: SDK_EVENTS.configChanged,
      callback: onChange,
    });
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] watching bb's keybindings failed`, error);
    return () => {};
  }
}

export function useKeybindingsSync(sdk: PluginBrowserBbSdk): void {
  useEffect(() => {
    let isActive = true;
    let latestRequest = 0;
    const refresh = (): void => {
      latestRequest += 1;
      const request = latestRequest;
      fetchKeybindings(sdk)
        .then((keybindings) => {
          if (!isActive || request !== latestRequest) return;
          setKeybindings(keybindings);
        })
        .catch((error: unknown) => {
          console.warn(`[${PLUGIN_ID}] reading bb's keybindings failed`, error);
        });
    };
    refresh();
    const unsubscribe = subscribeToConfigChanges(sdk, refresh);
    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [sdk]);
}
