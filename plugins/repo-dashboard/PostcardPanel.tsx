import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { type Event, type InProgress, type Result, type SnapshotResult, type rpcContract } from "./contract.js";
import { postcardCounts, postcardFilename, postcardSvg } from "./postcard.js";

type Org = "parsleyhealth" | "bitcomplete" | "ira-cscc";
type PriorState = { key: string; status: "checking" | "missing" | "loading" | "error" | "ready"; events?: Event[]; error?: string };
type BaselineState = { key: string; status: "checking" | "missing" | "loading" | "error" | "ready"; items?: InProgress[]; error?: string };

function previousWeek(week: string): string {
  const date = new Date(`${week}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString().slice(0, 10);
}

export function Postcard({ org, orgLabel, week, fetchedAt, current, events, inProgress, previousInProgress, inProgressItems, previousInProgressItems }: {
  org: Org; orgLabel: string; week: string; fetchedAt: string; current: boolean; events: Event[];
  inProgress: number; previousInProgress?: number; inProgressItems: InProgress[]; previousInProgressItems?: InProgress[];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const priorWeek = previousWeek(week);
  const baselineWeek = previousWeek(priorWeek);
  const key = `${org}:${priorWeek}`;
  const baselineKey = `${org}:${baselineWeek}`;
  const selection = useRef(key);
  selection.current = key;
  const [prior, setPrior] = useState<PriorState>({ key, status: "checking" });
  const selectedPrior = prior.key === key ? prior : { key, status: "checking" as const };
  const [baseline, setBaseline] = useState<BaselineState>({ key: baselineKey, status: "checking" });
  const selectedBaseline = baseline.key === baselineKey ? baseline : { key: baselineKey, status: "checking" as const };
  useEffect(() => {
    let active = true;
    setPrior({ key, status: "checking" });
    rpc.call("activity_cached", { org, week: priorWeek }).then(
      (result: Result | null) => {
        if (!active || selection.current !== key) return;
        setPrior(result?.ok ? { key, status: "ready", events: result.events }
          : result ? { key, status: "error", error: result.error } : { key, status: "missing" });
      },
      (error: unknown) => { if (active && selection.current === key) setPrior({ key, status: "error", error: error instanceof Error ? error.message : "Could not check previous-week activity." }); },
    );
    return () => { active = false; };
  }, [rpc, org, priorWeek, key]);
  useEffect(() => {
    let active = true;
    setBaseline({ key: baselineKey, status: "checking" });
    rpc.call("in_progress_cached", { org, week: baselineWeek }).then(
      (result: SnapshotResult | null) => {
        if (!active || selection.current !== key) return;
        setBaseline(result?.ok ? { key: baselineKey, status: "ready", items: result.inProgress }
          : result ? { key: baselineKey, status: "error", error: result.error } : { key: baselineKey, status: "missing" });
      },
      (error: unknown) => { if (active && selection.current === key) setBaseline({ key: baselineKey, status: "error", error: error instanceof Error ? error.message : "Could not check Flow baseline." }); },
    );
    return () => { active = false; };
  }, [rpc, org, baselineWeek, baselineKey, key]);
  useEffect(() => {
    selection.current = key;
    return () => { selection.current = ""; };
  }, [key]);
  const loadPrior = (refresh: boolean) => {
    setPrior({ key, status: "loading" });
    rpc.call("activity_get", { org, week: priorWeek, refresh }).then(
      (result) => {
        if (selection.current !== key) return;
        setPrior(result.ok ? { key, status: "ready", events: result.events } : { key, status: "error", error: result.error });
      },
      (error: unknown) => { if (selection.current === key) setPrior({ key, status: "error", error: error instanceof Error ? error.message : "Could not load previous-week activity." }); },
    );
  };
  const loadBaseline = () => {
    setBaseline({ key: baselineKey, status: "loading" });
    rpc.call("in_progress_get", { org, week: baselineWeek, refresh: false }).then(
      (result) => {
        if (selection.current !== key) return;
        setBaseline(result.ok ? { key: baselineKey, status: "ready", items: result.inProgress } : { key: baselineKey, status: "error", error: result.error });
      },
      (error: unknown) => { if (selection.current === key) setBaseline({ key: baselineKey, status: "error", error: error instanceof Error ? error.message : "Could not load Flow baseline." }); },
    );
  };
  const input = { orgLabel, week, fetchedAt, current, events, previousEvents: selectedPrior.events, inProgress, previousInProgress, inProgressItems, previousInProgressItems, flowBaselineItems: selectedBaseline.items };
  const previousReviewsIncomplete = selectedPrior.status === "ready" && postcardCounts(input).previousReviewsIncomplete;
  const svg = useMemo(() => postcardSvg(input),
    [orgLabel, week, fetchedAt, current, events, selectedPrior.events, inProgress, previousInProgress, inProgressItems, previousInProgressItems, selectedBaseline.items]);
  const [previewUrl, setPreviewUrl] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [svg]);
  const filename = postcardFilename(orgLabel, week);
  return <details open className="mb-5 mt-8 border-b border-border pb-6 pt-6 text-xs">
    <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-ring">Week postcard</summary>
    <div className="mt-3 max-w-[720px]">
      {previewUrl && <img src={previewUrl} alt={`${orgLabel} GitHub activity postcard for the week of ${week}`} className="w-full rounded-lg border border-border" />}
      {selectedPrior.status === "missing" || selectedPrior.status === "error" ? <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground"><span>{selectedPrior.status === "error" ? `Previous-week activity unavailable: ${selectedPrior.error}` : "Previous-week activity unavailable."}</span><button type="button" onClick={() => loadPrior(false)} className="rounded border border-border px-2 py-1 font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">Load previous week</button></div> : selectedPrior.status === "loading" ? <p role="status" className="mt-2 text-muted-foreground">Loading previous-week activity…</p> : previousReviewsIncomplete ? <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground"><span>Previous-week review comparison unavailable in saved activity.</span><button type="button" onClick={() => loadPrior(true)} className="rounded border border-border px-2 py-1 font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">Refresh previous week</button></div> : null}
      {selectedBaseline.status === "missing" || selectedBaseline.status === "error" ? <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground"><span>{selectedBaseline.status === "error" ? `Flow baseline unavailable: ${selectedBaseline.error}` : "Flow baseline snapshot unavailable."}</span><button type="button" onClick={loadBaseline} className="rounded border border-border px-2 py-1 font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">Load Flow baseline</button></div> : selectedBaseline.status === "loading" ? <p role="status" className="mt-2 text-muted-foreground">Loading Flow baseline…</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-3"><a href={previewUrl || undefined} download={filename} onClick={(event) => { event.stopPropagation(); if (previewUrl) setMessage(`Download requested: ${filename}`); }} className="rounded border border-border px-3 py-1.5 font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">Download SVG</a><span className="text-muted-foreground">SVG image · weekly activity summary</span></div>
      {message && <p role="status" className="mt-1 text-muted-foreground">{message}</p>}
    </div>
  </details>;
}
