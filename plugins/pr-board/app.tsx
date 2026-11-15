import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalBadge,
} from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { BoardState, CalmRow, Stop } from "./board";
import type { rpcContract } from "./server";
import type { ReviewsState } from "./reviews";
import {
  age,
  CalmButton,
  CalmDialog,
  EffortGroup,
  FoldDots,
  Later,
  MINE_SEGMENTS,
  MineRow,
  ReviewersView,
  SizeDot,
  SizeLegend,
  UnitBar,
  minePrs,
  isStartable,
  rowTone,
  type MinePr,
  type MineSegment,
} from "./board-ui";
import {
  REVIEW_SEGMENTS,
  ReviewsView,
  reviewTone,
  type ReviewSegment,
} from "./reviews-ui";
import "./calm.css";

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
function usePrsData() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<BoardState | null>(null);
  const [reviews, setReviews] = useState<ReviewsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const readBoard = useCallback(async () => {
    try {
      const next = await rpc.call("board_get");
      setState(next);
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, [rpc]);
  const readReviews = useCallback(async () => {
    try {
      const next = await rpc.call("reviews_get");
      if (next.kind === "unavailable") {
        setReviews((current) =>
          current?.kind === "available" ? current : next,
        );
        setReviewError(next.reason);
      } else {
        setReviews(next);
        setReviewError(null);
      }
    } catch (cause) {
      setReviewError(message(cause));
    }
  }, [rpc]);
  const refetch = useCallback(() => {
    void readBoard();
    void readReviews();
  }, [readBoard, readReviews]);
  useEffect(() => {
    refetch();
    const poll = window.setInterval(refetch, 30_000);
    const clock = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [refetch]);
  useRealtime("board-changed", refetch);
  const refresh = useCallback(
    async (tab: "mine" | "review") => {
      setRefreshing(true);
      try {
        if (tab === "mine") {
          const next = await rpc.call("board_refresh");
          setState(next);
          setError(null);
        } else {
          const result = await rpc.call("reviews_refresh");
          if (!result.ok)
            setReviewError(result.error ?? "Review refresh failed");
          await readReviews();
        }
      } catch (cause) {
        if (tab === "mine") setError(message(cause));
        else setReviewError(message(cause));
      } finally {
        setRefreshing(false);
      }
    },
    [rpc, readReviews],
  );
  return {
    rpc,
    state,
    reviews,
    error: error ?? state?.lastError ?? null,
    reviewError,
    refreshing,
    now,
    refetch,
    refresh,
  };
}

export function prsBadge({
  onYou,
  toReview,
  agentsAsking,
  overdueReviews,
}: {
  onYou: number;
  toReview: number;
  agentsAsking: number;
  overdueReviews: number;
}): ExperimentalBadge | null {
  const total = onYou + toReview;
  if (total === 0) return null;
  const reasons = [
    agentsAsking
      ? `${agentsAsking} ${agentsAsking === 1 ? "agent waiting" : "agents waiting"}`
      : "",
    overdueReviews
      ? `${overdueReviews} overdue ${overdueReviews === 1 ? "review" : "reviews"} (queued 2+ days)`
      : "",
    total >= 15 ? "high pending count" : "",
  ].filter(Boolean);
  return {
    tone:
      agentsAsking || overdueReviews || total >= 15
        ? "critical"
        : total >= 5
          ? "warning"
          : "neutral",
    label: [`${onYou} on you`, `${toReview} to review`, ...reasons].join(" · "),
  };
}
function usePrsBadge(): ExperimentalBadge | null {
  const { state, reviews, now } = usePrsData();
  const prs = minePrs(state?.view ?? null, state?.markers ?? []);
  const pending =
    reviews?.kind === "available"
      ? reviews.snapshot.items.filter((review) => review.segment === "on-you")
      : [];
  return prsBadge({
    onYou: prs.filter((pr) => pr.segment === "on-you").length,
    toReview: pending.length,
    agentsAsking: prs.filter(
      (pr) => pr.marker?.status === "asking" && pr.marker.question,
    ).length,
    overdueReviews: pending.filter(
      (review) => now - Date.parse(review.item.noticedAt) >= 2 * 86_400_000,
    ).length,
  });
}
function useFolds() {
  const key = `${experimental_usePluginId()}:calm-folds`;
  const [saved, setSaved] = useState<Record<string, boolean>>(() => {
    try {
      return z
        .record(z.string(), z.boolean())
        .parse(JSON.parse(sessionStorage.getItem(key) ?? "{}"));
    } catch {
      return {};
    }
  });
  return {
    folded: (id: string) => saved[id] ?? true,
    toggle: (id: string) =>
      setSaved((current) => {
        const next = { ...current, [id]: !(current[id] ?? true) };
        try {
          sessionStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* Folding still works when storage is unavailable. */
        }
        return next;
      }),
  };
}
type ReviewerOptions = z.infer<(typeof rpcContract)["reviewers_get"]["output"]>;
type PickerLoad =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; rows: ReviewerOptions };
function ReviewerPicker({
  rows,
  login,
  onClose,
  refetch,
}: {
  rows: CalmRow[];
  login: string | null;
  onClose: () => void;
  refetch: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [load, setLoad] = useState<PickerLoad>({ kind: "loading" });
  const [chosen, setChosen] = useState<Map<string, Set<string>>>(new Map());
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    rpc.call("reviewers_get", { keys: rows.map((row) => row.key) }).then(
      (options) => {
        if (!active) return;
        setLoad({ kind: "ready", rows: options });
        setChosen(
          new Map(
            options.map((option) => {
              const targets = login
                ? [login]
                : (rows.find((row) => row.key === option.key)?.review_targets ??
                  []);
              return [
                option.key,
                new Set(
                  option.candidates
                    .filter((candidate) => targets.includes(candidate.login))
                    .map((candidate) => candidate.login),
                ),
              ];
            }),
          ),
        );
      },
      (cause) => {
        if (active) setLoad({ kind: "error", message: message(cause) });
      },
    );
    return () => {
      active = false;
    };
  }, [rows, login, rpc]);
  const requests = rows
    .filter((row) => !sent.has(row.key))
    .flatMap((row) => {
      const reviewers = [...(chosen.get(row.key) ?? [])];
      return reviewers.length ? [{ key: row.key, reviewers }] : [];
    });
  const send = async () => {
    if (busy || !requests.length) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("reviewers_request", { requests });
      setSent((current) => new Set([...current, ...result.sent]));
      refetch();
      setNotice(
        `${result.sent.length} review ${result.sent.length === 1 ? "request" : "requests"} sent.${result.skipped.length ? ` ${result.skipped.map((skip) => `#${skip.key.split("#").pop()}: ${skip.reason}`).join(" · ")}` : ""}`,
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <CalmDialog
      title="Ask for review"
      description="Choose eligible reviewers, then send the requests to GitHub."
      onClose={onClose}
      busy={busy}
    >
      {load.kind === "loading" ? (
        <p role="status">Loading eligible reviewers…</p>
      ) : load.kind === "error" ? (
        <p role="alert">{load.message}</p>
      ) : (
        <div className="calm-reviewer-choices">
          {load.rows.map((option) => {
            const row = rows.find((candidate) => candidate.key === option.key);
            return (
              <fieldset
                key={option.key}
                disabled={busy || sent.has(option.key)}
              >
                <legend>
                  {row?.title}{" "}
                  <span className="calm-muted">#{row?.number}</span>
                  {sent.has(option.key) ? " · sent" : ""}
                </legend>
                {option.note ? (
                  <p className="calm-muted">{option.note}</p>
                ) : null}
                {option.candidates.length === 0 ? (
                  <p>No eligible reviewers are available.</p>
                ) : (
                  option.candidates.map((candidate) => (
                    <label key={candidate.login}>
                      <input
                        type="checkbox"
                        checked={
                          chosen.get(option.key)?.has(candidate.login) ?? false
                        }
                        onChange={() =>
                          setChosen((current) => {
                            const next = new Map(current),
                              logins = new Set(current.get(option.key));
                            if (logins.has(candidate.login))
                              logins.delete(candidate.login);
                            else if (logins.size < 10)
                              logins.add(candidate.login);
                            next.set(option.key, logins);
                            return next;
                          })
                        }
                      />
                      {candidate.login}
                      <span className="calm-muted">
                        {candidate.owned ? "CODEOWNER · " : ""}
                        {candidate.load} waiting
                      </span>
                    </label>
                  ))
                )}
              </fieldset>
            );
          })}
        </div>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? (
        <p role="alert" className="text-red">
          {error}
        </p>
      ) : null}
      <div className="calm-dialog-actions">
        <CalmButton onClick={onClose} disabled={busy}>
          Close
        </CalmButton>
        <CalmButton
          onClick={() => void send()}
          disabled={busy || !requests.length}
        >
          {busy ? "Sending…" : `Send ${requests.length}`}
        </CalmButton>
      </div>
    </CalmDialog>
  );
}
function OneClick({
  prs,
  view,
  onPick,
}: {
  prs: MinePr[];
  view: NonNullable<BoardState["view"]>;
  onPick: (rows: CalmRow[], login: string | null) => void;
}) {
  const groups = view.reviewer_batches
    .map((batch) => ({
      ...batch,
      prs: prs.filter((pr) => batch.keys.includes(pr.row.key)),
    }))
    .filter((batch) => batch.prs.length);
  const grouped = new Set(
    groups.flatMap((batch) => batch.prs.map((pr) => pr.row.key)),
  );
  const remaining = prs.filter((pr) => !grouped.has(pr.row.key));
  if (remaining.length)
    groups.push({
      login: null,
      name: null,
      keys: remaining.map((pr) => pr.row.key),
      prs: remaining,
    });
  return (
    <EffortGroup
      title="One click"
      count={prs.length}
      effort="~2 min"
      action={
        <CalmButton
          onClick={() =>
            onPick(
              prs.map((pr) => pr.row),
              null,
            )
          }
        >
          Send all
        </CalmButton>
      }
    >
      {groups.map((batch, index) => (
        <button
          key={`${batch.login}:${index}`}
          type="button"
          className="calm-person-row"
          onClick={() =>
            onPick(
              batch.prs.map((pr) => pr.row),
              batch.login,
            )
          }
        >
          <span className="calm-dot-column">
            <SizeDot lines={30} tone="amber" />
          </span>
          <span className="calm-person-name">
            {batch.name ? `Ask ${batch.name} to review` : "Pick reviewers"}
          </span>
          <span className="calm-person-dots amber">
            {batch.prs.map((pr) => (
              <i
                key={pr.row.key}
                title={`#${pr.row.number}: ${pr.row.title}`}
              />
            ))}
          </span>
        </button>
      ))}
    </EffortGroup>
  );
}

export function Board({ subPath }: { subPath?: string }) {
  const {
    rpc,
    state,
    reviews,
    error,
    reviewError,
    refreshing,
    now,
    refetch,
    refresh,
  } = usePrsData();
  const navigate = useBbNavigate();
  const [tab, setTab] = useState<"mine" | "review">(
    subPath?.startsWith("to-review") ? "review" : "mine",
  );
  const [mineSegment, setMineSegment] = useState<MineSegment>("on-you");
  const [reviewSegment, setReviewSegment] = useState<ReviewSegment>("on-you");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reviewExpanded, setReviewExpanded] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<{
    key: string;
    pending: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stopOverride, setStopOverride] = useState<Stop | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picker, setPicker] = useState<{
    rows: CalmRow[];
    login: string | null;
  } | null>(null);
  const { folded, toggle } = useFolds();
  const view = state?.view ?? null;
  const prs = useMemo(
    () => minePrs(view, state?.markers ?? []),
    [view, state?.markers],
  );
  const reviewItems =
    reviews?.kind === "available" ? reviews.snapshot.items : [];
  const toReview = reviewItems.filter(
    (review) => review.segment === "on-you",
  ).length;
  useEffect(() => {
    if (subPath === undefined) return;
    setTab(subPath.startsWith("to-review") ? "review" : "mine");
    if (subPath.startsWith("to-review/")) {
      try {
        setReviewTarget({
          key: subPath
            .slice("to-review/".length)
            .split("/")
            .map(decodeURIComponent)
            .join("/"),
          pending: true,
        });
      } catch {
        setReviewTarget(null);
      }
    } else setReviewTarget(null);
  }, [subPath]);
  useEffect(() => {
    if (!reviewTarget?.pending) return;
    const match = reviewItems.find(
      (review) =>
        `${review.item.repo}#${review.item.number}` === reviewTarget.key,
    );
    if (match) {
      setReviewSegment(match.segment);
      setReviewExpanded(match.item.key);
      setReviewTarget({ ...reviewTarget, pending: false });
    }
  }, [reviews, reviewTarget]);
  const switchTab = (next: "mine" | "review") => {
    setTab(next);
    setReviewTarget(null);
    setNotice(null);
    if (subPath !== undefined)
      navigate.toPluginPanel("pr-board", {
        subPath: next === "review" ? "to-review" : "",
      });
  };
  const onReview = (key: string) => {
    setReviewTarget({ key, pending: true });
    setTab("review");
    if (subPath !== undefined)
      navigate.toPluginPanel("pr-board", { subPath: `to-review/${key}` });
  };
  const selection = prs.filter(
    (pr) => selected.has(pr.row.key) && isStartable(pr),
  );
  const stop =
    stopOverride ??
    (selection.some((pr) => pr.row.group === "large") ? "prepare" : "publish");
  const start = async (rows: CalmRow[], policy: Stop) => {
    if (busy) return;
    const currentPrs = new Map(prs.map((pr) => [pr.row.key, pr]));
    const items = rows.flatMap((row) => {
      const pr = currentPrs.get(row.key);
      return pr && isStartable(pr)
        ? [{ key: pr.row.key, action: pr.row.action }]
        : [];
    });
    if (!items.length) return;
    setBusy("start");
    setNotice(null);
    try {
      const { starting, skipped } = await rpc.call("start", {
        items: items.slice(0, 100),
        stop: policy,
      });
      setNotice(
        `${starting.length} ${starting.length === 1 ? "agent" : "agents"} starting.${skipped.length ? ` ${skipped.length} not started: ${skipped.map((skip) => `#${skip.key.split("#").pop()} ${skip.reason}`).join(" · ")}` : ""}${items.length > 100 ? ` ${items.length - 100} remain outside this request.` : ""}`,
      );
      setSelected(
        (current) =>
          new Set([...current].filter((key) => !starting.includes(key))),
      );
      refetch();
    } catch (cause) {
      setNotice(`Could not start: ${message(cause)}`);
    } finally {
      setBusy(null);
    }
  };
  const answer = async (pr: MinePr, optionId: string) => {
    if (busy || !pr.marker?.question) return;
    setBusy(pr.row.key);
    setNotice(null);
    try {
      await rpc.call("answer", {
        key: pr.row.key,
        questionId: pr.marker.question.id,
        optionId,
      });
      setNotice("Answer sent to the agent.");
      refetch();
    } catch (cause) {
      setNotice(`Answer not confirmed: ${message(cause)}`);
      refetch();
    } finally {
      setBusy(null);
    }
  };
  const renderRow = (pr: MinePr) =>
    view ? (
      <MineRow
        key={pr.row.key}
        pr={pr}
        all={prs}
        view={view}
        expanded={expanded === pr.row.key}
        onExpand={() =>
          setExpanded(expanded === pr.row.key ? null : pr.row.key)
        }
        selected={selected.has(pr.row.key)}
        onSelect={() => {
          if (selected.size === 0) setStopOverride(null);
          setSelected((current) => {
            const next = new Set(current);
            if (next.has(pr.row.key)) next.delete(pr.row.key);
            else next.add(pr.row.key);
            return next;
          });
        }}
        onStart={(rows, policy) => void start(rows, policy)}
        onReview={onReview}
        answer={(item, option) => void answer(item, option)}
        busy={busy !== null}
      />
    ) : null;
  const sorted = (members: MinePr[]) =>
    [...members].sort(
      (a, b) =>
        Number(b.row.stack_front) - Number(a.row.stack_front) ||
        Date.parse(a.row.pushed_at ?? "9999-01-01") -
          Date.parse(b.row.pushed_at ?? "9999-01-01"),
    );
  const onYou = sorted(prs.filter((pr) => pr.segment === "on-you"));
  const questions = onYou.filter(
    (pr) => pr.marker?.status === "asking" && pr.marker.question,
  );
  const group = (id: CalmRow["group"]) =>
    onYou.filter((pr) => pr.row.group === id && !questions.includes(pr));
  const small = group("small"),
    large = group("large"),
    blocked = group("blocked"),
    held = group("held");
  const smallStartable = small.filter(isStartable);
  const largeStartable = large.filter(isStartable);
  const ready = prs.filter((pr) => pr.segment === "ready");
  const timestamp =
    tab === "mine"
      ? (state?.lastSuccess ?? view?.fetched_at)
      : reviews?.kind === "available"
        ? reviews.snapshot.lastSuccessAt
        : null;
  const stale = timestamp ? now - Date.parse(timestamp) > 15 * 60_000 : false;
  const currentError =
    tab === "mine"
      ? error
      : (reviewError ??
        (reviews?.kind === "available" &&
        reviews.snapshot.lastPoll?.ok === false
          ? (reviews.snapshot.lastPoll.error ?? "Review refresh failed")
          : null));
  const laterGroup = (
    title: string,
    members: MinePr[],
    id: string,
    effort: string,
    tone: string,
    action?: React.ReactNode,
  ) => (
    <EffortGroup
      title={title}
      count={members.length}
      tone={tone}
      effort={effort}
      action={action}
      folded={folded(id)}
      onToggle={() => toggle(id)}
      dots={<FoldDots rows={members} />}
    >
      <ul>{members.map(renderRow)}</ul>
    </EffortGroup>
  );
  return (
    <div className="calm-scroller">
      <main className="calm-board">
        <header className="calm-header">
          <div
            className="calm-tabs"
            role="group"
            aria-label="Pull request view"
          >
            <button
              type="button"
              aria-pressed={tab === "mine"}
              onClick={() => switchTab("mine")}
            >
              Mine <span>{prs.length}</span>
            </button>
            <button
              type="button"
              aria-pressed={tab === "review"}
              onClick={() => switchTab("review")}
            >
              To review <span className="text-amber">{toReview}</span>
            </button>
          </div>
          <time
            className={`calm-updated${stale ? " text-amber" : ""}`}
            dateTime={timestamp ?? undefined}
            title={
              timestamp
                ? `Last successful refresh: ${new Date(timestamp).toLocaleString()}`
                : "No successful refresh"
            }
          >
            {timestamp
              ? `${age(timestamp, now)}${age(timestamp, now) === "now" ? "" : " ago"}`
              : ""}
          </time>
          <button
            type="button"
            className="calm-refresh"
            disabled={refreshing || (tab === "mine" && !!state?.refreshing)}
            onClick={() => void refresh(tab)}
            aria-label="Refresh"
            title="Refresh"
          >
            ↻
          </button>
        </header>
        {currentError ? (
          <p role="alert" className="calm-notice">
            Last refresh failed: {currentError}
            {timestamp
              ? ` · Last success ${age(timestamp, now)}${age(timestamp, now) === "now" ? "" : " ago"}`
              : ""}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="calm-notice">
            {notice}
          </p>
        ) : null}
        {tab === "mine" ? (
          view ? (
            <>
              <UnitBar
                segments={MINE_SEGMENTS}
                items={prs.map((pr) => ({
                  key: pr.row.key,
                  segment: pr.segment,
                  tone: rowTone(pr),
                  label: `#${pr.row.number}: ${pr.row.title}`,
                  outlined: isStartable(pr),
                }))}
                selected={mineSegment}
                onSelect={setMineSegment}
              />
              {mineSegment === "on-you" ? (
                <>
                  <SizeLegend />
                  {ready.length ? (
                    <EffortGroup
                      title="Ready to merge"
                      count={ready.length}
                      tone="green"
                      effort="merge manually"
                    >
                      <ul>{ready.map(renderRow)}</ul>
                    </EffortGroup>
                  ) : null}
                  <EffortGroup
                    title="Answer to unblock agents"
                    count={questions.length}
                    tone="question"
                    effort="seconds"
                  >
                    <ul>{questions.map(renderRow)}</ul>
                  </EffortGroup>
                  <OneClick
                    prs={group("one-click")}
                    view={view}
                    onPick={(rows, login) => setPicker({ rows, login })}
                  />
                  <EffortGroup
                    title="Small fixes for an agent"
                    count={small.length}
                    tone="blue"
                    effort="~20 min"
                    action={
                      smallStartable.length ? (
                        <CalmButton
                          primary
                          disabled={busy !== null}
                          title={`Stop at Publish · ${smallStartable.length} eligible`}
                          onClick={() =>
                            void start(
                              smallStartable.slice(0, 5).map((pr) => pr.row),
                              "publish",
                            )
                          }
                        >
                          <span aria-hidden>▸</span> Start{" "}
                          {Math.min(smallStartable.length, 5)}
                        </CalmButton>
                      ) : null
                    }
                  >
                    <ul>{small.map(renderRow)}</ul>
                  </EffortGroup>
                  {large.length || blocked.length || held.length ? (
                    <Later />
                  ) : null}
                  {laterGroup(
                    "Large fixes",
                    large,
                    "mine-large",
                    "agent, then you",
                    "blue",
                    largeStartable.length ? (
                      <CalmButton
                        disabled={busy !== null}
                        title={`Stop at Prepare · ${largeStartable.length} eligible`}
                        onClick={() =>
                          void start(
                            largeStartable.slice(0, 5).map((pr) => pr.row),
                            "prepare",
                          )
                        }
                      >
                        <span aria-hidden>▸</span> Prepare{" "}
                        {Math.min(largeStartable.length, 5)}
                      </CalmButton>
                    ) : null,
                  )}
                  {laterGroup(
                    "Blocked upstream",
                    blocked,
                    "mine-blocked",
                    "gated",
                    "orange",
                  )}
                  {laterGroup(
                    "Needs a manual look",
                    held,
                    "mine-held",
                    "manual",
                    "gray",
                  )}
                  {onYou.length === 0 ? (
                    <p className="calm-empty">
                      Nothing needs you.
                      {ready[0]
                        ? ` Closest to merge: #${ready[0].row.number} (${ready[0].row.title}).`
                        : prs[0]
                          ? ` Closest to merge is not confirmed; ${prs.length} PRs remain open.`
                          : " No open pull requests."}
                    </p>
                  ) : null}
                </>
              ) : mineSegment === "agent" ? (
                <>
                  <SizeLegend caption="Agent threads on your PRs" />
                  <EffortGroup
                    title="Working"
                    count={prs.filter((pr) => pr.segment === "agent").length}
                    tone="blue"
                  >
                    <ul>
                      {sorted(prs.filter((pr) => pr.segment === "agent")).map(
                        renderRow,
                      )}
                    </ul>
                  </EffortGroup>
                  <EffortGroup
                    title="Finished, asking you"
                    count={questions.length}
                    tone="question"
                  >
                    <ul>{questions.map(renderRow)}</ul>
                  </EffortGroup>
                  <EffortGroup
                    title="Finished threads"
                    count={
                      prs.filter((pr) => pr.marker?.status === "done").length
                    }
                    tone="gray"
                  >
                    <ul>
                      {prs
                        .filter((pr) => pr.marker?.status === "done")
                        .map(renderRow)}
                    </ul>
                  </EffortGroup>
                </>
              ) : mineSegment === "on-reviewers" ? (
                <ReviewersView
                  rows={sorted(
                    prs.filter((pr) => pr.segment === "on-reviewers"),
                  )}
                  renderRow={renderRow}
                />
              ) : (
                <>
                  <SizeLegend
                    caption={
                      mineSegment === "drafts"
                        ? "Drafts, when you are ready"
                        : "Ready to merge manually"
                    }
                  />
                  <EffortGroup
                    title={
                      mineSegment === "drafts" ? "Drafts" : "Ready to merge"
                    }
                    count={
                      prs.filter((pr) => pr.segment === mineSegment).length
                    }
                    tone={mineSegment === "drafts" ? "gray" : "green"}
                  >
                    <ul>
                      {sorted(
                        prs.filter((pr) => pr.segment === mineSegment),
                      ).map(renderRow)}
                    </ul>
                  </EffortGroup>
                </>
              )}
            </>
          ) : (
            <>
              <div className="calm-loading-bar" aria-hidden>
                {Array.from({ length: 24 }, (_, index) => (
                  <i key={index} />
                ))}
              </div>
              <p role="status" className="calm-empty">
                {error
                  ? "PR data is unavailable. Refresh to retry."
                  : state && !state.refreshing
                    ? "No board yet. Refresh to fetch your PRs."
                    : "Fetching your PRs…"}
              </p>
            </>
          )
        ) : reviews?.kind === "available" ? (
          <>
            <UnitBar
              segments={REVIEW_SEGMENTS}
              items={reviewItems.map((review) => ({
                key: review.item.key,
                segment: review.segment,
                tone: reviewTone(review),
                label: `#${review.item.number}: ${review.item.title}`,
              }))}
              selected={reviewSegment}
              onSelect={setReviewSegment}
            />
            {reviewTarget &&
            !reviewItems.some(
              (review) =>
                `${review.item.repo}#${review.item.number}` ===
                reviewTarget.key,
            ) ? (
              <p className="calm-notice">
                {reviewTarget.key} is not in your review queue.
              </p>
            ) : null}
            <ReviewsView
              items={reviewItems}
              segment={reviewSegment}
              expanded={reviewExpanded}
              setExpanded={setReviewExpanded}
              folds={folded}
              toggleFold={toggle}
              mine={view?.prs ?? []}
              refetch={refetch}
            />
          </>
        ) : (
          <p role="status" className="calm-empty">
            {reviews?.kind === "unavailable"
              ? `To review is unavailable: ${reviews.reason}`
              : reviewError
                ? `To review is unavailable: ${reviewError}`
                : "Fetching your review queue…"}
          </p>
        )}
        {tab === "mine" && selection.length ? (
          <div
            className="calm-selection"
            role="group"
            aria-label="Start selected agents"
          >
            <span>{selection.length} selected</span>
            <label>
              Stop at{" "}
              <select
                aria-label="Stop at"
                value={stop}
                onChange={(event) => {
                  const parsed = event.target.value;
                  if (parsed === "prepare" || parsed === "publish")
                    setStopOverride(parsed);
                }}
              >
                <option value="prepare">Prepare</option>
                <option value="publish">Publish</option>
              </select>
            </label>
            <CalmButton
              disabled={busy !== null}
              onClick={() =>
                void start(
                  selection.map((pr) => pr.row),
                  stop,
                )
              }
            >
              Start {Math.min(selection.length, 5)}
            </CalmButton>
            <button
              type="button"
              className="calm-dismiss"
              aria-label="Clear selection"
              onClick={() => setSelected(new Set())}
            >
              ×
            </button>
            {selection.length > 5 ? (
              <small>{selection.length - 5} remain after this start</small>
            ) : null}
          </div>
        ) : null}
        {picker ? (
          <ReviewerPicker
            rows={picker.rows}
            login={picker.login}
            onClose={() => setPicker(null)}
            refetch={refetch}
          />
        ) : null}
      </main>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "pr-board",
    title: "PRs",
    icon: "GitPullRequest",
    path: "pr-board",
    component: Board,
    experimental_useBadge: usePrsBadge,
  });
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "pr-board",
    title: "PRs",
    icon: "GitPullRequest",
    layout: "flush",
    component: () => <Board />,
  });
});
