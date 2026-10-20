// The plugin's settings section: connect or disconnect devbox, and the
// Tailscale sign-in links of machines being created, which are the one step
// a person has to take.
//
// It also contributes the Devbox machines nav panel, which shows live usage
// for every instance in the connected project while it is open.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, UsageResult, UsageRow, UsageTotals } from "./server";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Status {
  connected: boolean;
  project: string | null;
  devboxUrl: string;
  signIns: Array<{ machine: string; url: string; since: number }>;
  machines: Array<{ hostId: string; name: string; phase: string; status: string }>;
}

const NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function DevboxSection() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  const refetch = useCallback(() => {
    rpc.call("status").then(
      (s: Status) => {
        setStatus(s);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("connection-changed", refetch);
  useRealtime("signins-changed", refetch);
  useRealtime("machines-changed", refetch);
  // Creation moves through phases the plugin does not signal; poll while
  // anything is still on its way.
  const settling = status !== null && status.machines.some((m) => m.phase !== "active" || m.status !== "connected");
  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(refetch, 5000);
    return () => clearInterval(timer);
  }, [settling, refetch]);

  const open = (url: string) => {
    if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
  };

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await rpc.call("connect");
      open(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await rpc.call("disconnect");
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const trimmed = name.trim();
  const nameOk = trimmed === "" || NAME_PATTERN.test(trimmed);
  const create = async () => {
    setBusy(true);
    try {
      await rpc.call("createMachine", trimmed === "" ? {} : { name: trimmed });
      setName("");
      setError(null);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (status === null) {
    return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  }

  return (
    <div className="flex flex-col gap-4 text-sm">
      {status.connected ? (
        <div className="flex items-center justify-between gap-4">
          <p>
            Connected{status.project ? (
              <>
                {" "}to project <code>{status.project}</code>
              </>
            ) : null}
            .
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground">
            Connect your devbox project so bb can create machines in it. You approve it on devbox.
          </p>
          <Button size="sm" disabled={busy} onClick={() => void connect()}>
            Connect devbox
          </Button>
        </div>
      )}

      {status.connected ? (
        <div className="flex flex-col gap-2">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (nameOk) void create();
            }}
          >
            <input
              className="h-8 flex-1 rounded-md border border-border bg-transparent px-2 text-sm"
              placeholder="Machine name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!nameOk}
            />
            <Button size="sm" type="submit" disabled={busy || !nameOk}>
              Create machine
            </Button>
          </form>
          {!nameOk ? (
            <p className="text-xs text-destructive">Lowercase letters, digits and dashes, starting with a letter.</p>
          ) : null}
          {status.machines.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {status.machines.map((m) => (
                <li key={m.hostId} className="flex items-center justify-between gap-4">
                  <code>{m.name}</code>
                  <span className="text-muted-foreground">
                    {m.phase === "active" ? m.status : m.phase}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {status.signIns.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="font-medium">Waiting for you to sign in to Tailscale</p>
          {status.signIns.map((s) => (
            <div key={s.machine} className="flex items-center justify-between gap-4">
              <code>{s.machine}</code>
              <Button size="sm" onClick={() => open(s.url)}>
                Sign in
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {error !== null ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

// ---- Devbox machines page ------------------------------------------------

const POLL_MS = 5000;
// Roughly two and a half minutes of history at the poll interval.
const HISTORY_LENGTH = 30;

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// A small inline sparkline. Values are already a percentage of `max`, so the
// chart keeps a fixed 0–100 axis instead of rescaling to the window's peak.
function Sparkline({ values, max, className }: { values: number[]; max: number; className?: string }) {
  if (values.length < 2) {
    return <div className={cn("h-8 w-full rounded bg-muted/40", className)} aria-hidden="true" />;
  }
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 100 - Math.max(0, Math.min(1, value / max)) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className={cn("h-8 w-full", className)}
      aria-hidden="true"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Meter({ used, total, label }: { used: number | null; total: number | null; label: string }) {
  const percent = used !== null && total !== null && total > 0 ? Math.min(100, (used / total) * 100) : null;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono tabular-nums">
          {formatBytes(used)} / {formatBytes(total)}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground/70" style={{ width: `${percent ?? 0}%` }} />
      </div>
    </div>
  );
}

function MachineCard({ row, cpuHistory, memHistory }: { row: UsageRow; cpuHistory: number[]; memHistory: number[] }) {
  const stopped = row.status !== "Running";
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn("size-2 shrink-0 rounded-full", stopped ? "bg-muted-foreground/40" : "bg-emerald-500")}
            aria-hidden="true"
          />
          <span className="truncate font-medium">{row.name}</span>
          {row.bb ? (
            <span className="shrink-0 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300">
              bb
            </span>
          ) : null}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{row.status}</span>
      </div>

      {stopped ? (
        <p className="text-xs text-muted-foreground">Stopped — only disk is reported.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex items-baseline justify-between text-xs text-muted-foreground">
              <span>CPU</span>
              <span className="font-mono tabular-nums">{formatPercent(row.cpuPercent)}</span>
            </div>
            <Sparkline values={cpuHistory} max={100} className="text-blue-600 dark:text-blue-400" />
            <p className="text-[10px] text-muted-foreground">
              {row.cores} {row.cores === 1 ? "core" : "cores"}
            </p>
          </div>
          <div>
            <div className="flex items-baseline justify-between text-xs text-muted-foreground">
              <span>Memory</span>
              <span className="font-mono tabular-nums">{formatBytes(row.memoryUsed)}</span>
            </div>
            <Sparkline values={memHistory} max={100} className="text-emerald-600 dark:text-emerald-400" />
            <p className="text-[10px] text-muted-foreground">
              of {formatBytes(row.memoryTotal)}
              {row.memoryTotalSource === "limit" ? " (limit)" : ""}
            </p>
          </div>
        </div>
      )}

      <Meter used={row.diskUsed} total={row.diskTotal} label="Disk" />

      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Net ↓ {formatBytes(row.networkIn)}</span>
        <span>Net ↑ {formatBytes(row.networkOut)}</span>
        {!stopped ? <span>Up {formatUptime(row.uptimeSeconds)}</span> : null}
        {!stopped && row.processes !== null ? <span>{row.processes} proc</span> : null}
      </div>
    </div>
  );
}

function AllocationBar({ totals }: { totals: UsageTotals }) {
  const items: Array<{ key: string; label: string; value: UsageTotals["cpu"]; format: (value: number) => string }> = [
    { key: "cpu", label: "CPU", value: totals.cpu, format: (value) => `${value} ${value === 1 ? "core" : "cores"}` },
    { key: "memory", label: "Memory", value: totals.memory, format: formatBytes },
    { key: "disk", label: "Disk", value: totals.disk, format: formatBytes },
    { key: "instances", label: "Machines", value: totals.instances, format: (value) => `${value}` },
  ];
  return (
    <section aria-label="Project allocation" className="rounded-lg border border-border bg-card p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-medium">Project allocation</h2>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Allocated</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(({ key, label, value, format }) => {
          const percent = value !== null && value.limit > 0 ? Math.min(100, (value.usage / value.limit) * 100) : null;
          return (
            <div key={key}>
              <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                <span>{label}</span>
                <span className="font-mono tabular-nums">
                  {value === null ? "—" : `${format(value.usage)} / ${format(value.limit)}`}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-foreground/70" style={{ width: `${percent ?? 0}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Incus reports the sum of the instances' configured limits, not live usage.
      </p>
    </section>
  );
}

function MachinesPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<UsageResult | null>(null);
  const [history, setHistory] = useState<Record<string, { cpu: number[]; mem: number[] }>>({});
  const [error, setError] = useState<string | null>(null);

  // Poll while the page is open; the timer clears on unmount, so nothing
  // keeps polling after the developer leaves the page.
  useEffect(() => {
    let active = true;
    let inFlight = false;
    const load = () => {
      if (inFlight) return;
      inFlight = true;
      rpc.call("usage").then(
        (next) => {
          inFlight = false;
          if (!active) return;
          setData(next);
          setError(null);
          // In-memory ring buffers, rebuilt from each poll and dropped on
          // unmount. Nothing is persisted.
          if (next.connected) {
            setHistory((previous) => {
              const updated = { ...previous };
              const names = new Set(next.instances.map((row) => row.name));
              for (const name of Object.keys(updated)) {
                if (!names.has(name)) delete updated[name];
              }
              for (const row of next.instances) {
                const entry = updated[row.name] ?? { cpu: [], mem: [] };
                if (row.cpuPercent !== null) entry.cpu = [...entry.cpu, row.cpuPercent].slice(-HISTORY_LENGTH);
                if (row.memoryUsed !== null && row.memoryTotal !== null && row.memoryTotal > 0) {
                  entry.mem = [...entry.mem, (row.memoryUsed / row.memoryTotal) * 100].slice(-HISTORY_LENGTH);
                }
                updated[row.name] = entry;
              }
              return updated;
            });
          }
        },
        (e: unknown) => {
          inFlight = false;
          if (!active) return;
          setError(e instanceof Error ? e.message : String(e));
        },
      );
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [rpc]);

  if (data === null) {
    return <div className="p-6 text-sm text-muted-foreground">{error ?? "Loading devbox usage…"}</div>;
  }

  if (!data.connected) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-sm">
        <h1 className="text-lg font-semibold">Devbox machines</h1>
        <p className="mt-2 text-muted-foreground">
          devbox is not connected. Open{" "}
          <span className="font-medium text-foreground">Settings → Plugins → Devbox machines</span> and choose{" "}
          <span className="font-medium text-foreground">Connect devbox</span> to see live usage.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 sm:px-6 lg:px-8">
        <header className="mb-5 border-b border-border/70 pb-4">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Incus · project {data.project}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Devbox machines</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live CPU, memory, disk and network for every instance in your devbox project.
          </p>
        </header>

        {data.totals !== null ? (
          <div className="mb-5">
            <AllocationBar totals={data.totals} />
          </div>
        ) : null}

        {data.instances.length === 0 ? (
          <div className="rounded-lg border border-border p-8 text-sm text-muted-foreground">
            No machines in this project yet. Create one from the plugin settings or with{" "}
            <code>bb machine create --provider devbox</code>.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {data.instances.map((row) => (
              <MachineCard
                key={row.name}
                row={row}
                cpuHistory={history[row.name]?.cpu ?? []}
                memHistory={history[row.name]?.mem ?? []}
              />
            ))}
          </div>
        )}

        {error !== null ? <p className="mt-4 text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "devbox",
    title: "devbox",
    description: "Your devbox project, its machines, and any waiting for Tailscale sign-in.",
    component: DevboxSection,
  });
  app.slots.navPanel({
    id: "machines",
    title: "Devbox machines",
    icon: "Server",
    path: "devbox-machines",
    component: MachinesPage,
  });
});
