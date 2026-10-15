// The Watches settings section: every watch on this server, the busiest and
// the ones that stand out first, and what the doorbell stream is doing. A
// debugging view: it answers "why did my thread never wake" and "what is
// re-reading Linear every ten minutes" at a glance. The github-watcher plugin has
// the same component over the same view shape; a change here belongs there.
import { useCallback, useEffect, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ago, until } from "../format-time";
import type { UsageView, WatchView } from "../usage";

/** The view is re-read this often so ages and the stream's silence stay honest between signals. */
const REFRESH_MS = 30_000;

type Rpc = {
  call(method: "watches", input: null): Promise<UsageView>;
  call(method: "unwatch", input: { threadId: string; targetId: string }): Promise<{ removed: boolean }>;
};

export function WatchesSection(props: { changedChannel: string; targetLabel: string }) {
  const rpc = useRpc() as unknown as Rpc;
  const navigate = useBbNavigate();
  const [view, setView] = useState<UsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refetch = useCallback(() => {
    rpc.call("watches", null).then(
      (v) => {
        setView(v);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useEffect(() => {
    const timer = setInterval(refetch, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refetch]);
  useRealtime(props.changedChannel, refetch);

  const stop = async (w: WatchView) => {
    setBusy(`${w.threadId}/${w.target.id}`);
    try {
      await rpc.call("unwatch", { threadId: w.threadId, targetId: w.target.id });
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const open = (url: string) => {
    if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
  };

  if (view === null) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;

  const nearLimit = view.threads.filter((t) => t.nearLimit);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <HooksLine view={view} />
      {view.watches.length === 0 ? (
        <p className="text-muted-foreground">No thread is watching anything. A thread watches with the agent tool when it has nothing to do until a ticket moves.</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            {view.watches.length} {view.watches.length === 1 ? "watch" : "watches"} across {view.threads.length} {view.threads.length === 1 ? "thread" : "threads"}. Each is re-read every ten
            minutes and on every doorbell; a watch not woken in {Math.round(view.ttlMs / 86_400_000)} days is forgotten. Problems sort first.
          </p>
          {nearLimit.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {nearLimit.map((t) => (
                <li key={t.threadId} className="text-amber-600 dark:text-amber-400">
                  <button type="button" className="underline-offset-2 hover:underline" onClick={() => navigate.toThread(t.threadId)}>
                    {t.title ?? t.threadId}
                  </button>{" "}
                  watches {t.count} of {view.limit}: near the limit, probably watching an epic rather than waiting on one {props.targetLabel}.
                </li>
              ))}
            </ul>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">{props.targetLabel}</th>
                  <th className="py-1 pr-3 font-medium">Thread</th>
                  <th className="py-1 pr-3 font-medium">Age</th>
                  <th className="py-1 pr-3 font-medium text-right">Checks</th>
                  <th className="py-1 pr-3 font-medium text-right">Wakes</th>
                  <th className="py-1 pr-3 font-medium">Last woke</th>
                  <th className="py-1 pr-3 font-medium">Expires</th>
                  <th className="py-1 pr-3 font-medium">Flags</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {view.watches.map((w) => {
                  const id = `${w.threadId}/${w.target.id}`;
                  return (
                    <tr key={id} className="border-t border-border/60 align-top">
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {w.target.url !== null ? (
                          <button type="button" className="font-mono underline-offset-2 hover:underline" title={w.target.title ?? undefined} onClick={() => open(w.target.url!)}>
                            {w.target.key}
                          </button>
                        ) : (
                          <span className="font-mono" title={w.target.title ?? undefined}>
                            {w.target.key}
                          </span>
                        )}
                        {w.state !== null ? <span className="ml-2 text-xs text-muted-foreground">{w.state}</span> : null}
                      </td>
                      <td className="py-1.5 pr-3 max-w-64 truncate">
                        <button type="button" className="underline-offset-2 hover:underline" title={w.threadId} onClick={() => navigate.toThread(w.threadId)}>
                          {w.threadTitle ?? w.threadId}
                        </button>
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">{ago(w.createdAt, view.now)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums" title={`last checked ${ago(w.lastCheckedAt, view.now)} ago`}>
                        {w.checks}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums whitespace-nowrap">
                        {w.wakes}
                        {w.wakesInWindow > 0 ? <span className="text-muted-foreground"> ({w.wakesInWindow}/h)</span> : null}
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">{w.lastWokeAt === 0 ? "never" : `${ago(w.lastWokeAt, view.now)} ago`}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap tabular-nums">{until(w.expiresAt, view.now)}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {w.flags.map((f) => (
                          <Flag key={f} flag={f} />
                        ))}
                      </td>
                      <td className="py-1 text-right">
                        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void stop(w)}>
                          Stop
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {error !== null ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

const FLAG_TITLES: Record<WatchView["flags"][number], string> = {
  idle: "Old and not woken in days: a wait somebody forgot, still read every ten minutes.",
  noisy: "Woken often in the last hour: this is restarting the thread's turn again and again.",
  expiring: "Forgotten within a day unless it wakes or the thread asks again.",
};

function Flag({ flag }: { flag: WatchView["flags"][number] }) {
  return (
    <span
      title={FLAG_TITLES[flag]}
      className={cn(
        "mr-1 inline-block rounded px-1.5 py-0.5 text-xs",
        flag === "noisy" && "bg-red-500/15 text-red-700 dark:text-red-300",
        flag === "idle" && "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        flag === "expiring" && "bg-muted text-muted-foreground",
      )}
    >
      {flag}
    </span>
  );
}

function HooksLine({ view }: { view: UsageView }) {
  const h = view.hooks;
  if (!h.configured) {
    return (
      <p className="text-muted-foreground">
        <Dot tone="off" /> Doorbells unavailable: this server has no bb-gate-hooks service (BB_HOOKS_URL is not set), so threads cannot watch.
      </p>
    );
  }
  const tone = h.state === "connected" ? (h.leased ? "ok" : "warn") : h.state === "connecting" ? "warn" : "off";
  const label = h.state === "connected" ? (h.leased ? "Doorbell stream connected and leased" : "Doorbell stream connected, leases pending") : h.state === "connecting" ? "Doorbell stream reconnecting; checks fall back to a sweep every two minutes" : "Doorbell stream stopped";
  const minutes = Math.round(h.windowMs / 60_000);
  return (
    <p>
      <Dot tone={tone} /> {label} for {ago(h.since, view.now)}.{" "}
      <span className="text-muted-foreground">
        {h.doorbells} {h.doorbells === 1 ? "doorbell" : "doorbells"} and {h.sweeps} {h.sweeps === 1 ? "sweep" : "sweeps"} in the last {minutes} min; last sweep {h.lastSweepAt === 0 ? "never" : `${ago(h.lastSweepAt, view.now)} ago`}
        {h.lastSweepReason !== null ? ` (${h.lastSweepReason})` : ""}.
      </span>
    </p>
  );
}

function Dot({ tone }: { tone: "ok" | "warn" | "off" }) {
  return <span className={cn("mr-1 inline-block size-2 rounded-full align-middle", tone === "ok" && "bg-emerald-500", tone === "warn" && "bg-amber-500", tone === "off" && "bg-muted-foreground/50")} />;
}
