import { ExecutionSettings } from "./src/ui/execution-settings.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, ThreadChat, useBbContext, useBbNavigate, useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./src/contract.js";
import { Dashboard } from "./src/ui/dashboard.js";
import type { DashboardApi } from "./src/ui/types.js";

function SelfImprovePage() {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId } = useBbContext();
  const navigate = useBbNavigate();
  const connection = useRealtimeConnectionState();
  const connectedBefore = useRef(false), previousConnection = useRef(connection);
  const [refreshKey, setRefreshKey] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => { timer.current = null; setRefreshKey(key => key + 1); }, 120);
  }, []);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  useRealtime("self-improve:changed", refresh);
  useEffect(() => {
    if (connection === "connected") {
      if (connectedBefore.current && previousConnection.current !== "connected") refresh();
      connectedBefore.current = true;
    }
    previousConnection.current = connection;
  }, [connection, refresh]);
  const api = useMemo<DashboardApi>(() => ({
    dashboard: input => rpc.call("dashboard", input),
    retest: input => rpc.call("retest", input),
    startChat: input => rpc.call("startChat", input),
    createObjective: input => rpc.call("createObjective", input),
    performance: input => rpc.call("performance", input),
    exportSolution: input => rpc.call("exportSolution", input),
    publishExport: input => rpc.call("publishExport", input),
  }), [rpc]);
  return <><ExecutionSettings refreshKey={refreshKey} onSaved={refresh}/><Dashboard key={projectId ?? "no-project"} api={api} projectId={projectId} refreshKey={refreshKey}
    onOpenThread={id => navigate.toThread(id)}
    renderChat={threadId => <ThreadChat key={threadId} threadId={threadId} variant="compact" layout="contained" permissionPolicy="inherit"/>}/></>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: "self-improve", title: "Self improve", icon: "FlaskConical", path: "self-improve", component: SelfImprovePage });
});
