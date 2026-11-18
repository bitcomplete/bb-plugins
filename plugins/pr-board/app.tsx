import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import {
  Checkbox,
  CheckboxGroup,
  CheckboxIndicator,
} from "@ui-sdk/react/checkbox";
import {
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
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
import type { AgentModelChoice } from "./agent-model";
import { ConversationPanel } from "./conversation-ui";
import {
  disposePrsUiAgentBridge,
  usePrsUiAgentBridge,
} from "./ui-agent-bridge";
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
  SectionSelection,
  SizeDot,
  SizeLegend,
  UnitBar,
  minePrs,
  groupAgentQuestions,
  hasAgentQuestion,
  isStartable,
  rowTone,
  type MinePr,
  type MineSegment,
  type AgentQuestionGroup,
} from "./board-ui";
import {
  REVIEW_SEGMENTS,
  ReviewsView,
  reviewTone,
  reviewsWithPendingInput,
  type ReviewSegment,
} from "./reviews-ui";
import "./calm.css";

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
const organizationSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,38}$/i)
  .transform((owner) => owner.toLowerCase())
  .nullable();
const viewSchema = z.object({
  tab: z.enum(["mine", "review"]).catch("mine"),
  mineSegment: z.enum(MINE_SEGMENTS.map((segment) => segment.id)).catch("on-you"),
  reviewSegment: z.enum(REVIEW_SEGMENTS.map((segment) => segment.id)).catch("on-you"),
});
const repoOwner = (repo: string) => repo.split("/")[0]?.toLowerCase() ?? "";
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
    label: [
      "Across all organizations",
      `${onYou} on you`,
      `${toReview} to review`,
      ...reasons,
    ].join(" · "),
  };
}
function usePrsBadge(): ExperimentalBadge | null {
  const { state, reviews, now } = usePrsData();
  const prs = minePrs(state?.view ?? null, state?.markers ?? [], state?.needsInput ?? {});
  const pending =
    reviews?.kind === "available"
      ? reviewsWithPendingInput(reviews.snapshot.items, reviews.needsInput ?? {}).filter((review) => review.segment === "on-you")
      : [];
  return prsBadge({
    onYou: prs.filter((pr) => pr.segment === "on-you").length,
    toReview: pending.length,
    agentsAsking: new Set([
      ...groupAgentQuestions(prs).map((group) => group[0].marker?.threadId ?? group[0].row.key),
      ...pending.flatMap((review) => review.item.threadId && reviews?.kind === "available" && reviews.needsInput?.[review.item.threadId] ? [review.item.threadId] : []),
    ]).size,
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
type AgentModelContext = z.infer<
  (typeof rpcContract)["agent_model_get"]["output"]
>;
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
  const [chosen, setChosen] = useState<Map<string, string[]>>(new Map());
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
                option.candidates
                  .filter((candidate) => targets.includes(candidate.login))
                  .map((candidate) => candidate.login),
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
      {(close) => (
        <>
          {load.kind === "loading" ? (
            <p role="status">Loading eligible reviewers…</p>
          ) : load.kind === "error" ? (
            <p role="alert">{load.message}</p>
          ) : (
            <div className="calm-reviewer-choices">
              {load.rows.map((option) => {
                const row = rows.find(
                  (candidate) => candidate.key === option.key,
                );
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
                      <CheckboxGroup
                        data-prs-agent-local=""
                        aria-label={`Reviewers for ${row?.title} #${row?.number}`}
                        value={chosen.get(option.key) ?? []}
                        onValueChange={(next, details) => {
                          if (next.length > 10) details.cancel();
                          else
                            setChosen((current) =>
                              new Map(current).set(option.key, next),
                            );
                        }}
                      >
                        {option.candidates.map((candidate) => (
                          <label key={candidate.login}>
                            <Checkbox
                              data-prs-agent-local=""
                              value={candidate.login}
                              className="calm-checkbox"
                            >
                              <CheckboxIndicator aria-hidden>
                                ✓
                              </CheckboxIndicator>
                            </Checkbox>
                            {candidate.login}
                            <span className="calm-muted">
                              {candidate.owned ? "CODEOWNER · " : ""}
                              {candidate.load} waiting
                            </span>
                          </label>
                        ))}
                      </CheckboxGroup>
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
            <CalmButton onClick={close} disabled={busy}>
              Close
            </CalmButton>
            <CalmButton
              onClick={() => void send()}
              disabled={busy || !requests.length}
            >
              {busy ? "Sending…" : `Send ${requests.length}`}
            </CalmButton>
          </div>
        </>
      )}
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
  const { panelId, rootRef, availability } = usePrsUiAgentBridge();
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
  const [conversationThread, setConversationThread] = useState<string | null>(null);
  const conversationOpener = useRef<{ element: Element | null; url: string } | null>(null);
  const openConversation = (threadId: string) => {
    conversationOpener.current = {
      element: document.activeElement,
      url: window.location.href,
    };
    setConversationThread(threadId);
  };
  useLayoutEffect(() => {
    if (conversationThread !== null || conversationOpener.current === null) return;
    const { element, url } = conversationOpener.current;
    conversationOpener.current = null;
    if (
      url === window.location.href &&
      element instanceof HTMLElement &&
      element.isConnected &&
      !element.closest("[hidden], [inert]") &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    ) element.focus();
  }, [conversationThread]);
  const [agentSettings, setAgentSettings] = useState<AgentModelContext | null>(
    null,
  );
  const agentModel = agentSettings?.choice ?? null;
  const modelReady = agentModel !== null;
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const modelVersion = useRef(0);
  const loadModel = useCallback(async () => {
    const version = ++modelVersion.current;
    setAgentSettings(null);
    try {
      const settings = await rpc.call("agent_model_get");
      if (version !== modelVersion.current) return;
      setAgentSettings(settings);
      setModelError(null);
    } catch (cause) {
      if (version !== modelVersion.current) return;
      setModelError(`Could not load the agent model: ${message(cause)}`);
    }
  }, [rpc]);
  useEffect(() => {
    void loadModel();
  }, [loadModel]);
  useRealtime("agent-model-changed", () => void loadModel());
  const saveModel = async (choice: AgentModelChoice) => {
    if (modelSaving) return;
    const version = ++modelVersion.current;
    setModelSaving(true);
    setModelError(null);
    try {
      const saved = await rpc.call("agent_model_set", choice);
      if (version === modelVersion.current)
        setAgentSettings((current) =>
          current ? { ...current, choice: saved } : null,
        );
    } catch (cause) {
      if (version === modelVersion.current)
        setModelError(`Could not save the agent model: ${message(cause)}`);
    } finally {
      setModelSaving(false);
    }
  };
  const pluginId = experimental_usePluginId();
  const organizationKey = `${pluginId}:calm-organization`;
  const viewKey = `${pluginId}:calm-view`;
  const [savedView, setSavedView] = useState<z.infer<typeof viewSchema>>(() => {
    let saved = viewSchema.parse({});
    try {
      saved = viewSchema.parse(JSON.parse(localStorage.getItem(viewKey) ?? "{}"));
    } catch {}
    return subPath
      ? { ...saved, tab: subPath.startsWith("to-review") ? "review" : "mine" }
      : saved;
  });
  const { tab, mineSegment, reviewSegment } = savedView;
  const setTab = (tab: "mine" | "review") =>
    setSavedView((current) => ({ ...current, tab }));
  const setMineSegment = (mineSegment: MineSegment) =>
    setSavedView((current) => ({ ...current, mineSegment }));
  const setReviewSegment = (reviewSegment: ReviewSegment) =>
    setSavedView((current) => ({ ...current, reviewSegment }));
  useEffect(() => {
    try {
      localStorage.setItem(viewKey, JSON.stringify(savedView));
    } catch {}
  }, [viewKey, savedView]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reviewExpanded, setReviewExpanded] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<{
    key: string;
    pending: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [stopOverride, setStopOverride] = useState<Stop | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picker, setPicker] = useState<{
    rows: CalmRow[];
    login: string | null;
  } | null>(null);
  const [organization, setOrganization] = useState<string | null>(() => {
    try {
      return organizationSchema.parse(
        JSON.parse(localStorage.getItem(organizationKey) ?? "null"),
      );
    } catch {
      return null;
    }
  });
  const changeOrganization = useCallback(
    (next: string | null) => {
      setOrganization(next);
      setSelected([]);
      setStopOverride(null);
      setExpanded(null);
      setReviewExpanded(null);
      setReviewTarget(null);
      setPicker(null);
      setNotice(null);
      try {
        localStorage.setItem(organizationKey, JSON.stringify(next));
      } catch {}
    },
    [organizationKey],
  );
  const { folded, toggle } = useFolds();
  const view = state?.view ?? null;
  const allPrs = useMemo(
    () => minePrs(view, state?.markers ?? [], state?.needsInput ?? {}),
    [view, state?.markers, state?.needsInput],
  );
  const allReviewItems = useMemo(
    () => reviews?.kind === "available" ? reviewsWithPendingInput(reviews.snapshot.items, reviews.needsInput ?? {}) : [],
    [reviews],
  );
  const organizations = useMemo(
    () =>
      [
        ...new Set([
          ...allPrs.map((pr) => repoOwner(pr.row.repo)),
          ...allReviewItems.map((review) => repoOwner(review.item.repo)),
        ]),
      ]
        .filter(Boolean)
        .sort(),
    [allPrs, allReviewItems],
  );
  const completeOrganizations =
    view !== null &&
    state !== null &&
    state.lastSuccess !== null &&
    state.lastError === null &&
    !state.refreshing &&
    reviews?.kind === "available" &&
    reviews.snapshot.lastSuccessAt !== null &&
    reviews.snapshot.lastPoll?.ok === true &&
    error === null &&
    reviewError === null;
  const organizationsLoading =
    (state === null && error === null) ||
    (reviews === null && reviewError === null);
  const organizationItems = [
    { value: "*", label: "All organizations" },
    ...organizations.map((owner) => ({ value: owner, label: owner })),
    ...(organization !== null && !organizations.includes(organization)
      ? [
          {
            value: organization,
            label: `${organization} (${completeOrganizations ? "no pull requests" : organizationsLoading ? "loading…" : "unavailable"})`,
            disabled: !completeOrganizations,
          },
        ]
      : []),
  ];
  const prs = allPrs.filter(
    (pr) => organization === null || repoOwner(pr.row.repo) === organization,
  );
  const reviewItems = allReviewItems.filter(
    (review) =>
      organization === null || repoOwner(review.item.repo) === organization,
  );
  const toReview = reviewItems.filter(
    (review) => review.segment === "on-you",
  ).length;
  const previousSubPath = useRef<string | undefined | null>(null);
  useEffect(() => {
    if (previousSubPath.current === subPath) return;
    const opening = previousSubPath.current === null;
    previousSubPath.current = subPath;
    if (opening && !subPath) {
      if (subPath !== undefined && tab === "review")
        navigate.toPluginPanel("pr-board", { subPath: "to-review" });
      return;
    }
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
  }, [subPath, navigate, tab]);
  useEffect(() => {
    if (!reviewTarget?.pending) return;
    const match = allReviewItems.find(
      (review) =>
        `${review.item.repo}#${review.item.number}` === reviewTarget.key,
    );
    if (match) {
      if (organization !== null && repoOwner(match.item.repo) !== organization)
        changeOrganization(repoOwner(match.item.repo));
      setReviewSegment(match.segment);
      setReviewExpanded(match.item.key);
      setReviewTarget({ ...reviewTarget, pending: false });
    }
  }, [reviews, reviewTarget, organization, changeOrganization]);
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
    (pr) => selected.includes(pr.row.key) && isStartable(pr),
  );
  const stop =
    stopOverride ??
    (selection.some((pr) => pr.row.group === "large") ? "prepare" : "publish");
  const start = async (rows: CalmRow[], policy: Stop) => {
    if (busy || !agentModel || modelSaving) return;
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
        agentModel,
      });
      setNotice(
        `${starting.length ? `${starting.length} ${starting.length === 1 ? "PR" : "PRs"} queued for one thread.` : "No PRs queued."}${skipped.length ? ` ${skipped.length} not queued: ${skipped.map((skip) => `#${skip.key.split("#").pop()} ${skip.reason}`).join(" · ")}` : ""}${items.length > 100 ? ` ${items.length - 100} remain outside this request.` : ""}`,
      );
      setSelected((current) =>
        current.filter((key) => !starting.includes(key)),
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
        all={allPrs}
        view={view}
        expanded={expanded === pr.row.key}
        onExpand={() =>
          setExpanded(expanded === pr.row.key ? null : pr.row.key)
        }
        onStart={(rows, policy) => void start(rows, policy)}
        onReview={onReview}
        onConversation={openConversation}
        answer={(item, option) => void answer(item, option)}
        busy={busy !== null}
        startDisabled={!modelReady || modelSaving}
        questionGroup={questionGroupByPr.get(pr.row.key)}
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
  const asking = onYou.filter(
    hasAgentQuestion,
  );
  const askingKeys = new Set(asking.map((pr) => pr.row.key));
  const finished = prs.filter((pr) => pr.marker?.status === "done" && !askingKeys.has(pr.row.key));
  const questionGroups = groupAgentQuestions(asking);
  const questionGroupByPr = new Map<string, AgentQuestionGroup>();
  for (const group of questionGroups)
    for (const pr of group) questionGroupByPr.set(pr.row.key, group);
  const questionRows = questionGroups.flatMap((group) => group.map(renderRow));
  const group = (id: CalmRow["group"]) =>
    onYou.filter((pr) => pr.row.group === id && !askingKeys.has(pr.row.key));
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
  const changeSelection = (next: string[]) => {
    if (selected.length === 0) setStopOverride(null);
    setSelected(next);
  };
  const sectionAction = (
    title: string,
    members: MinePr[],
    action?: React.ReactNode,
  ) => (
    <>
      <SectionSelection
        title={title}
        keys={members.filter(isStartable).map((pr) => pr.row.key)}
        selected={selected}
        onChange={changeSelection}
      />
      {action}
    </>
  );
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
      action={sectionAction(title, members, action)}
      folded={folded(id)}
      onToggle={() => toggle(id)}
      dots={<FoldDots rows={members} />}
    >
      <ul>{members.map(renderRow)}</ul>
    </EffortGroup>
  );
  const conversationMembers = [
    ...allPrs.flatMap((pr) => pr.marker?.threadId === conversationThread ? [pr.row] : []),
    ...allReviewItems.flatMap((review) => review.item.threadId === conversationThread
      ? [{ ...review.item, key: `${review.item.repo}#${review.item.number}` }]
      : []),
  ];
  const shownConversationKeys = new Set([
    ...prs.map((pr) => pr.row.key),
    ...reviewItems.map((review) => `${review.item.repo}#${review.item.number}`),
  ]);
  const board = (
    <div
      ref={rootRef}
      className="calm-scroller"
      data-prs-agent-panel={panelId}
      data-prs-agent-availability={availability}
    >
      <Tabs
        data-prs-agent-local=""
        render={<main />}
        className="calm-board"
        value={tab}
        onValueChange={(next) => {
          if (next !== null) switchTab(next);
        }}
      >
        <header className="calm-header">
          <TabsList className="calm-tabs" aria-label="Pull request view">
            <TabsTab value="mine">
              Mine <span>{prs.length}</span>
            </TabsTab>
            <TabsTab value="review">
              To review <span className="text-amber">{toReview}</span>
            </TabsTab>
          </TabsList>
          <div className="calm-header-filters">
            <Select
              items={organizationItems}
              value={organization ?? "*"}
              onValueChange={(next, details) => {
                if (next === "*") changeOrganization(null);
                else if (next !== null && organizations.includes(next))
                  changeOrganization(next);
                else details.cancel();
              }}
              disabled={organizations.length === 0 && organization === null}
            >
              <SelectTrigger
                data-prs-agent-local=""
                className="calm-organization"
                aria-label="Organization"
              >
                <SelectValue /> <span aria-hidden>⌄</span>
              </SelectTrigger>
              <SelectContent
                className="calm-organization-menu"
                align="start"
                sideOffset={4}
              >
                {organizationItems.map((item) => (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    disabled={"disabled" in item && item.disabled}
                  >
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div
              className="calm-agent-model"
              role="group"
              aria-label="Agent model for fixes and reviews"
            >
              <span>Agent:</span>
              {agentSettings ? (
                <ProviderModelPicker
                  value={{
                    ...agentSettings.choice,
                    reasoningLevel: agentSettings.choice.reasoningLevel ?? "",
                  }}
                  routing={agentSettings.routing}
                  onChange={({ reasoningLevel, ...choice }) =>
                    void saveModel(
                      reasoningLevel ? { ...choice, reasoningLevel } : choice,
                    )
                  }
                  disabled={!modelReady || modelSaving}
                  align="end"
                  className="calm-agent-model-picker"
                />
              ) : null}
              {!modelReady || modelSaving ? (
                <span role="status">
                  {modelSaving
                    ? "Saving…"
                    : modelError
                      ? "Unavailable"
                      : "Loading…"}
                </span>
              ) : null}
            </div>
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
        {modelError ? (
          <p role="alert" className="calm-notice">
            {modelError}{" "}
            {!modelReady ? (
              <button
                type="button"
                className="calm-link"
                onClick={() => void loadModel()}
              >
                Retry
              </button>
            ) : null}
          </p>
        ) : null}
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
        <TabsPanel value="mine">
          <CheckboxGroup
            data-prs-agent-local=""
            aria-label="Select pull requests for agents"
            value={selected}
            onValueChange={changeSelection}
          >
            {view ? (
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
                      count={questionGroups.length}
                      tone="question"
                      effort="seconds"
                      action={sectionAction("Answer to unblock agents", asking)}
                    >
                      <ul>{questionRows}</ul>
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
                      action={sectionAction(
                        "Small fixes for an agent",
                        small,
                        smallStartable.length ? (
                          <CalmButton
                            primary
                            disabled={
                              busy !== null || !modelReady || modelSaving
                            }
                            title={`Stop at Publish · ${smallStartable.length} eligible`}
                            onClick={() =>
                              void start(
                                smallStartable.map((pr) => pr.row),
                                "publish",
                              )
                            }
                          >
                            <span aria-hidden>▸</span> Start{" "}
                            {Math.min(smallStartable.length, 100)}
                          </CalmButton>
                        ) : null,
                      )}
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
                          disabled={busy !== null || !modelReady || modelSaving}
                          title={`Stop at Prepare · ${largeStartable.length} eligible`}
                          onClick={() =>
                            void start(
                              largeStartable.map((pr) => pr.row),
                              "prepare",
                            )
                          }
                        >
                          <span aria-hidden>▸</span> Prepare{" "}
                          {Math.min(largeStartable.length, 100)}
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
                      count={questionGroups.length}
                      tone="question"
                      action={sectionAction("Finished, asking you", asking)}
                    >
                      <ul>{questionRows}</ul>
                    </EffortGroup>
                    <EffortGroup
                      title="PRs with finished threads"
                      count={finished.length}
                      tone="gray"
                    >
                      <ul>
                        {finished.map(renderRow)}
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
            )}
          </CheckboxGroup>
        </TabsPanel>
        <TabsPanel value="review">
          {reviews?.kind === "available" ? (
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
                key={organization ?? "*"}
                agentModel={modelReady && !modelSaving ? agentModel : null}
                items={reviewItems}
                segment={reviewSegment}
                expanded={reviewExpanded}
                setExpanded={setReviewExpanded}
                folds={folded}
                toggleFold={toggle}
                mine={view?.prs ?? []}
                refetch={refetch}
                onConversation={openConversation}
                needsInput={reviews?.kind === "available" ? reviews.needsInput ?? {} : {}}
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
        </TabsPanel>
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
              disabled={busy !== null || !modelReady || modelSaving}
              onClick={() =>
                void start(
                  selection.map((pr) => pr.row),
                  stop,
                )
              }
            >
              Start {Math.min(selection.length, 100)}
            </CalmButton>
            <button
              type="button"
              className="calm-dismiss"
              aria-label="Clear selection"
              onClick={() => setSelected([])}
            >
              ×
            </button>
            {selection.length > 100 ? (
              <small>{selection.length - 100} outside this request</small>
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
      </Tabs>
    </div>
  );
  return (
    <div className={`calm-workspace${conversationThread ? " conversation-open" : ""}`}>
      {board}
      {conversationThread ? (
        <ConversationPanel
          threadId={conversationThread}
          members={conversationMembers}
          shownKeys={shownConversationKeys}
          onClose={() => setConversationThread(null)}
        />
      ) : null}
    </div>
  );
}
export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "prs-ui-agent-bridge",
    mount: () => disposePrsUiAgentBridge,
  });
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
