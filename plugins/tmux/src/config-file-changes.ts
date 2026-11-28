import {
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useRef } from "react";
import { CONFIG_FILE_CHANGED } from "./settings";

const CONNECTED = "connected";
const RECONNECTING = "reconnecting";

// Calls onChange when the server part says that another config file was
// chosen, in this bb window or in any other. bb does not send a signal again
// to a window that was not connected when it went out, so a connection that
// comes back counts as a change too. The first connection of a window does
// not: nothing was missed before it. bb only says that it is reconnecting
// after a first connection, so a caller that mounts meanwhile has missed
// what was sent since.
export function useConfigFileChanges(onChange: () => void): void {
  useRealtime(CONFIG_FILE_CHANGED, onChange);
  const connection = useRealtimeConnectionState();
  const handler = useRef(onChange);
  const lastConnection = useRef<string | null>(null);
  const hasConnected = useRef(false);

  useEffect(() => {
    handler.current = onChange;
  });

  useEffect(() => {
    const before = lastConnection.current;
    lastConnection.current = connection;
    if (connection === RECONNECTING) hasConnected.current = true;
    if (connection !== CONNECTED || before === CONNECTED) return;
    if (!hasConnected.current) {
      hasConnected.current = true;
      return;
    }
    handler.current();
  }, [connection]);
}
