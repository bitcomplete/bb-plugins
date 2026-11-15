import { useEffect, useState, type ReactNode } from "react";
import { UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  estimatedMinutes,
  quickRead,
  reviewLines,
  type PrsReview,
  type ReviewTargets,
} from "./reviews";
import {
  age,
  CalmButton,
  CalmDialog,
  compactLines,
  EffortGroup,
  Later,
  SizeDot,
  SizeLegend,
} from "./board-ui";
import type { CalmRow } from "./board";

export type ReviewSegment = PrsReview["segment"];
export const REVIEW_SEGMENTS: {
  id: ReviewSegment;
  label: string;
  tone: string;
}[] = [
  { id: "on-you", label: "on you", tone: "amber" },
  { id: "agent", label: "agent", tone: "blue" },
  { id: "with-authors", label: "with authors", tone: "purple" },
];
export const reviewTone = (review: PrsReview) =>
  review.agentState === "draft-ready"
    ? "draft"
    : review.segment === "agent"
      ? "blue"
      : review.segment === "with-authors"
        ? "purple"
        : "amber";
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

type ProjectLoad =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; targets: ReviewTargets };
function ReviewProjectPicker({
  keys,
  onClose,
  onStarted,
}: {
  keys: string[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [load, setLoad] = useState<ProjectLoad>({ kind: "loading" });
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    rpc.call("reviews_targets", { keys }).then(
      (targets) => {
        if (active) {
          setLoad({ kind: "ready", targets });
          setProject(targets.projectId ?? "");
        }
      },
      (cause) => {
        if (active) setLoad({ kind: "error", message: message(cause) });
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, keys]);
  const start = async () => {
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const first = keys[0];
      if (!first) return;
      const result =
        keys.length === 1
          ? await rpc
              .call("reviews_start", { key: first, projectId: project })
              .then(({ item }) => ({ threadId: item.threadId }))
          : await rpc.call("reviews_batch", { keys, projectId: project });
      if (!result.threadId)
        throw new Error(
          "The review started without a thread link. Refresh before retrying.",
        );
      onStarted();
      navigate.toThread(result.threadId);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <CalmDialog
      title={
        keys.length === 1
          ? "Start review"
          : `Review ${keys.length} pull requests`
      }
      description="Choose the project for the review thread. The agent drafts findings for you to check."
      busy={busy}
      onClose={onClose}
    >
      {load.kind === "loading" ? (
        <p role="status">Loading projects…</p>
      ) : load.kind === "error" ? (
        <p role="alert">{load.message}</p>
      ) : (
        <>
          <label className="calm-field">
            Project
            <select
              value={project}
              disabled={busy}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="" disabled>
                Choose a project
              </option>
              {load.targets.projects.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
          <p className="calm-muted">
            {load.targets.projects.length === 0
              ? "Add a project checkout in BB to start reviews."
              : load.targets.reason === "mixed"
                ? "These PRs map to different projects. Choose one for this batch."
                : load.targets.reason === "organization"
                  ? "Preselected from your organization mappings."
                  : load.targets.reason === "default"
                    ? "Preselected from your default review project."
                    : "Choose a project for this review."}
          </p>
        </>
      )}
      {error ? (
        <p role="alert" className="text-red">
          {error}
        </p>
      ) : null}
      <div className="calm-dialog-actions">
        <CalmButton disabled={busy} onClick={onClose}>
          Cancel
        </CalmButton>
        <CalmButton
          disabled={!project || load.kind !== "ready" || busy}
          onClick={() => void start()}
        >
          {busy ? "Starting…" : "Start review"}
        </CalmButton>
      </div>
    </CalmDialog>
  );
}
function ReviewContext({
  review,
  start,
}: {
  review: PrsReview;
  start: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [detail, setDetail] = useState<PrsReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useBbNavigate();
  useEffect(() => {
    let active = true;
    rpc.call("reviews_detail", { key: review.item.key }).then(
      (next) => {
        if (active) setDetail(next);
      },
      (cause) => {
        if (active) setError(message(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, review.item.key]);
  if (!detail)
    return (
      <div
        className="calm-context calm-context-loading"
        role={error ? "alert" : "status"}
      >
        {error ?? "Loading review context…"}
      </div>
    );
  const delta = detail.delta;
  const maxLines =
    delta.kind === "known"
      ? Math.max(
          1,
          ...delta.files.map((file) => file.additions + file.deletions),
        )
      : 1;
  const verdict =
    detail.lastReview?.state === "APPROVED"
      ? "approved"
      : detail.lastReview?.state === "CHANGES_REQUESTED"
        ? "asked for changes"
        : detail.lastReview?.state === "COMMENTED"
          ? "commented"
          : detail.lastReview?.state.toLowerCase().replaceAll("_", " ");
  const deltaUrl =
    delta.kind === "known"
      ? `https://github.com/${detail.item.repo}/compare/${delta.baseSha}...${delta.headSha}`
      : null;
  return (
    <div
      className="calm-context"
      role="region"
      aria-label={`Review context for ${review.item.title}`}
    >
      <span className="calm-context-label">Changed</span>
      <div>
        {delta.kind === "known" ? (
          <>
            <div className="calm-files">
              {delta.files.map((file) => (
                <div className="calm-file" key={file.path}>
                  <span title={file.path} className="calm-file-name">
                    {file.path}
                  </span>
                  <span className="calm-file-bar">
                    <i
                      className="added"
                      style={{ width: `${(100 * file.additions) / maxLines}%` }}
                    />
                    <i
                      className="deleted"
                      style={{ width: `${(100 * file.deletions) / maxLines}%` }}
                    />
                  </span>
                  <span className="calm-file-count">
                    <span className="text-green">+{file.additions}</span>{" "}
                    <span className="text-red">−{file.deletions}</span>
                  </span>
                </div>
              ))}
            </div>
            <p>
              +{delta.additions} −{delta.deletions} since your review
            </p>
          </>
        ) : delta.kind === "unknown" ? (
          <p>Delta unavailable: {delta.reason}</p>
        ) : detail.total.kind === "known" ? (
          <p>
            {compactLines(detail.total.additions + detail.total.deletions)}{" "}
            lines · {detail.total.files} files in this PR
          </p>
        ) : (
          <p>Size unavailable: {detail.total.reason}</p>
        )}
      </div>
      <span className="calm-context-label">Last time</span>
      <div>
        <p>
          {detail.lastReview
            ? `You ${verdict} ${age(detail.lastReview.submittedAt)} ago.`
            : "You have not submitted a review."}
        </p>
        {detail.resolution.kind === "known" ? (
          <p>
            {detail.resolution.resolved} resolved ·{" "}
            {detail.resolution.unresolved} unresolved review threads
          </p>
        ) : (
          <p>Thread resolution unknown: {detail.resolution.reason}</p>
        )}
      </div>
      {detail.agentState !== "none" ? (
        <>
          <span className="calm-context-label">Agent</span>
          <p>{detail.evidence}</p>
        </>
      ) : null}
      <span className="calm-context-label">Actions</span>
      <div className="calm-actions">
        {detail.item.threadId ? (
          <CalmButton onClick={() => navigate.toThread(detail.item.threadId!)}>
            Open thread
          </CalmButton>
        ) : detail.item.state === "queued" ? (
          <CalmButton onClick={start}>
            <span aria-hidden>▸</span>{" "}
            {detail.item.rule === "review-followup"
              ? "Re-review"
              : "Start review"}
          </CalmButton>
        ) : null}
        {deltaUrl ? (
          <UrlLink className="calm-button" href={deltaUrl}>
            Delta only
          </UrlLink>
        ) : null}
        <UrlLink href={detail.item.url} className="calm-button">
          Open PR
        </UrlLink>
        <UrlLink href={`${detail.item.url}/files`} className="calm-button">
          Diff
        </UrlLink>
      </div>
    </div>
  );
}
function ReviewRow({
  review,
  expanded,
  onExpand,
  selected,
  select,
  start,
  dismiss,
  busy,
  unblocks,
}: {
  review: PrsReview;
  expanded: boolean;
  onExpand: () => void;
  selected: boolean;
  select: () => void;
  start: () => void;
  dismiss: () => void;
  busy: boolean;
  unblocks: CalmRow[];
}) {
  const navigate = useBbNavigate();
  const days = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(review.item.noticedAt)) / 86_400_000),
  );
  const selectable =
    review.item.state === "queued" &&
    review.segment === "on-you" &&
    !review.item.threadId;
  const lines = reviewLines(review);
  return (
    <li
      className={`calm-pr${expanded ? " expanded" : ""}`}
      data-review-key={review.item.key}
    >
      <div className="calm-row">
        <span className="calm-dot-column">
          <SizeDot lines={lines} tone={reviewTone(review)} />
          {selectable ? (
            <input
              type="checkbox"
              className="calm-row-checkbox"
              aria-label={`Select ${review.item.title} #${review.item.number}`}
              checked={selected}
              onChange={select}
            />
          ) : null}
        </span>
        <div className="calm-row-content">
          <div className="calm-row-line">
            <button
              type="button"
              className="calm-title"
              aria-expanded={expanded}
              onClick={onExpand}
              title={`${lines === null ? "size unknown" : `${compactLines(lines)} lines`} · #${review.item.number}`}
            >
              {review.item.title}
            </button>
            <UrlLink
              className="calm-pr-number"
              href={review.item.url}
              title={`${review.item.title} #${review.item.number}`}
            >
              #{review.item.number}
            </UrlLink>
            <span
              title={`Queued since ${new Date(review.item.noticedAt).toLocaleString()}`}
              className={`calm-row-meta${review.agentState === "draft-ready" ? " text-blue" : days >= 2 && review.segment === "on-you" ? " text-amber" : ""}`}
            >
              {review.agentState === "draft-ready"
                ? "draft ready"
                : `${review.item.author}${review.item.repo === "parsleyhealth/parsley-monorepo" ? "" : ` · ${review.item.repo.split("/").pop()}`}${days ? ` · ${days}d` : ""}`}
            </span>
            <span className="calm-row-actions">
              {review.item.threadId ? (
                <CalmButton
                  onClick={() => navigate.toThread(review.item.threadId!)}
                >
                  Open thread
                </CalmButton>
              ) : selectable ? (
                <CalmButton disabled={busy} onClick={start}>
                  <span aria-hidden>▸</span>{" "}
                  {quickRead(review) ? "Start" : "Draft"}
                </CalmButton>
              ) : null}
              <button
                type="button"
                className="calm-dismiss"
                aria-label={`Dismiss ${review.item.title} #${review.item.number}`}
                disabled={busy}
                onClick={dismiss}
              >
                ×
              </button>
            </span>
          </div>
          {unblocks.length ? (
            <p className="calm-unblocks">
              ♧ Unblocks your{" "}
              {unblocks.map((row) => `#${row.number}`).join(" and ")}
            </p>
          ) : null}
          {lines === null && review.segment === "on-you" ? (
            <p className="calm-unknown-size">
              {review.item.rule === "review-followup"
                ? "Delta unknown"
                : "Size unknown"}
            </p>
          ) : null}
        </div>
      </div>
      {expanded ? <ReviewContext review={review} start={start} /> : null}
    </li>
  );
}
export function ReviewsView({
  items,
  segment,
  expanded,
  setExpanded,
  folds,
  toggleFold,
  mine,
  refetch,
}: {
  items: PrsReview[];
  segment: ReviewSegment;
  expanded: string | null;
  setExpanded: (key: string | null) => void;
  folds: (key: string) => boolean;
  toggleFold: (key: string) => void;
  mine: CalmRow[];
  refetch: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const [startKeys, setStartKeys] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectable = items.filter(
    (review) =>
      review.item.state === "queued" &&
      review.segment === "on-you" &&
      !review.item.threadId,
  );
  const selection = selectable.filter((review) => picked.has(review.item.key));
  const shown = items.filter((review) => review.segment === segment);
  const quick = shown.filter(quickRead),
    long = shown.filter((review) => !quickRead(review));
  const withAuthors = items.filter(
    (review) => review.segment === "with-authors",
  );
  const minutes = (reviews: PrsReview[]) => {
    const estimates = reviews.map(estimatedMinutes);
    return estimates.some((estimate) => estimate === null)
      ? "estimate unavailable"
      : `~${estimates.reduce<number>((sum, estimate) => sum + (estimate ?? 0), 0)} min · estimated`;
  };
  const dismiss = async (review: PrsReview) => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("reviews_dismiss", { key: review.item.key });
      refetch();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const renderRow = (review: PrsReview): ReactNode => (
    <ReviewRow
      key={review.item.key}
      review={review}
      expanded={expanded === review.item.key}
      onExpand={() =>
        setExpanded(expanded === review.item.key ? null : review.item.key)
      }
      selected={picked.has(review.item.key)}
      select={() =>
        setPicked((current) => {
          const next = new Set(current);
          if (next.has(review.item.key)) next.delete(review.item.key);
          else next.add(review.item.key);
          return next;
        })
      }
      start={() => setStartKeys([review.item.key])}
      dismiss={() => void dismiss(review)}
      busy={busy}
      unblocks={mine.filter((row) =>
        row.gate_links.some(
          (gate) =>
            gate.cleared_by === `${review.item.repo}#${review.item.number}`,
        ),
      )}
    />
  );
  const openInOrder = () => {
    const previous = quick.findIndex(
      (review) => review.item.key === lastOpened,
    );
    const next = quick[(previous + 1) % quick.length];
    if (!next) return;
    setLastOpened(next.item.key);
    if (next.item.threadId) navigate.toThread(next.item.threadId);
    else setExpanded(next.item.key);
  };
  const draftLong = long.filter(
    (review) => review.item.state === "queued" && !review.item.threadId,
  );
  return (
    <>
      <SizeLegend
        caption={
          segment === "agent"
            ? "Agents drafting your reviews"
            : segment === "with-authors"
              ? "Your review is with the author"
              : "Easiest first"
        }
      />
      {error ? (
        <p role="alert" className="calm-notice text-red">
          {error}
        </p>
      ) : null}
      {segment === "on-you" ? (
        <>
          <EffortGroup
            title="Quick reads"
            count={quick.length}
            effort={minutes(quick)}
            action={
              <CalmButton onClick={openInOrder}>Open in order</CalmButton>
            }
          >
            <ul>{quick.map(renderRow)}</ul>
          </EffortGroup>
          <EffortGroup
            title="Longer read"
            count={long.length}
            tone="blue"
            effort={minutes(long)}
            action={
              draftLong.length ? (
                <CalmButton
                  disabled={busy}
                  onClick={() =>
                    setStartKeys(draftLong.map((review) => review.item.key))
                  }
                >
                  <span aria-hidden>▸</span> Draft first
                </CalmButton>
              ) : null
            }
          >
            <ul>{long.map(renderRow)}</ul>
          </EffortGroup>
          {withAuthors.length ? (
            <>
              <Later />
              <EffortGroup
                title="Back with authors"
                count={withAuthors.length}
                tone="purple"
                effort="not on you"
                folded={folds("reviews-authors")}
                onToggle={() => toggleFold("reviews-authors")}
                dots={withAuthors.map((review) => (
                  <SizeDot
                    key={review.item.key}
                    lines={reviewLines(review)}
                    tone="purple"
                  />
                ))}
              >
                <ul>{withAuthors.map(renderRow)}</ul>
              </EffortGroup>
            </>
          ) : null}
        </>
      ) : (
        <EffortGroup
          title={segment === "agent" ? "Working" : "Back with authors"}
          count={shown.length}
          tone={segment === "agent" ? "blue" : "purple"}
        >
          <ul>{shown.map(renderRow)}</ul>
        </EffortGroup>
      )}
      {shown.length === 0 ? (
        <p className="calm-empty">
          {segment === "on-you"
            ? "Nothing needs your review."
            : segment === "agent"
              ? "No review agents are running."
              : "No reviews are back with authors."}
        </p>
      ) : null}
      {selection.length ? (
        <div
          className="calm-selection"
          role="group"
          aria-label="Review selected pull requests"
        >
          <span>{selection.length} selected</span>
          <CalmButton onClick={() => setPicked(new Set())}>Clear</CalmButton>
          <CalmButton
            disabled={busy}
            onClick={() =>
              setStartKeys(selection.map((review) => review.item.key))
            }
          >
            Review {selection.length}
          </CalmButton>
        </div>
      ) : null}
      {startKeys ? (
        <ReviewProjectPicker
          keys={startKeys}
          onClose={() => setStartKeys(null)}
          onStarted={() => {
            setStartKeys(null);
            setPicked(new Set());
            refetch();
          }}
        />
      ) : null}
    </>
  );
}
