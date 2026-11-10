// Stewards: give a labelled Linear ticket or GitHub pull request, or a
// teammate's pull request, a long-lived thread that manages it as the
// developer until it is done. DESIGN.md is the design; this file wires it.
//
// The model is a controller. The spec (the playbook, the entity's own
// description and spec comments, standing guidance) is the desired state; a
// snapshot read through the linear and github-watcher plugins is the observed state;
// a steward's turn is one reconcile. Rings from those plugins (bb-gate-hooks
// doorbells, forwarded) and timers only say "look again". The mechanical tier
// below looks, compares with the last observation, and wakes the steward only
// when something actionable changed.
//
// Configuration lives in the project's `.bb`, read through a project source
// (project-source.ts): multi-repo's RPCs when it is installed, native git on
// the project checkout when it is not. Nothing here reads a file.
import { createHash, randomBytes } from "node:crypto";
import { PluginCliError, cliCommand, defineCli, defineRpcContract, type BbPluginApi, type ExperimentalPluginRpcHandlersWithContext, type PluginCliCommand, type PluginTurnFailedEvent } from "@get-bb/plugin-sdk";

/** The structured failure and rate-limit types `turn.failed` carries (not re-exported by the 0.6.80 SDK). */
type ProviderErrorInfo = NonNullable<PluginTurnFailedEvent["errorInfo"]>;
type ProviderRateLimitState = NonNullable<PluginTurnFailedEvent["rateLimits"]>;
import { z } from "zod";
import {
  DEFAULT_FOLLOW_THROUGH_MS,
  DEFAULT_GITHUB_TICKET_PLAYBOOK,
  DEFAULT_LABEL,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_PLAYBOOKS,
  DEPENDENCY_BOTS,
  DEPS_ALERTS_PLAYBOOK,
  DEPS_PRS_PLAYBOOK,
  ESCALATION_KINDS,
  KINDS,
  PROJECT_FILE,
  ROLES_FILE,
  bindingRoles,
  depsAlertsPlaybookName,
  depsPrsPlaybookName,
  durationSchema,
  filingTargetOf,
  filingTargetProblems,
  formatDuration,
  GITHUB_TODO_LABEL,
  githubStateLabels,
  isTerminal,
  legacyOpsPresent,
  legacyRole,
  modelSpecSchema,
  parsePlaybook,
  parseProjectFile,
  parseRolesFile,
  phaseOf,
  playbookLabels,
  playbookNameFor,
  playbookPath,
  playbookStates,
  projectStewardProblem,
  pullWatchId,
  pullWatchProblems,
  roleDepsTargets,
  roleK8sTargets,
  roleOpsTargets,
  roleOpsTeam,
  roleProblems,
  rolePullWatches,
  rolePulls,
  roleSentryTargets,
  roleUsesOps,
  roleWarnings,
  STAGES,
  ticketWatchId,
  ticketWatchProblems,
  usesKind,
  watchProblems,
  type BindingKind,
  type EscalationKind,
  type FilingTarget,
  type LessonRules,
  type ModelSpec,
  type Playbook,
  type ProjectFile,
  type PullWatch,
  type Role as StewardRole,
  type RolesFile,
  type TicketWatch,
} from "./config.js";
import { decideFor, decideForPull, decideForRefusal, explainDecision, formatDecisionListing, globMatches, type BigDecision } from "./decisions.js";
import { ADOPTION_CHOICES, adoptionChoices, adoptionHow, adoptionQuestion, alertClockAt, alertFingerprint, batchAlert, deadlineAt, depsLookSchema, dueDate, isBatchable, overdue, priorityFor, priorityLabel, priorityLabelForSeverity, reminderText, repoOfFingerprint, sightingOf, snoozeUntil, type DepsFinding, type DepsLook, type DepsTicket } from "./deps.js";
import { hostContract } from "./host-contract.js";
import { MULTI_REPO_ENVIRONMENT_PROVIDER_ID, MULTI_REPO_PLUGIN_ID, multiRepoEnvironmentFlags, multiRepoFreshEnvironment, multiRepoSource, nativeSource, projectSourceLabel, sourceRpcMissing, type FreshEnvironment, type NativeGitRead, type ProjectSource } from "./project-source.js";
import { KUBECTL_VERBS, createKubectlReader, kubectlRefusal, type KubectlResult, type OpsAccess, type OpsReader } from "./kubectl.js";
import { HOOKS_URL_ENV, createHooksLoop, type Lease, type Rejection } from "./hooks-client.js";
import { nightlyDue, stillNight } from "./nightly.js";
import { classify, hasFingerprintLine, lookChanges, opsTargetKey, parseOpsTargetKey, ticketResolved, type DependabotTarget, type FingerprintRow, type K8sTarget, type OpsLook, type OpsTarget, type SentryTarget, type Sighting, type TicketState } from "./ops.js";
import { EVENTS_PER_LOOK, NO_TOKEN, RECENT_PER_LOOK, SENTRY_API_URL, TOKEN_SCOPES, createSentryReader, emptySentryLook, issueInOrg, recentLine, sentryChanges, sentryResolveTargets, sentrySightings, sentrySummary, type SentryFinding, type SentryLook, type SentryReader } from "./sentry.js";
import { advanced, answerDiffers, anyWorkerInFlight, approvalWanted, asksForOpenApproval, classifyApproval, commentDiffersFromRecommendation, compactDue, deploymentSettled, diffObserved, endingDeadline, followingThrough, gateKnownUnmet, gateState, hasLabel, IDLE_WAKE_TEXT, idleInActiveStage, isCommentNews, isOwnStageChange, isSpecComment, latestReviewMarker, lifecycle, mechanicalStatus, namesUserAsBlocker, newHumanComments, newestCommentAt, openUserFacingItems, ownChecksFinished, ownPullClosed, ownPullMerged, phaseAndStage, productGateOptions, resolveChecklistItem, runningWorkerReason, newestEditComment, specDiff, specHash, specText, stuckDue, unheardWait, workerInFlight, workerReportedTerminal, type Change, type MechanicalEvent, type OpenUserItem } from "./reconcile.js";
import { ESCALATED_APPROVAL_REFUSAL, latestProjectApprovalMarker, prGate, PRODUCT_APPROVAL_REFUSAL } from "./gate.js";
import { approvePrPageAction, deliverProjectApproval, fileForwardedApprovePrNeed, markerKey, recordProjectDecision, syncPullApproval, type ApprovalsContext } from "./approvals.js";
import {
  SOURCE_PLUGIN_IDS,
  STEWARDS_PLUGIN_ID,
  entitySnapshotSchema,
  isMissingPlugin,
  signatureLine,
  sourceContract,
  stewardsContract,
  workflowRunSchema,
  type DependabotAlert,
  type DependabotSeverity,
  type Deployment,
  type EntitySnapshot,
  type SessionWake,
  type Source,
  type WorkflowRun,
} from "./source-contract.js";
import { DEPLOY_STATES, allDeployed, applyDeployment, applyDeploymentRead, applyWorkflowRun, awaitingOnRepo, deploymentLines, deploymentReportSchema, matchesTarget, matchesWorkflow, mergedPulls, pickWatch, recordMerged, reportDeployment, targetKeyOf, timeOut, timeoutsDue } from "./deploy.js";
import { evaluateCarries, matchCarriesRule, noRuleNoted, type CarriesReader } from "./carries.js";
import { ACTORS, MIGRATIONS, ESCALATED_NEED_KINDS, NEEDS_KINDS, RESOLUTION_KINDS, createStore, needChoices, type Assumption, type Binding, type DepsDecision, type Escalation, type EscalationRoute, type Fingerprint, type Lesson, type Need, type Observed, type Question, type ReadyState, type Store, type WakeRetry, type Worker } from "./store.js";
import { hasLessonAnchor, lessonAnchor, planLessonTransitions, planValidations, retiredLessonAnchor, withLessonAnchor } from "./lessons.js";
import { AFTER_THE_FACT_RATIONALE_WHY, REPEAT_RATIONALE_WHY, ROUTINE_RATIONALE_WHY, clusterKey, routineRationaleWanted } from "./rationale.js";
import { GUIDANCE_UNIT_PREFIX, GUIDANCE_UNCITED_DAYS, escalationWeeks, parseGuidanceUnits, uncitedGuidanceUnits, type GuidanceUnit } from "./guidance.js";
import { createGhWriter, parsePullRef, type BranchProtection, type GithubWriter, type GithubTreeEntry } from "./github.js";
import { allPullsMerged, atWork, conflictsOf, finished, normalizeTouches, openPull, overlapping, touchesOverlap, type Conflict } from "./schedule.js";
import { AUTOMATIC_NAVIGATION_PROVIDER, AUTOMATIC_THREAD_LIST_PROVIDER, BUILTIN_NAVIGATION_ID, BUILTIN_THREAD_LIST_ID, NAVIGATION_PROVIDER_KEY, THREAD_LIST_PROVIDER_KEY } from "./sidebar-provider.js";
import { waitingOnNamesWorker } from "./sidebar.js";
import { advanceStall, hasLiveWakeSource, parseUntil, type WakeSourceInput } from "./wake-source.js";
import { PROJECT_CHANGED } from "./channels.js";
import { LINEAR_TICKETS, PLAYBOOK_TEMPLATES, projectFileTemplate } from "./templates.js";
import type { DeploymentTarget } from "./config.js";
import { PROJECT_STEWARD_INTRO, bindingMayMerge, choicesNote, formatBrief, formatDepsWake, formatOpsWake, formatProjectWake, formatSentryWake, formatSessionWake, formatWake, spawnCommand, workerFinishNote, workerQuestion, workerReportedError, workerWaiting, workflowRunLine, type DigestRecords, type PendingRequest, type WakeReason, type WorkerQuestion } from "./wake.js";
import { KNOWN_PLAYBOOKS, buildSurvey, formatSurvey, surveyWantedPaths, type Available, type SurveyBb, type SurveyLinear, type SurveyRepoInput, type SurveyReport } from "./survey.js";

export { MULTI_REPO_ENVIRONMENT_PROVIDER_ID, MULTI_REPO_PLUGIN_ID };

/**
 * The per-turn system context the SDK injects is capped at 32768 characters on
 * bb 0.49 (through 0.48 it was 4096); the cap applies to this plugin's text
 * alone, the SDK adds its wrapper as a separate section. Build the brief under
 * the cap so `fit`'s clip marker and the head and tail the clip keeps always
 * fit.
 *
 * 30000 comes from the longest shipped playbook in templates.ts: github-reviews
 * is ~9 KB with three guidance entries and a hold, and ~12 KB with twenty, so
 * the whole phase and general section of every shipped playbook fits with a
 * generous guidance list and room for a hand-written playbook. It leaves ~2700
 * characters under the 32768 cap, and matches WAKE_MAX_CHARS, so a brief and a
 * wake clip at the same point.
 */
export const BRIEF_MAX_CHARS = 30_000;

/**
 * What thread-briefs is asked to leave alone, seeded into this plugin's
 * metadata namespace on each thread it spawns (thread-briefs' README, "Threads
 * a plugin runs"). Every steward keeps the title it was given, which carries
 * the entity key, and is archived by this plugin when its binding ends, or
 * when a wake turn ends waiting on someone else, rather than whenever its
 * brief reads done between wakes. Stewards stay out of the status sections,
 * where one idle between wakes would read done: the project steward is never
 * finished, and a steward is finished when its binding ends. Their rows draw
 * no ring either: a brief would say done about work that is still open.
 *
 * One switch for every thread this plugin spawns — steward, project steward,
 * worker or reviewer — so thread-briefs writes no brief for any of them.
 */
export const THREAD_BRIEFS_OFF = false;

/**
 * The first turn of a "Set up stewards" thread. The onboarding skill carries
 * the procedure; this only says what the thread is for, and that it is an
 * ordinary thread, not the project steward.
 */
export const ONBOARDING_INTRO = `Set up stewards for this project. Follow the onboarding skill: run \`bb stewards survey --json\` first and read each repo's README, then ask one batched interview under ten questions. Write a minimal \`.bb\` (\`bb stewards init\`, then fill project.json with repo-dir-prefixed bigDecisions paths, roles.json and a short AGENTS.md), validate it with \`bb stewards check\`, and land it with \`workspace_publish_guidance\` and a pull request on the primary repo that lists every assumption. Run \`bb stewards enable\` only after that pull request merges. You are an ordinary thread, not the project steward.`;

export interface Timing {
  /** Rings for one entity within this long are one look. */
  debounceMs: number;
  /** How long a project's configuration is reused before `.bb` is read again. */
  configTtlMs: number;
  /** The mechanical sweep: adoption backstop, stuck backstop, a look at every binding. */
  sweepMs: number;
  /** How often requeue timers are checked. */
  requeueTickMs: number;
  /** Between two nightly turns. */
  nightlyStaggerMs: number;
  /** A wrap-up or stop turn that has not finished in this long is finished for it (follow-through has its own cap, from the playbook). */
  endingTimeoutMs: number;
  /** A steward that ends this many woken turns in a row without a report is stuck. */
  missedReportsForStuck: number;
  /** How far back a user's words are looked for when an approval is recorded. */
  approvalLookbackMs: number;
  /** How often `spawnSteward` re-checks the project steward's environment while it attaches (BB-111). */
  environmentPollMs: number;
  /** How long `spawnSteward` waits for that environment before giving the steward its own (BB-111). */
  environmentWaitMs: number;
  /** BB-255: the base of the backoff before retrying a failed wake (doubles per attempt). */
  wakeRetryBaseMs: number;
}

export const DEFAULT_TIMING: Timing = {
  debounceMs: 3000,
  configTtlMs: 5 * 60_000,
  sweepMs: 30 * 60_000,
  requeueTickMs: 60_000,
  nightlyStaggerMs: 20_000,
  endingTimeoutMs: 60 * 60_000,
  missedReportsForStuck: 3,
  approvalLookbackMs: 24 * 60 * 60_000,
  environmentPollMs: 1000,
  environmentWaitMs: 60_000,
  wakeRetryBaseMs: 15_000,
};

/** BB-255: the plugin retries its own failed wake up to this many attempts (the original is attempt 1). */
export const WAKE_RETRY_MAX_ATTEMPTS = 3;

/** BB-55: the backstop wake when a report passes the ready gate and the turn ends with no worker started. */
export const START_WORKER_WAKE = "The ready gate passed on your last turn and nothing holds you: start the worker.";

export interface StewardsDeps {
  now: () => number;
  timing?: Partial<Timing>;
  /** Runs kubectl for ops bindings: on the project's machine, through the host entry, by default. */
  kubectl?: (args: string[], where: { projectId: string; hostId: string | null }) => Promise<KubectlResult>;
  /** Reads the project's `.bb` from `origin/<default>` for the native source: the host entry by default. */
  git?: (input: { projectId: string; hostId: string | null; path: string; files: string[]; fetch: boolean }) => Promise<NativeGitRead>;
  /** The GitHub writer the page's Approve and Merge buttons use; the server's gh login by default. */
  github?: GithubWriter;
  /** What reads Sentry and subscribes to bb-gate-hooks for it; global fetch by default. */
  fetch?: typeof fetch;
  /** Where BB_HOOKS_URL is read from; the process environment by default. */
  env?: Record<string, string | undefined>;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The comparable form of a message: whitespace collapsed, trimmed, lowercased. */
const normalizeText = (text: string) => text.replace(/\s+/gu, " ").trim().toLowerCase();

/**
 * The key a text the plugin sent is recorded under, so the ready gate can tell
 * the plugin's own wakes from the owner's words (BB-178). Content, not the
 * thread: the same wake to two stewards is the same plugin text.
 */
const sentHash = (text: string) => createHash("sha256").update(normalizeText(text)).digest("hex");

/**
 * The text parts of a `client/turn/requested` event's input, joined; null when
 * it carries none. bb stores a turn's input as parts under `data.input`, with
 * the words in the `text` parts (BB-178).
 */
function turnText(input: unknown): string | null {
  if (!Array.isArray(input)) return null;
  const parts = input.flatMap((part) => {
    if (typeof part !== "object" || part === null) return [];
    const p = part as { type?: unknown; text?: unknown };
    return p.type === "text" && typeof p.text === "string" ? [p.text] : [];
  });
  return parts.length === 0 ? null : parts.join("\n");
}

/** The server setting the footer toggle stores the replaced navigation in (BB-184). */
export const NAVIGATION_RESTORE_KEY = "sidebar.navigationRestore";

/**
 * BB-45/BB-184: pin bb's own sidebar thread list and navigation for clients
 * that have not opted in.
 *
 * BB-44 registers the stewards list through the exclusive
 * `experimental_threadList` slot, and BB-184 registers the stewards navigation
 * through `experimental_sidebarNavigation`. bb resolves an unset
 * (`__automatic__`) provider to the first installed provider other than the
 * bundled one — the stewards plugin's — so both would win by default the
 * moment the image rolls, for people with the stewards list off too. Set each
 * preference to the bundled id on load; an explicit value (including the
 * stewards ids the footer toggle writes) is left alone. `bb.onInstall` does
 * not run for plugins baked into the `bb-server` image, so this runs on load.
 * Best-effort: a failure is logged and the sidebar keeps working.
 */
export async function pinSidebarThreadListProvider(bb: BbPluginApi): Promise<void> {
  try {
    const { preferences } = await bb.sdk.system.uiPreferences.list();
    const threadList = preferences[THREAD_LIST_PROVIDER_KEY];
    if (threadList === undefined || threadList.value === AUTOMATIC_THREAD_LIST_PROVIDER) {
      await bb.sdk.system.uiPreferences.set({
        key: THREAD_LIST_PROVIDER_KEY,
        value: BUILTIN_THREAD_LIST_ID,
        expectedRevision: threadList?.revision ?? 0,
      });
      bb.log.info(`stewards: pinned the sidebar thread list to ${BUILTIN_THREAD_LIST_ID}; the footer toggle switches it to ${STEWARDS_PLUGIN_ID}/sidebar`);
    }
    const navigation = preferences[NAVIGATION_PROVIDER_KEY];
    if (navigation === undefined || navigation.value === AUTOMATIC_NAVIGATION_PROVIDER) {
      await bb.sdk.system.uiPreferences.set({
        key: NAVIGATION_PROVIDER_KEY,
        value: BUILTIN_NAVIGATION_ID,
        expectedRevision: navigation?.revision ?? 0,
      });
      bb.log.info(`stewards: pinned the sidebar navigation to ${BUILTIN_NAVIGATION_ID}; the footer toggle switches it to ${STEWARDS_PLUGIN_ID}/navigation`);
    }
  } catch (error) {
    bb.log.warn(`stewards: could not pin the sidebar providers: ${errorMessage(error)}`);
  }
}
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** "owner/repo" from a GitHub remote URL, or null for anything else. */
export function githubRepoOf(url: string): string | null {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(url.trim());
  return m === null ? null : `${m[1]}/${m[2]}`;
}

// What this plugin reads from multi-repo. Loose: multi-repo's views carry more.
const readFilesOutput = z
  .object({ projectSourcePath: z.string().nullable(), head: z.string().nullable(), files: z.array(z.object({ path: z.string(), content: z.string().nullable() }).loose()), error: z.string().nullable() })
  .loose();
const repoSetOutput = z
  .object({
    repos: z.array(z.object({ dir: z.string(), url: z.string() }).loose()),
    /** The project source's own origin, for a lesson's pull request (BB-108). */
    primary: z.object({ dir: z.string(), url: z.string() }).loose().nullable().default(null),
    layout: z.enum(["primary", "directory"]),
    error: z.string().nullable(),
  })
  .loose();
const mergeGuidanceOutput = z.object({ ok: z.boolean(), sha: z.string().nullable(), branch: z.string().nullable(), message: z.string() }).loose();

/** A project checkout fetch can be slow; the git host call is allowed this long. */
const GIT_TIMEOUT_MS = 60_000;
/** One config load makes several native reads; only the first fetches within this window. */
const NATIVE_FETCH_TTL_MS = 60_000;

/** The checkout directory's own name, for a native project's single repo entry. */
const checkoutDirName = (path: string): string => path.replace(/[\\/]+$/u, "").split(/[\\/]/u).filter((part) => part !== "").at(-1) ?? "project";

/**
 * The `guidance-<thread>` ref a thread's `.bb` commits are published on.
 * Duplicated from multi-repo's `guidanceRef` because it is a contract between
 * the two: `workspace_publish_guidance` computes it from the calling thread,
 * and a lesson records it before the merge so the page can name it.
 */
export const lessonBranchFor = (threadId: string): string => `refs/heads/guidance-${threadId.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 60)}`;

/** Whitespace-normalised text, so a lesson matches however the playbook wraps it. */
const normalizeLessonText = (text: string) => text.replace(/\s+/gu, " ").trim();

/**
 * One action a needs-you item offers: an RPC write, or a link to open. The
 * server builds the list once (BB-122) so the page and the sidebar cannot
 * disagree about an item's buttons.
 */
const needActionSchema = z.union([
  z.object({
    label: z.string(),
    /** The write this action makes; `answer` goes to `stewardsAnswerQuestion`, the rest to `stewardsNeedAction`. */
    action: z.enum(["approve", "decline", "done", "merge", "provide", "choose", "answer"]),
    /** With `choose` (or a question's fixed choice): the label passed as `choice`; null for a free-text action. */
    choice: z.string().nullable(),
    /** Whether this is the item's primary button. */
    primary: z.boolean(),
    /** Whether a note box makes sense with this action. */
    note: z.boolean(),
  }),
  z.object({
    label: z.string(),
    /** A link to open in the browser: Open PR, Open ticket. */
    url: z.string(),
  }),
]);
/** One entry in a needs-you view's `actions` list. */
export type NeedAction = z.infer<typeof needActionSchema>;

/** An http(s) URL, or null for anything else (a Linear key, a lesson id). */
const httpUrl = (url: string | null): string | null => (url !== null && /^https?:\/\//iu.test(url) ? url : null);

/**
 * A credential's variable name, as it appears in an escalation's question or
 * context (e.g. `VOICE_TRANSCRIPTION_API_KEY`). A forward that carries one is
 * refused as `done` or `text`, so the value always reaches the user as bb's
 * secure form, whatever the ticket or spec says (BB-176).
 */
const CREDENTIAL_VARIABLE = /\b[A-Z][A-Z0-9_]*_(?:API_KEY|SECRET|TOKEN|PASSWORD)\b/u;

/** Whether an escalation names a credential variable in its question or context. */
const namesCredential = (escalation: Escalation): boolean =>
  CREDENTIAL_VARIABLE.test(escalation.question) || (escalation.context !== null && CREDENTIAL_VARIABLE.test(escalation.context));

// One row each in the board's "waiting on you" section. The sidebar reuses
// these shapes, tagged, for its "Needs you" list, so the two surfaces cannot
// disagree about what an item is.
//
// Each view also carries the `actions` the item offers, built once by the
// server functions below, so the page and the sidebar render the same buttons
// and cannot drift (BB-122).
const questionViewSchema = z.object({
  id: z.string(),
  question: z.string(),
  context: z.string().nullable(),
  choices: z.array(z.string()),
  key: z.string().nullable(),
  url: z.string().nullable(),
  escalationId: z.string().nullable(),
  createdAt: z.number(),
  /** Why the page shows a rationale box, or null when it must not (BB-35 step 4). */
  rationaleWanted: z.string().nullable(),
  /** The buttons this question offers, built once on the server (BB-122). */
  actions: z.array(needActionSchema),
  /** Whether the page offers Other… for a free-text answer (BB-122). */
  freeText: z.boolean(),
});
const withUserViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  question: z.string(),
  /** The evidence and reasoning the escalation carries; the page shows it under the question. */
  context: z.string().nullable(),
  recommendation: z.string().nullable(),
  key: z.string(),
  url: z.string().nullable(),
  threadId: z.string().nullable(),
  createdAt: z.number(),
  rationaleWanted: z.string().nullable(),
  /** The buttons this escalation offers; empty today, since it is answered in its steward's thread (BB-122). */
  actions: z.array(needActionSchema),
  /** Whether the page offers Other… for a free-text answer (BB-122). */
  freeText: z.boolean(),
});
const needViewSchema = z.object({
  id: z.string(),
  bindingId: z.string(),
  key: z.string(),
  kind: z.string(),
  url: z.string().nullable(),
  /** The binding's own link (its ticket or pull request), so the key opens the entity, not the item's `url`. */
  entityUrl: z.string().nullable(),
  /** The escalation this item answers, when the project steward forwarded one. */
  escalationId: z.string().nullable(),
  /** Fixed choices the user picks from, for a `decide` item; empty otherwise. */
  choices: z.array(z.string()),
  /** The lesson a `decide` item is about, when it is a boundary lesson; null otherwise. */
  lessonId: z.string().nullable(),
  /** A boundary lesson's pull request, for the page's "Review PR" link (BB-108); null otherwise. */
  prUrl: z.string().nullable(),
  what: z.string(),
  how: z.string().nullable(),
  /** BB-249: for a re-approval after an edit, the unified diff from the approved text; null on a first approval. Empty with `specChangedLines` 0 when the change was whitespace only. */
  specDiff: z.string().nullable().default(null),
  /** BB-249: the diff's changed-line count, 0 for a whitespace-only change; null on a first approval. */
  specChangedLines: z.number().nullable().default(null),
  /** BB-249: the nearest `Spec:`/`Criteria:` comment's link, when one explains the edit. */
  specCommentUrl: z.string().nullable().default(null),
  /** BB-249: the current spec text, for the item's full-text toggle. */
  specFullText: z.string().nullable().default(null),
  /** For a provide-secret item: where the value goes, in words. */
  destination: z.string().nullable(),
  threadId: z.string().nullable(),
  createdAt: z.number(),
  /** Whether the server can verify the preconditions now; when false, `why` says what is missing. */
  actionable: z.boolean(),
  why: z.string().nullable(),
  /** The buttons this need offers, built once on the server (BB-122). */
  actions: z.array(needActionSchema),
  /** Whether the page offers Other… for a free-text answer (BB-122). */
  freeText: z.boolean(),
});
/** One "needs you" item in the sidebar, tagged so the app knows which write it makes. */
const sidebarNeedsItemSchema = z.discriminatedUnion("type", [
  questionViewSchema.extend({ type: z.literal("question"), /** The binding's entity key, so a row owns its item (BB-76); null for a project-level question. */ bindingKey: z.string().nullable() }),
  withUserViewSchema.extend({ type: z.literal("withUser"), bindingKey: z.string() }),
  needViewSchema.extend({ type: z.literal("need"), bindingKey: z.string() }),
]);

/**
 * The actions a need offers, per kind. This is the page's old per-kind switch,
 * moved to the server so the sidebar and the page render the same buttons
 * (BB-122). `freeText` is true when the item has fixed choices and can also
 * take a free-text answer, which the page hides behind Other…; the sidebar
 * drops that action because it has no text box.
 */
export function needActions(n: { kind: string; data: Record<string, unknown>; url: string }, b: Pick<Binding, "url">): { actions: NeedAction[]; freeText: boolean } {
  const actions: NeedAction[] = [];
  const url = httpUrl(n.url);
  const prUrl = httpUrl(typeof n.data.prUrl === "string" ? n.data.prUrl : null);
  const ticket = httpUrl(b.url);
  switch (n.kind) {
    case "approve-spec":
      if (ticket !== null) actions.push({ label: "Open ticket", url: ticket });
      actions.push({ label: "Approve", action: "approve", choice: null, primary: true, note: true });
      actions.push({ label: "Decline", action: "decline", choice: null, primary: false, note: true });
      return { actions, freeText: false };
    case "approve-pr":
      if (url !== null) actions.push({ label: "Open PR", url });
      actions.push({ label: "Approve", action: "approve", choice: null, primary: true, note: true });
      actions.push({ label: "Decline", action: "decline", choice: null, primary: false, note: true });
      return { actions, freeText: false };
    case "merge":
      if (url !== null) actions.push({ label: "Open PR", url });
      actions.push({ label: "Merge", action: "merge", choice: null, primary: true, note: false });
      return { actions, freeText: false };
    case "configure":
      actions.push({ label: "Done", action: "done", choice: null, primary: true, note: true });
      return { actions, freeText: false };
    case "provide-secret":
      actions.push({ label: "Provide", action: "provide", choice: null, primary: true, note: false });
      actions.push({ label: "Done", action: "done", choice: null, primary: false, note: false });
      return { actions, freeText: false };
    case "decide": {
      // BB-213: a need the plugin auto-filed from an actor-`user` report is a
      // plain "Done" item. Its `nextAction` is prose, not a question, so it has
      // no choices, no text box and no other button; Done resolves it and wakes
      // the steward like any other closed item.
      if (n.data.autoFiled === true) {
        actions.push({ label: "Done", action: "done", choice: null, primary: true, note: false });
        return { actions, freeText: false };
      }
      const choices = needChoices(n);
      // A boundary lesson's Review PR/Drop are its only choices: no free-text
      // "Other…", and no note box (BB-35 step 5, BB-108).
      const lesson = typeof n.data.lessonId === "string";
      for (const choice of choices) actions.push({ label: choice, action: "choose", choice, primary: true, note: false });
      if (prUrl !== null) actions.push({ label: "Open PR", url: prUrl });
      if (lesson) return { actions, freeText: false };
      actions.push({ label: "Answer", action: "done", choice: null, primary: true, note: true });
      return { actions, freeText: choices.length > 0 };
    }
    default:
      // A kind with no branch still gets its buttons, so a new kind does not
      // need a client change (BB-122).
      actions.push({ label: "Answer", action: "done", choice: null, primary: true, note: true });
      return { actions, freeText: false };
  }
}

/**
 * The actions a question offers: one button per fixed choice, then a free-text
 * Answer the page hides behind Other… when there are choices (BB-122).
 */
export function questionActions(q: Pick<Question, "choices">): { actions: NeedAction[]; freeText: boolean } {
  const actions: NeedAction[] = [];
  for (const choice of q.choices) actions.push({ label: choice, action: "answer", choice, primary: true, note: false });
  actions.push({ label: "Answer", action: "answer", choice: null, primary: true, note: true });
  return { actions, freeText: q.choices.length > 0 };
}

/**
 * The actions a with-user escalation offers. A forwarded approval is answered
 * in its steward's thread and one the project steward has not forwarded waits
 * on it; neither has an RPC action of its own (BB-122).
 */
export function withUserActions(): { actions: NeedAction[]; freeText: boolean } {
  return { actions: [], freeText: false };
}

/** One RPC method's or CLI command's in-memory stat (BB-100). */
const methodStatSchema = z.object({
  count: z.number(),
  totalMs: z.number(),
  maxMs: z.number(),
  lastMs: z.number(),
  lastAt: z.number().nullable(),
});
/** The plugin's in-memory handler table, read by `bb stewards stats` and the Status section (BB-100). */
const statsSchema = z.object({
  rpc: z.record(z.string(), methodStatSchema),
  cli: z.record(z.string(), methodStatSchema),
  /** Signals published per project in the last hour. */
  signals: z.record(z.string(), z.number()),
});
export type StewardStats = z.infer<typeof statsSchema>;

/** The steward's own surface for the app and the CLI. Cross-plugin methods are in source-contract.ts. */
export const rpcContract = defineRpcContract({
  ...stewardsContract,
  stewardsList: {
    input: z.object({ projectId: z.string().min(1).max(100).nullable(), all: z.boolean() }),
    output: z.object({
      bindings: z.array(
        z.object({
          id: z.string(),
          projectId: z.string(),
          key: z.string(),
          kind: z.string(),
          phase: z.string().nullable(),
          threadId: z.string().nullable(),
          summary: z.string().nullable(),
          nextAction: z.string().nullable(),
          actor: z.string().nullable(),
          escalations: z.number(),
          needs: z.number(),
          ended: z.boolean(),
        }),
      ),
    }),
  },
  // The settings page: what is stewarded, per project, and whether it is healthy.
  stewardsOverview: {
    input: z.null(),
    output: z.object({
      paused: z.boolean(),
      lastSweepAt: z.number().nullable(),
      /** The plugin's in-memory per-method stat, for the Status section (BB-100). */
      stats: statsSchema,
      projects: z.array(
        z.object({
          projectId: z.string(),
          name: z.string(),
          configured: z.boolean(),
          /** No project file, or no project steward in roles.json: offer the onboarding action. */
          onboard: z.boolean(),
          /** Whether this server stewards the project: its local, per-project switch. */
          enabled: z.boolean(),
          /** Which project source reads this project's `.bb`: multi-repo or native git (BB-107). */
          source: z.enum(["multi-repo", "native"]).nullable(),
          label: z.string().nullable(),
          linearTeams: z.array(z.string()),
          repos: z.array(z.string()),
          excludedRepos: z.array(z.string()),
          playbooks: z.array(z.object({ kind: z.string(), name: z.string(), version: z.string().nullable(), source: z.enum(["linear", "github"]).nullable() })),
          problems: z.array(z.string()),
          nightly: z.object({ at: z.string(), timezone: z.string() }).nullable(),
          lastNight: z.string().nullable(),
          projectStewardThreadId: z.string().nullable(),
          digestAt: z.number().nullable(),
          endedCount: z.number(),
          stewards: z.array(
            z.object({
              key: z.string(),
              url: z.string().nullable(),
              title: z.string().nullable(),
              kind: z.string(),
              phase: z.string().nullable(),
              threadId: z.string().nullable(),
              summary: z.string().nullable(),
              nextAction: z.string().nullable(),
              actor: z.string().nullable(),
              waitingOn: z.string().nullable(),
              /** When a dated wait parks the binding, for `waiting on <text> until <date>` (BB-247). */
              waitingUntil: z.number().nullable(),
              /** Waiting with nothing the plugin tracks to wake it (BB-154). */
              noWakeSource: z.boolean(),
              /** BB-255: a failed wake's phrase, `wake failed: <reason>`; null when the last wake landed. */
              wakeFailure: z.string().nullable(),
              priority: z.string().nullable(),
              hold: z.string().nullable(),
              /** Entity keys this hold waits behind, for the row's `held behind <keys>` phrase. */
              holdBehind: z.array(z.string()),
              /** Entity keys this stack-wait waits for a pull request to open (BB-215). */
              holdStack: z.array(z.string()),
              /** Something waits on the user, so the shared BB-78 row is yellow. */
              needsUser: z.boolean(),
              /** An open `stuck` escalation: the row is blocked (BB-78). */
              stuck: z.boolean(),
              /** The newest deployment watch's state, or null with none (BB-78). */
              deployment: z.enum(DEPLOY_STATES).nullable(),
              /** Notes queued for the next turn, so a quiet worker finish can be shown (BB-83). */
              pending: z.array(z.object({ text: z.string(), quiet: z.boolean().optional() })),
              /** When the binding is next due a look, for `next look <time>` (BB-83). */
              requeueAt: z.number().nullable(),
              ending: z.string().nullable(),
              statusAt: z.number().nullable(),
              createdAt: z.number(),
              /** The role name(s) whose definition owns this binding's target (BB-163); empty for a binding under no role. Optional so a client built from the previous image still validates. */
              roles: z.array(z.string()).optional(),
              /** The running-worker count; the query already filters to workers whose status is running. */
              workers: z.number(),
              escalations: z.array(z.object({ kind: z.string(), route: z.string(), question: z.string() })),
            }),
          ),
        }),
      ),
    }),
  },
  stewardsCheck: {
    input: z.object({ projectId: z.string().min(1).max(100) }),
    output: z.object({ ok: z.boolean(), lines: z.array(z.string()) }),
  },
  // BB-184: the footer toggle's remembered navigation provider, so turning the
  // stewards list off restores what the user had. One value per server.
  stewardsNavigationRestore: {
    input: z.null(),
    output: z.object({ value: z.string().nullable() }),
  },
  stewardsSetNavigationRestore: {
    input: z.object({ value: z.string().min(1).max(200) }),
    output: z.object({ ok: z.boolean() }),
  },
  // The settings page's per-project toggle: this server's local switch for a project.
  stewardsSetProjectEnabled: {
    input: z.object({ projectId: z.string().min(1).max(100), enabled: z.boolean() }),
    output: z.object({ ok: z.boolean(), message: z.string(), enabled: z.boolean() }),
  },
  // The Stewards page's "Set up stewards": spawn an ordinary thread with the onboarding skill.
  stewardsOnboard: {
    input: z.object({ projectId: z.string().min(1).max(100) }),
    output: z.object({ ok: z.boolean(), threadId: z.string().nullable(), message: z.string() }),
  },
  // The stewards page: one project's board. A null projectId picks the first project.
  stewardsBoard: {
    input: z.object({ projectId: z.string().min(1).max(100).nullable() }),
    output: z.object({
      /** Every configured project, for the picker, with this server's local switch. */
      projects: z.array(z.object({ projectId: z.string(), name: z.string(), enabled: z.boolean() })),
      board: z
        .object({
          projectId: z.string(),
          name: z.string(),
          /** Whether this server stewards the project: its local, per-project switch (BB-119). */
          enabled: z.boolean(),
          paused: z.boolean(),
          projectStewardThreadId: z.string().nullable(),
          /** The role names this server's login holds, shown beside the project (BB-163). Optional so a client built from the previous image still validates. */
          roleNames: z.array(z.string()).optional(),
          /** The playbook schema's stages, in order: the page groups in-flight stewards by them. */
          stages: z.array(z.string()),
          digest: z.object({ text: z.string(), at: z.number() }).nullable(),
          questions: z.array(questionViewSchema),
          /** Open escalations with the user that no question covers: approval requests, and forwards from before questions were kept. */
          withUser: z.array(withUserViewSchema),
          /** "Needs you" items: links and the one-click action each supports. */
          needs: z.array(needViewSchema),
          /**
           * Every lesson, whatever its tier: the collapsed details block at
           * the bottom of the project tab, rows behind a disclosure, no
           * buttons (BB-35 step 4).
           */
          lessons: z.array(
            z.object({
              id: z.string(),
              bindingId: z.string().nullable(),
              key: z.string().nullable(),
              file: z.string(),
              text: z.string(),
              scope: z.string(),
              status: z.string(),
              /** The lifecycle tier (BB-35 step 3): candidate, trial, promoted, retired. */
              tier: z.string(),
              hits: z.number(),
              corrections: z.number(),
              lastCitedAt: z.number().nullable(),
              branch: z.string().nullable(),
              mergeSha: z.string().nullable(),
              note: z.string().nullable(),
              escalationId: z.string().nullable(),
              createdAt: z.number(),
            }),
          ),
          /** Lessons by tier, for the collapsed block's summary (BB-35 step 4). */
          lessonCounts: z.object({ candidate: z.number(), trial: z.number(), promoted: z.number(), retired: z.number() }),
          stewards: z.array(
            z.object({
              key: z.string(),
              url: z.string().nullable(),
              title: z.string().nullable(),
              kind: z.string(),
              phase: z.string().nullable(),
              stage: z.string().nullable(),
              threadId: z.string().nullable(),
              summary: z.string().nullable(),
              nextAction: z.string().nullable(),
              actor: z.string().nullable(),
              waitingOn: z.string().nullable(),
              /** When a dated wait parks the binding, for `waiting on <text> until <date>` (BB-247). */
              waitingUntil: z.number().nullable(),
              /** Waiting with nothing the plugin tracks to wake it (BB-154). */
              noWakeSource: z.boolean(),
              /** BB-255: a failed wake's phrase, `wake failed: <reason>`; null when the last wake landed. */
              wakeFailure: z.string().nullable(),
              priority: z.string().nullable(),
              /** The hold reason, for the card's `On hold` line; null when not held. */
              hold: z.string().nullable(),
              /** Entity keys this hold waits behind, for the row's `held behind <keys>` phrase. */
              holdBehind: z.array(z.string()),
              /** Entity keys this stack-wait waits for a pull request to open (BB-215). */
              holdStack: z.array(z.string()),
              /** Something waits on the user: the row is yellow and the card shows its items (BB-78). */
              needsUser: z.boolean(),
              /** An open `stuck` escalation: the row is blocked (BB-78). */
              stuck: z.boolean(),
              /** The newest deployment watch's state, or null with none (BB-78). */
              deployment: z.enum(DEPLOY_STATES).nullable(),
              /** Notes queued for the next turn, so a quiet worker finish can be shown (BB-83). */
              pending: z.array(z.object({ text: z.string(), quiet: z.boolean().optional() })),
              /** When the binding is next due a look, for `next look <time>` (BB-83). */
              requeueAt: z.number().nullable(),
              ending: z.string().nullable(),
              /** The last status report's timestamp, for the card's `Reported` line; null with no report. */
              statusAt: z.number().nullable(),
              /** When the binding was adopted, for the card's `adopted` line. */
              createdAt: z.number(),
              /** The last wake, shown on an ops monitor row. */
              wokeAt: z.number().nullable(),
              advancedAt: z.number().nullable(),
              /** The role name(s) whose definition owns this binding's target (BB-163); empty for a binding under no role. Optional so a client built from the previous image still validates. */
              roles: z.array(z.string()).optional(),
              /** The running workers, each a link; the count is their length. */
              workers: z.array(z.object({ threadId: z.string(), title: z.string() })),
              /** The binding's open recorded assumptions (BB-251), shown on its card. */
              assumptions: z.array(z.object({ id: z.string(), text: z.string(), context: z.string().nullable(), recordedAt: z.number(), recordedBy: z.string() })),
            }),
          ),
          stuck: z.array(z.object({ key: z.string(), url: z.string().nullable(), threadId: z.string().nullable(), why: z.string(), since: z.number().nullable() })),
          ended: z.array(z.object({ key: z.string(), url: z.string().nullable(), title: z.string().nullable(), kind: z.string(), endReason: z.string().nullable(), endedAt: z.number(), threadId: z.string().nullable() })),
        })
        .nullable(),
    }),
  },
  // The sidebar thread list's one call: one project's bindings, workers and
  // "needs you" items, plus the picker's per-project needs count. The requested
  // project is the input, or the first by name when null; a client built from
  // the previous image still validates because `reviewers` stays optional for
  // one release (BB-100).
  stewardsSidebar: {
    input: z.object({ projectId: z.string().min(1).max(100).nullable() }),
    output: z.object({
      /** Every stewarded project, for the picker, with its needs-you binding count and claimed thread ids. */
      projects: z.array(
        z.object({
          projectId: z.string(),
          name: z.string(),
          needsCount: z.number(),
          /**
           * The project's steward and worker thread ids, so the picker skips
           * them when it sums unread one-off roots for a project whose
           * bindings this call does not carry (BB-160). Optional so a client
           * built from the previous image tolerates its absence.
           */
          claimedThreadIds: z.array(z.string()).optional(),
        }),
      ),
      /** The project the rest of the payload is for; null when nothing is stewarded. */
      projectId: z.string().nullable(),
      projectStewardThreadId: z.string().nullable(),
      /**
       * The picked project's role problem for this server (BB-105), e.g. `No
       * role for <login> in stewards/roles.json`; null when it has a role (or
       * no roles.json). The sidebar shows it where the home page shows the
       * same line.
       */
      roleProblem: z.string().nullable(),
      /**
       * The board's "waiting on you" items, in the sidebar's own shape: the
       * same questions, with-user escalations and actionable needs, tagged
       * so the app knows which write a choice makes. `count` is their sum;
       * a non-actionable need is in neither the items nor the count.
       */
      needs: z.object({ count: z.number(), items: z.array(sidebarNeedsItemSchema) }),
      bindings: z.array(
        z.object({
          key: z.string(),
          kind: z.string(),
          stage: z.string().nullable(),
          /** The entity's own phase, for line two; null when the binding has none (ops). */
          phase: z.string().nullable(),
          threadId: z.string().nullable(),
          /** The parent binding's entity key, or null; the sidebar nests the effort under it (BB-245). */
          parentKey: z.string().nullable(),
          hold: z.string().nullable(),
          /** Entity keys this hold waits behind, for `held behind <keys>`. */
          holdBehind: z.array(z.string()),
          /** Entity keys this stack-wait waits for a pull request to open (BB-215). */
          holdStack: z.array(z.string()),
          waitingOn: z.string().nullable(),
          /** When a dated wait parks the binding, for `waiting on <text> until <date>` (BB-247). */
          waitingUntil: z.number().nullable(),
          /** Waiting with nothing the plugin tracks to wake it (BB-154). */
          noWakeSource: z.boolean(),
          /** BB-255: a failed wake's phrase, `wake failed: <reason>`; null when the last wake landed. */
          wakeFailure: z.string().nullable(),
          needsUser: z.boolean(),
          /** An open `stuck` escalation: the row is blocked (BB-76). */
          stuck: z.boolean(),
          /** The status report's actor, next action and timestamp; null with no report. */
          status: z.object({ actor: z.string(), nextAction: z.string(), at: z.number() }).nullable(),
          /** The newest deployment watch's state, or null with none (BB-76). */
          deployment: z.enum(DEPLOY_STATES).nullable(),
          /** Notes queued for the next turn, so a quiet worker finish can be shown (BB-83). */
          pending: z.array(z.object({ text: z.string(), quiet: z.boolean().optional() })),
          /** When the binding is next due a look, for `next look <time>` (BB-83). */
          requeueAt: z.number().nullable(),
          advancedAt: z.number().nullable(),
          /** The binding's live workers: running, finished, or ended within the last hour (BB-100). */
          workers: z.array(z.object({ threadId: z.string(), title: z.string(), status: z.string() })),
          /**
           * Retained as an optional output for one release so a client built
           * from the previous image tolerates its absence across a restart;
           * the server no longer sends it, and the client derives reviewers
           * from the thread tree (BB-100).
           */
          reviewers: z.array(z.object({ threadId: z.string(), workerThreadId: z.string() })).optional(),
        }),
      ),
      ended: z.array(z.object({ key: z.string(), kind: z.string(), threadId: z.string().nullable(), title: z.string().nullable(), phase: z.string().nullable(), endReason: z.string().nullable(), endedAt: z.number() })),
    }),
  },
  // The user answers a question from the page with text, or picks one of its
  // fixed choices.
  stewardsAnswerQuestion: {
    input: z.object({
      questionId: z.string().min(1).max(100),
      answer: z.string().trim().max(4000).nullable().optional(),
      choice: z.string().trim().min(1).max(100).nullable().optional(),
      /** The rationale the page collected, when it showed the box (BB-35 step 4); empty is accepted. */
      rationale: z.string().trim().max(4000).nullable().optional(),
    }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  },
  // The user presses a button on a "needs you" item: approve or decline a spec,
  // approve a pull request, merge one, mark a configure step done, or provide a
  // secret. It runs as the connected user, unsigned.
  stewardsNeedAction: {
    input: z.object({
      needId: z.string().min(1).max(100),
      action: z.enum(["approve", "decline", "done", "merge", "provide", "choose"]),
      note: z.string().trim().max(4000).nullable().optional(),
      /** With action `choose`: the label, which must be one of the item's choices. */
      choice: z.string().trim().min(1).max(100).nullable().optional(),
    }),
    output: z.object({ ok: z.boolean(), message: z.string(), threadId: z.string().nullable().optional() }),
  },
});

/**
 * BB-255: the consent provider-retry asks the plugin that sent a failed turn
 * before it re-runs that turn. Core's `provider-retry` plugin defines the
 * contract, not the SDK, so a plugin that wants to answer registers its own
 * copy (core's automations plugin does). Stewards declines its own wakes: it
 * re-runs them itself, and a double retry races (the second `threads.retry`
 * gets 409 `retry_already_queued`). An owner-typed turn on a steward thread is
 * left to provider retry.
 */
export const RETRY_CONSENT_METHOD = "provider-retry.v1.consent";
export const retryConsentSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("allow") }), z.object({ kind: z.literal("decline"), reason: z.string().min(1) })]);
export type RetryConsent = z.infer<typeof retryConsentSchema>;
export const retryConsentContract = defineRpcContract({
  [RETRY_CONSENT_METHOD]: {
    input: z.object({
      threadId: z.string().min(1),
      requestId: z.string().min(1),
      reason: z.enum(["Rate limited", "Provider overloaded", "Provider unavailable"]),
      sendAt: z.number().int().nonnegative(),
    }),
    output: retryConsentSchema,
    experimental_description: "Asked of the plugin that sent a failed turn before provider retry re-runs it. Stewards declines its own wakes, which it re-runs itself; allow leaves the retry to provider retry.",
  },
});

/** How long an ended binding stays on the page. */
const ENDED_ON_BOARD_MS = 14 * 86_400_000;

type ProjectConfig = {
  projectId: string;
  /** The chosen project source (multi-repo or native), cached with the config. */
  source: ProjectSource;
  file: ProjectFile;
  /** The roles file, when one is present and parses (or its last good copy). */
  roles: RolesFile | null;
  /** Whether roles.json is present, so role dispatch is on rather than the legacy project.ops. */
  rolesPresent: boolean;
  /** Whether roles.json is present but this server's GitHub or Linear login could not be read. */
  rolesUnreadable: boolean;
  /** This server's signed-in GitHub login, as the github plugin reads it, or null. */
  githubLogin: string | null;
  /** This server's connected Linear user, as the linear plugin reads it, or null. */
  linearLogin: string | null;
  /** The role this server runs: its login's entry, a legacy project.ops role, or null. */
  role: StewardRole | null;
  /** The role names this server's login holds (version 2), or the synthesized login (version 1); empty with no entry. */
  roleNames: string[];
  playbooks: Partial<Record<BindingKind, Playbook>>;
  /** The ticket playbooks by source (BB-234): a project may carry both `linear-tickets` and `github-issues`. */
  ticketPlaybooks: Partial<Record<Source, Playbook>>;
  /** The dependency watch's alert playbook, when it parses. */
  depsAlerts: Playbook | null;
  /** The Dependabot pull request playbook, when it parses. */
  depsPrs: Playbook | null;
  /** The playbooks a role's declared pull watches name, by name, when they parse (BB-164). */
  watchPlaybooks: Map<string, Playbook>;
  /** GitHub repos from the project's repos.json, as owner/repo, less github.exclude. */
  repos: string[];
  /** Whether this server stewards the project: a local, per-project setting, off until switched on. */
  enabled: boolean;
  /** What is wrong with the configuration, in sentences; bindings keep running under the last good playbook. */
  problems: string[];
  /** Non-error lines a `check` shows, such as a role with no holder or the version 1 migration hint. */
  warnings: string[];
  /** One-line hints a `check` shows without marking the project unhealthy. */
  hints: string[];
  loadedAt: number;
};

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/**
 * A spec decline's objections, one per line or `;`, with list markers
 * stripped. A single line with no break is one objection (BB-54).
 */
function objectionLines(text: string): string[] {
  const lines = text
    .split(/\r?\n|;\s+/u)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, "").trim())
    .filter((l) => l !== "");
  return lines;
}

/** An objection compared for "the same objection": case and punctuation ignored. */
const normObjection = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();

// BB-164 moved DEPENDENCY_BOTS into config.ts, where the synthesized watch is
// built; re-exported here so existing callers and tests keep reading it.
export { DEPENDENCY_BOTS };

/**
 * Fixed choices on a `decide` need or an escalation: two to six short,
 * distinct labels, so the page can show one button each. Never a
 * multi-select.
 */
export const choicesSchema = z
  .array(z.string().trim().min(1).max(60))
  .min(2)
  .max(6)
  .refine((labels) => new Set(labels).size === labels.length, "choices must be distinct");

/**
 * The dotenv value `bb secret request` wrote for one variable, or null. The
 * file is read on the invoking thread's host through `bb.sdk.files`; only the
 * named variable's value is returned, and the value is never logged.
 */
export function parseDotenvValue(content: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=\\s*(.*)$`, "u");
  for (const line of content.split(/\r?\n/u)) {
    const match = pattern.exec(line);
    if (match === null) continue;
    return unquoteDotenvValue(stripDotenvComment((match[1] ?? "").trim()));
  }
  return null;
}

function stripDotenvComment(raw: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = quote === ch ? null : (quote ?? ch);
      continue;
    }
    if (ch === "#" && quote === null && i > 0 && /\s/u.test(raw[i - 1] ?? "")) return raw.slice(0, i).trimEnd();
  }
  return raw;
}

function unquoteDotenvValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw
      .slice(1, -1)
      .replace(/\\n/gu, "\n")
      .replace(/\\r/gu, "\r")
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, "\\");
  }
  return raw;
}

/** Where a provide-secret item's value goes, for the page and the requester prompt. */
export function secretDestination(need: Pick<Need, "data">): string | null {
  const setting = typeof need.data.setting === "string" && need.data.setting.trim() !== "" ? need.data.setting.trim() : null;
  if (setting !== null) return `the stewards setting ${setting}`;
  const writeEnv = typeof need.data.writeEnv === "string" && need.data.writeEnv.trim() !== "" ? need.data.writeEnv.trim() : null;
  if (writeEnv !== null) return `the dotenv ${writeEnv}`;
  return "a dotenv on this machine";
}

/** The env var a provide-secret item's dotenv holds: `variable`, else the setting name in SCREAMING_SNAKE_CASE. */
export function secretVariable(need: Pick<Need, "what" | "data">): string {
  const variable = typeof need.data.variable === "string" && need.data.variable.trim() !== "" ? need.data.variable.trim() : null;
  if (variable !== null) return variable;
  const setting = typeof need.data.setting === "string" && need.data.setting.trim() !== "" ? need.data.setting.trim() : null;
  if (setting !== null) return setting.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/[^A-Za-z0-9_]/gu, "_").toUpperCase();
  return need.what.trim();
}

/**
 * The fixed prompt the plugin gives the requester thread it spawns for a
 * provide-secret need. The form opens in that thread's first turn; the value
 * never reaches the agent, argv, logs or the timeline. The prompt says what to
 * report when the request fails, so the steward is told.
 */
export function requesterPrompt(b: Pick<Binding, "entityKey">, need: Pick<Need, "what" | "data">, writeEnv: string): string {
  const variable = secretVariable(need);
  const rawPurpose = typeof need.data.purpose === "string" && need.data.purpose.trim() !== "" ? need.data.purpose.trim() : `the value ${b.entityKey} needs`;
  const purpose = rawPurpose.replace(/\s+/gu, " ");
  const setting = typeof need.data.setting === "string" && need.data.setting.trim() !== "" ? need.data.setting.trim() : null;
  const lines = [
    `You are a one-task requester thread started by the stewards plugin for ${b.entityKey}. The user is waiting to enter a secret through bb's secure form. Do only this; do not explore the workspace or do anything else.`,
    "",
    "Run this command and wait for the user to submit the form in this thread:",
    "",
    `    bb secret request ${variable} --purpose ${JSON.stringify(purpose)} --write-env ${JSON.stringify(writeEnv)}`,
  ];
  if (setting !== null) {
    lines.push("", "Then, once it succeeds, run:", "", `    bb stewards secret import --from ${JSON.stringify(writeEnv)} --setting ${setting}`);
  }
  lines.push(
    "",
    "The form is masked; the value never reaches you, argv, logs or the timeline. Never read, echo or cat the dotenv file. When it succeeds, reply with one short line saying the secret was provided.",
    "If the request fails or is cancelled, reply with one line saying what failed (the error code or message). Do not retry more than once, and never paste any value.",
  );
  return lines.join("\n");
}

export const STEWARDS_SETTINGS = {
  paused: {
    type: "boolean",
    label: "Pause stewards",
    description: "No steward is woken and nothing new is adopted while this is on. Changes still queue up and are delivered when it is turned off.",
    default: false,
  },
  workerSpawnsPerHour: {
    type: "number",
    label: "Worker spawns per binding per hour",
    description: "The runaway guard: a steward that tries to start more workers than this in an hour is refused. Not a budget.",
    default: 6,
  },
  compactAboveTokens: {
    type: "number",
    label: "Compact a steward above this many context tokens",
    description: "After a steward's or the project steward's turn, and before a wake that would push it over, its context is compacted when it holds more than this. Every wake is self-contained, so little is lost. 0 leaves compaction to the provider.",
    default: 120_000,
  },
  sentryToken: {
    type: "string",
    secret: true,
    label: "Sentry token",
    description: `A Sentry user auth token with the scopes ${TOKEN_SCOPES.join(" and ")}, for the ops stewards of sentry-project targets: the plugin reads each project's issues with it and proves its bb-gate-hooks leases with it. Created at Settings → Account → API → Auth Tokens in Sentry.`,
  },
  sentryApiUrl: {
    type: "string",
    label: "Sentry API",
    description: "Where Sentry is read; change it for a self-hosted Sentry.",
    default: SENTRY_API_URL,
  },
} as const;

/** The declared settings a provide-secret need may name: only `secret: true` fields are accepted. */
export const SECRET_SETTING_NAMES = new Set(Object.entries(STEWARDS_SETTINGS).filter(([, descriptor]) => "secret" in descriptor && descriptor.secret === true).map(([name]) => name));

export function createStewardsPlugin(deps: StewardsDeps): (bb: BbPluginApi) => Promise<void> {
  return async (bb) => {
    const timing: Timing = { ...DEFAULT_TIMING, ...deps.timing };
    const now = deps.now;
    const github = deps.github ?? createGhWriter();
    const settings = bb.settings.define(STEWARDS_SETTINGS);
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const env = deps.env ?? process.env;

    // BB-178: the moment this plugin started recording the texts it sends. A
    // turn older than this cannot be told from the owner's own words — the
    // plugin's wakes before a restart were recorded with `initiator: "user"`
    // too — so `userSaid` ignores them. Set once, on the first load that tracks.
    const sentSince = await (async () => {
      const stored = await bb.storage.kv.get<number>("sent-since");
      if (typeof stored === "number") return stored;
      const at = now();
      await bb.storage.kv.set("sent-since", at);
      return at;
    })();

    // The in-memory per-method handler table (BB-100). bb core's own handler
    // stat is keyed by plugin id only, so RPCs, doorbells, CLI commands and the
    // nightly schedule share one bucket and a core change is out of scope; this
    // table is the plugin's own, read by `bb stewards stats` and the Status
    // section. It is per process, like the debug lines BB-95 added.
    type MethodStat = { count: number; totalMs: number; maxMs: number; lastMs: number; lastAt: number | null };
    const methodStats = { rpc: new Map<string, MethodStat>(), cli: new Map<string, MethodStat>() };
    /** Published signals, for the per-project count in the last hour. */
    const signalLog: Array<{ projectId: string; at: number }> = [];
    function recordStat(kind: "rpc" | "cli", name: string, ms: number): void {
      const table = methodStats[kind];
      const entry = table.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0, lastAt: null };
      entry.count += 1;
      entry.totalMs += ms;
      entry.maxMs = Math.max(entry.maxMs, ms);
      entry.lastMs = ms;
      entry.lastAt = now();
      table.set(name, entry);
    }
    async function measured<T>(kind: "rpc" | "cli", name: string, fn: () => T | Promise<T>): Promise<T> {
      const started = now();
      try {
        return await fn();
      } finally {
        recordStat(kind, name, now() - started);
      }
    }
    function statsSnapshot(): StewardStats {
      const table = (m: Map<string, MethodStat>) => Object.fromEntries([...m.entries()].map(([name, stat]) => [name, { ...stat }]));
      const cutoff = now() - 3_600_000;
      const signals: Record<string, number> = {};
      for (const s of signalLog) if (s.at >= cutoff) signals[s.projectId] = (signals[s.projectId] ?? 0) + 1;
      return { rpc: table(methodStats.rpc), cli: table(methodStats.cli), signals };
    }
    /** Wrap every RPC handler with `measured`, so the table covers every method, not a hand-picked list. */
    function measuredHandlers<T extends Record<string, (...args: never[]) => unknown>>(kind: "rpc" | "cli", handlers: T): T {
      return Object.fromEntries(
        Object.entries(handlers).map(([name, handler]) => [
          name,
          (...args: unknown[]) => measured(kind, name, () => (handler as (...a: unknown[]) => unknown)(...args)),
        ]),
      ) as unknown as T;
    }
    /** Wrap every CLI command's `run` with `measured`, keeping its declaration inert. */
    function measuredCommands(commands: Record<string, PluginCliCommand>): Record<string, PluginCliCommand> {
      const out: Record<string, PluginCliCommand> = {};
      for (const [name, command] of Object.entries(commands)) {
        out[name] = { ...command, run: (input, ctx) => measured("cli", name, () => command.run(input, ctx)) };
      }
      return out;
    }

    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    // The store reports a project whose sidebar- or board-visible state
    // changed; the sidebar, the board page and the overview refetch on the
    // channel. Keeping it a callback keeps store.ts free of bb, so
    // steward-side mutations publish too.
    const store = createStore(db, now, {
      log: (message) => bb.log.info(message),
      onProjectChange: (projectId, columns) => {
        // One debug line per published signal, with the project and the
        // coalesced columns, so the next slowdown has numbers (BB-95).
        bb.log.debug(`stewards: signal for project ${projectId} (${columns.length === 0 ? "no columns" : columns.join(", ")})`);
        // The per-project signal count keeps only the last hour (BB-100).
        signalLog.push({ projectId, at: now() });
        const cutoff = now() - 3_600_000;
        while (signalLog.length > 0 && signalLog[0]!.at < cutoff) signalLog.shift();
        bb.realtime.publish(PROJECT_CHANGED, { projectId });
      },
    });

    const rpc = <T>(pluginId: string, method: string, input: unknown, outputSchema: z.ZodType<T>, signal?: AbortSignal): Promise<T> =>
      bb.sdk.plugins.callRpc<T>({ pluginId, method, input: input as never, outputSchema, ...(signal === undefined ? {} : { signal }) });
    const sourceRpc = <T>(source: Source, method: string, input: unknown, outputSchema: z.ZodType<T>): Promise<T> =>
      rpc(SOURCE_PLUGIN_IDS[source], method, input, outputSchema);

    // ---- push-notifications (BB-253) ----------------------------------------------------------------
    //
    // Steward trees are muted and needs-you items push, both through the
    // push-notifications plugin's published RPCs. A missing plugin, or a
    // loaded one whose contract predates a method, is "not available": the
    // call is skipped, one line is logged, and nothing else changes. That
    // keeps the plugin usable on a server that predates the RPC, exactly as
    // the source contract treats a missing stewards plugin.

    const PUSH_NOTIFICATIONS_PLUGIN_ID = "push-notifications";
    const MUTE_OUTPUT = z
      .object({
        own: z.enum(["inherit", "all", "input-only", "muted"]),
        ancestorCap: z.object({ level: z.enum(["all", "input-only", "muted"]), threadId: z.string().min(1) }).strict().nullable(),
      })
      .strict();
    const SEND_OUTPUT = z.object({ ok: z.literal(true), channels: z.array(z.enum(["web", "desktop", "mobile"])) }).strict();

    /** The one log line for a push-notifications plugin or method that is not there. */
    let pushUnavailableNoted = false;
    function notePushUnavailable(error: unknown): void {
      if (pushUnavailableNoted) return;
      pushUnavailableNoted = true;
      bb.log.info(`stewards: push-notifications is not available (${errorMessage(error)}); steward mutes and needs-you pushes are skipped`);
    }

    /**
     * Mute one thread the plugin spawned, so the steward, its workers and
     * their reviewers are silent (BB-253). True when done, or when
     * push-notifications is not available and there is nothing to do; false
     * only on a real failure, so a sweep can leave its one-time marker unset
     * and retry on the next start.
     */
    async function muteStewardThread(threadId: string): Promise<boolean> {
      try {
        await rpc(PUSH_NOTIFICATIONS_PLUGIN_ID, "threadNotifications.set", { threadId, level: "muted" }, MUTE_OUTPUT);
        return true;
      } catch (error) {
        if (rpcUnavailable(error)) {
          notePushUnavailable(error);
          return true;
        }
        bb.log.warn(`stewards: could not mute ${threadId}: ${errorMessage(error)}`);
        return false;
      }
    }

    /**
     * Push one needs-you item, cut by the plugin to its title and body limits
     * (BB-253). The tap opens `threadId` when one is given. Off through the
     * project file's `notifications.enabled` disables pushes only; a missing
     * push-notifications plugin is skipped, logged once, never an error.
     */
    async function pushNeed(b: Binding, fields: { id: string; title: string; body: string; threadId: string | null }): Promise<void> {
      const config = await loadConfig(b.projectId);
      if (config !== null && !config.file.notifications.enabled) return;
      try {
        await rpc(PUSH_NOTIFICATIONS_PLUGIN_ID, "notifications.send", { title: fields.title, body: fields.body, ...(fields.threadId === null ? {} : { threadId: fields.threadId }) }, SEND_OUTPUT);
      } catch (error) {
        if (rpcUnavailable(error)) notePushUnavailable(error);
        else bb.log.warn(`stewards: could not push ${fields.id}: ${errorMessage(error)}`);
      }
    }

    /** The push title and body for a newly filed gate item, or null for a kind that never pushes. */
    function gatePushText(b: Binding, item: Need): { title: string; body: string } | null {
      const title = b.title ?? "";
      if (item.kind === "approve-spec" || item.kind === "approve-pr") return { title: `${b.entityKey} needs your approval`, body: title };
      if (item.kind === "merge") return { title: `${item.what.replace(/^Merge\s+/u, "")} ready to merge`, body: title };
      return null;
    }

    /**
     * Push every gate item filed since `before`, in order (BB-253). Used where
     * a forward files an `approve-spec` or `approve-pr` item outside a
     * reconcile, so it is pushed at filing exactly as `syncNeeds` pushes the
     * items it files. `before` is the open ids read before the filing, so a
     * refresh of an item that was already open stays quiet.
     */
    async function pushNewGateNeeds(b: Binding, before: Set<string>): Promise<void> {
      for (const item of store.openNeeds(b.id)) {
        if (before.has(item.id)) continue;
        const text = gatePushText(b, item);
        if (text !== null) await pushNeed(b, { id: item.id, ...text, threadId: b.threadId });
      }
    }

    /**
     * The login a source acts as: the gh login github-watcher reads, or the
     * connected Linear user's name. A source that is not connected, or cannot
     * be asked, answers null; roles.json then runs no roles rather than every
     * role (BB-105).
     */
    async function readViewer(source: Source, label: string): Promise<string | null> {
      try {
        // The contract wants a label even with no units to check; the project's own is the honest one.
        const out = await sourceRpc(source, "sourceValidate", { units: [], label, states: [] }, sourceContract.sourceValidate.output);
        return out.viewer;
      } catch (error) {
        bb.log.warn(`stewards: could not read the ${source} login: ${errorMessage(error)}`);
        return null;
      }
    }

    /** The plugin's own project-steward approval records for a binding; the gate matches a posted marker to one by comment id. */
    const projectApprovalsFor = (b: Binding) => store.projectApprovals(b.id);

    /** The repo-relative paths a pull request changes, or null when they cannot be read (which fails closed to the user). */
    async function pullChangedFiles(entity: EntitySnapshot): Promise<string[] | null> {
      if (entity.pull === null || github.files === undefined) return null;
      const ref = parsePullRef(entity.url ?? entity.key);
      if (ref === null) return null;
      try {
        return await github.files(ref.repo, ref.number);
      } catch (error) {
        bb.log.warn(`stewards: could not read ${entity.key}'s changed files (${errorMessage(error)})`);
        return null;
      }
    }

    // ---- serial work and debounce ----------------------------------------------------
    //
    // Work on one binding (or one entity, before it has a binding) never
    // overlaps: a promise chain per key. Different keys run concurrently.

    const chains = new Map<string, Promise<void>>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let disposed = false;
    bb.onDispose(() => {
      disposed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    });

    function serial(key: string, fn: () => Promise<void>): Promise<void> {
      const previous = chains.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => (disposed ? undefined : fn()))
        .catch((error: unknown) => bb.log.warn(`stewards: ${key}: ${errorMessage(error)}`))
        .finally(() => {
          if (chains.get(key) === next) chains.delete(key);
        });
      chains.set(key, next);
      return next;
    }

    function debounce(key: string, fn: () => Promise<void>): void {
      if (disposed || timers.has(key)) return;
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          void fn();
        }, timing.debounceMs),
      );
    }

    /** Look at a binding again, soon, once however often this is called meanwhile. */
    const scheduleReconcile = (bindingId: string) => debounce(`b:${bindingId}`, () => serial(`b:${bindingId}`, () => reconcileBinding(bindingId, null)));

    // ---- configuration ----------------------------------------------------------------

    const configs = new Map<string, { at: number; value: ProjectConfig | null }>();
    /**
     * The read in flight for a project, so a burst of calls after the TTL
     * makes one read rather than one per caller (BB-104).
     */
    const configReads = new Map<string, Promise<ProjectConfig | null>>();
    /**
     * The last configuration-read failure per project. A project whose layout
     * multi-repo refuses (a leftover root `repos.json`, say) has no last good
     * config to carry the problem line, so the failure is kept here and shown
     * for that project alone. A successful read clears it.
     */
    const configErrors = new Map<string, string>();

    /** The RPC-backed multi-repo source for one project: the three RPCs as they always were. */
    function multiRepoSourceFor(projectId: string): ProjectSource {
      return multiRepoSource({
        readFiles: async (paths) => {
          const out = await rpc(MULTI_REPO_PLUGIN_ID, "readProjectFiles", { projectId, paths }, readFilesOutput);
          if (out.error !== null && out.files.length === 0) throw new Error(out.error);
          return new Map(out.files.map((f) => [f.path, f.content]));
        },
        repoSet: async () => {
          const set = await rpc(MULTI_REPO_PLUGIN_ID, "repoSet", { projectId }, repoSetOutput);
          return { repos: set.repos, primary: set.primary, layout: set.layout, error: set.error };
        },
        mergeGuidance: (threadId, file, text) => rpc(MULTI_REPO_PLUGIN_ID, "mergeGuidance", { projectId, threadId, file, text }, mergeGuidanceOutput),
      });
    }

    /** The last native fetch per project, so one config load's several reads fetch once. */
    const nativeFetchedAt = new Map<string, number>();

    /**
     * The git-backed native source for one project. The host entry does the
     * fetch and the read (project-git.ts), on the checkout's own machine; the
     * server never touches a file. `deps.git` is the test seam.
     */
    function nativeSourceFor(projectId: string): ProjectSource {
      const run = async (files: string[]): Promise<{ read: NativeGitRead; path: string | null }> => {
        const checkout = await projectCheckout(projectId);
        if (checkout === null) return { read: { head: null, files: [], remote: null, defaultBranch: null, layout: "primary", error: null }, path: null };
        const last = nativeFetchedAt.get(projectId) ?? 0;
        const fetch = now() - last >= NATIVE_FETCH_TTL_MS;
        if (fetch) nativeFetchedAt.set(projectId, now());
        const read =
          deps.git !== undefined
            ? await deps.git({ projectId, hostId: checkout.hostId, path: checkout.path, files, fetch })
            : await (hostClient ??= bb.hosts.experimental_client({ contract: hostContract })).call("gitProjectFiles", { path: checkout.path, files, fetch }, { hostId: checkout.hostId, timeoutMs: GIT_TIMEOUT_MS });
        return { read, path: checkout.path };
      };
      return nativeSource({
        readFiles: async (paths) => {
          const { read } = await run(paths);
          // The host names a file it could not read (too large, a bad object);
          // surface it even when other files came back, so the problem line
          // names it instead of a silent missing file.
          if (read.error !== null) throw new Error(read.error);
          return new Map(read.files.map((f) => [f.path, f.content]));
        },
        repoSet: async () => {
          const { read, path } = await run([]);
          const entry = read.remote === null || path === null ? null : { dir: checkoutDirName(path), url: read.remote };
          return { repos: entry === null ? [] : [entry], primary: entry, layout: read.layout, error: read.error };
        },
      });
    }

    /**
     * Choose the project source once per config load. The multi-repo read is
     * the probe: only a missing-plugin error selects native (BB-107); any
     * other failure keeps multi-repo and propagates, so the last good config
     * is kept and the failure is shown as a problem line (readConfigShared).
     */
    async function selectProjectSource(projectId: string): Promise<{ source: ProjectSource; files: Map<string, string | null> | null }> {
      try {
        const out = await rpc(MULTI_REPO_PLUGIN_ID, "readProjectFiles", { projectId, paths: [PROJECT_FILE, ROLES_FILE] }, readFilesOutput);
        if (out.error !== null && out.files.length === 0) throw new Error(out.error);
        return { source: multiRepoSourceFor(projectId), files: new Map(out.files.map((f) => [f.path, f.content])) };
      } catch (error) {
        if (sourceRpcMissing(error)) {
          bb.log.info(`stewards: multi-repo is not installed; reading project ${projectId} from native git`);
          return { source: nativeSourceFor(projectId), files: null };
        }
        throw error;
      }
    }

    /** Read `.bb` files through the project's chosen source, for callers that do not already hold the config. */
    async function readFiles(projectId: string, paths: string[]): Promise<Map<string, string | null>> {
      const config = await loadConfig(projectId);
      if (config === null) throw new Error(`no ${PROJECT_FILE} for project ${projectId}`);
      return config.source.readFiles(paths);
    }

    /**
     * Read a project's configuration once: on success the result replaces the
     * cache entry, on failure the last good entry is kept. A call while a read
     * is in flight joins it, so a burst makes one read (BB-104).
     */
    function readConfigShared(projectId: string): Promise<ProjectConfig | null> {
      const inFlight = configReads.get(projectId);
      if (inFlight !== undefined) return inFlight;
      const promise = readConfig(projectId)
        .then((value) => {
          configs.set(projectId, { at: now(), value });
          configErrors.delete(projectId);
          return value;
        })
        .catch((error: unknown) => {
          // Unreachable `.bb` is not "no stewards": keep what we had. A
          // non-missing RPC failure stays on the last good source (BB-107) and
          // is shown as a problem line rather than silently swallowed.
          const message = errorMessage(error);
          bb.log.warn(`stewards: could not read the configuration of project ${projectId}: ${message}`);
          configErrors.set(projectId, message);
          const last = configs.get(projectId)?.value ?? null;
          if (last !== null) {
            const line = `could not read the configuration: ${message}`;
            if (!last.problems.includes(line)) last.problems.push(line);
          }
          return last;
        })
        .finally(() => {
          if (configReads.get(projectId) === promise) configReads.delete(projectId);
        });
      configReads.set(projectId, promise);
      return promise;
    }

    /**
     * The project's stewards configuration, or null when the project has none.
     * A file that fails to parse falls back to the last good copy, kept in kv,
     * and the failure is reported as a problem rather than stopping anything.
     *
     * Stale-while-revalidate (BB-104): with an entry in hand it is returned at
     * once, and one background read refreshes it once it is older than the TTL,
     * so the `.bb` read never blocks the sidebar. A miss still blocks, so the
     * first read after a restart is unchanged, and `force` still awaits a fresh
     * copy for the callers that need one (the sweep, the reconcile, nightly).
     */
    async function loadConfig(projectId: string, force = false): Promise<ProjectConfig | null> {
      const cached = configs.get(projectId);
      if (!force && cached !== undefined) {
        if (now() - cached.at >= timing.configTtlMs) void readConfigShared(projectId);
        return cached.value;
      }
      return readConfigShared(projectId);
    }

    async function readConfig(projectId: string): Promise<ProjectConfig | null> {
      const problems: string[] = [];
      const warnings: string[] = [];
      const hints: string[] = [];
      const selected = await selectProjectSource(projectId);
      const enabled = await projectEnabled(projectId);
      const source = selected.source;
      const configFiles = selected.files ?? (await source.readFiles([PROJECT_FILE, ROLES_FILE]));
      const projectText = configFiles.get(PROJECT_FILE) ?? null;
      if (projectText === null) return null;
      let file: ProjectFile;
      const parsed = parseProjectFile(projectText);
      if (parsed.ok) {
        file = parsed.value;
        await bb.storage.kv.set(`good/${projectId}/project`, projectText);
      } else {
        problems.push(parsed.error);
        const last = await bb.storage.kv.get<string>(`good/${projectId}/project`);
        const lastParsed = typeof last === "string" ? parseProjectFile(last) : null;
        if (lastParsed === null || !lastParsed.ok) {
          bb.log.warn(`stewards: ${parsed.error}`);
          return null;
        }
        file = lastParsed.value;
      }

      /**
       * The per-person roles file (BB-105). It is optional: without it a
       * project runs the legacy `project.ops` on every server, exactly as
       * before. A file that fails to parse falls back to the last good copy,
       * kept in kv, and the failure is a problem. A file present with no good
       * copy runs no roles rather than falling back to the legacy ops.
       */
      const rolesText = configFiles.get(ROLES_FILE) ?? null;
      const rolesPresent = rolesText !== null;
      let roles: RolesFile | null = null;
      if (rolesText !== null) {
        const rolesParsed = parseRolesFile(rolesText);
        if (rolesParsed.ok) {
          roles = rolesParsed.value;
          await bb.storage.kv.set(`good/${projectId}/roles`, rolesText);
        } else {
          problems.push(rolesParsed.error);
          const last = await bb.storage.kv.get<string>(`good/${projectId}/roles`);
          const lastParsed = typeof last === "string" ? parseRolesFile(last) : null;
          if (lastParsed !== null && lastParsed.ok) {
            roles = lastParsed.value;
            problems.push(`${ROLES_FILE} keeps running under the last good copy.`);
          }
        }
      }

      /**
       * The role this server runs. With no roles.json, the legacy project.ops
       * is every server's role, as before. With one, the entry keyed by this
       * server's GitHub login; no entry runs no watches and no project
       * steward, and the home page says so. A login that cannot be read
       * adopts nothing and shows one problem line (BB-115, addendum 2): with
       * roles.json it runs no roles, and the legacy ops watch keeps running
       * because it does not need a login.
       */
      let githubLogin: string | null = null;
      let linearLogin: string | null = null;
      let role: StewardRole | null;
      let roleNames: string[] = [];
      let rolesUnreadable = false;
      // The GitHub login is read whether or not roles.json is present: a
      // labelled pull request is adopted only where its GitHub login is the
      // author, a review only where it is a requested reviewer, and a GitHub
      // issue only where it is an assignee (BB-234). The Linear login is read
      // only when the project tracks Linear teams: a GitHub-only project does
      // not need it, and a Linear plugin that is not connected must not make
      // `check` fail for one (BB-234).
      const usesLinear = file.linear.teams.length > 0;
      githubLogin = await readViewer("github", file.label);
      linearLogin = usesLinear ? await readViewer("linear", file.label) : null;
      if (githubLogin === null || (usesLinear && linearLogin === null)) {
        rolesUnreadable = true;
        const which = githubLogin === null ? "GitHub" : "Linear";
        if (rolesPresent) {
          role = null;
          problems.push(`${ROLES_FILE} is present but this server's ${which} login cannot be read; running no roles`);
        } else {
          // The legacy ops watch does not need a login; only adoption does.
          // Keep running it and adopt nothing (BB-115, addendum 2).
          role = legacyRole(file);
          problems.push(`this server's ${which} login cannot be read; adopting nothing`);
        }
      } else if (rolesPresent) {
        role = roles?.roles[lc(githubLogin)] ?? null;
        roleNames = roles?.holders[lc(githubLogin)] ?? [];
        if (roles !== null && role === null) problems.push(`No role for ${githubLogin} in ${ROLES_FILE}`);
      } else {
        role = legacyRole(file);
      }
      if (roles !== null) {
        // Version 2 validation and the version 1 migration hint. The
        // problems never change what runs: a holder's roles are already
        // merged into `role`, and an unknown name is simply ignored there.
        problems.push(...roleProblems(roles));
        warnings.push(...roleWarnings(roles));
        if (roles.version === 1) hints.push(`hint: ${ROLES_FILE} is version 1; version 2 defines named roles once under "roles" and lists who holds them under "holders" (see the stewards README).`);
      }
      // The migration line stays whether or not roles.json is present: the
      // legacy ops no longer runs once roles.json wins, but the watch is not
      // moved until the project file drops it.
      if (legacyOpsPresent(file)) problems.push(`ops now belongs in ${ROLES_FILE}`);

      const kinds = KINDS.filter((k) => usesKind(file, k, role));
      const names = new Map(kinds.filter((k) => k !== "ticket").map((k) => [k, playbookNameFor(file, k)] as const));
      const depsAlertsName = depsAlertsPlaybookName(file);
      const depsPrsName = depsPrsPlaybookName(file);
      // BB-234: a project may carry both a Linear and a GitHub ticket
      // playbook. An explicitly named ticket playbook is required; with none
      // named, either default may serve and at least one must exist, so an
      // existing project with only `linear-tickets` keeps working. The other
      // source's default is loaded too when its file exists, and
      // `playbookFor(config, "ticket", source)` picks by source.
      const explicitTicket = file.playbooks.ticket ?? null;
      const ticketCandidates = explicitTicket !== null ? [explicitTicket] : [DEFAULT_PLAYBOOKS.ticket, DEFAULT_GITHUB_TICKET_PLAYBOOK];
      const ticketExtras = explicitTicket !== null ? [DEFAULT_PLAYBOOKS.ticket, DEFAULT_GITHUB_TICKET_PLAYBOOK].filter((n) => n !== explicitTicket) : [];
      // The playbooks a role's declared pull watches name (BB-164). They are
      // read with the rest so one `.bb` read serves every playbook, and parsed
      // into `watchPlaybooks` below.
      const watchNames = new Set<string>();
      for (const r of Object.values(roles?.roles ?? {})) for (const watch of rolePulls(r)) watchNames.add(watch.playbook);
      // BB-246: a project-level ticket watch names a ticket playbook too. It is
      // loaded here so one `.bb` read serves it; `ticketWatchProblems` reports a
      // name that is missing or not a ticket playbook.
      const ticketWatchNames = new Set(file.tickets.map((w) => w.playbook));
      // BB-246: a ticket already adopted under a watch keeps its playbook even
      // after the watch is removed, so its file is read too (the binding ends
      // `unconfigured` only when that file itself is gone). No `check` problem
      // is reported for a removed watch's playbook.
      const adoptedTicketNames = new Set<string>();
      for (const b of store.open(projectId)) if (b.kind === "ticket" && b.adoptedBy !== null) adoptedTicketNames.add(b.playbook);
      const texts = await source.readFiles([...new Set([...names.values(), ...ticketCandidates, ...ticketExtras, depsAlertsName, depsPrsName, ...watchNames, ...ticketWatchNames, ...adoptedTicketNames])].map(playbookPath));
      const playbooks: Partial<Record<BindingKind, Playbook>> = {};
      const ticketPlaybooks: Partial<Record<Source, Playbook>> = {};
      /** Parse one playbook, keeping the last good copy on a failure; null when it is missing (and not required) or unreadable. */
      const loadPlaybook = async (name: string, kind: BindingKind, required: boolean): Promise<Playbook | null> => {
        const text = texts.get(playbookPath(name)) ?? null;
        if (text === null) {
          if (required) problems.push(`${playbookPath(name)} does not exist`);
          return null;
        }
        const goodKey = `good/${projectId}/playbook/${name}`;
        let result = parsePlaybook(text, name);
        if (result.ok && result.value.kind !== kind) result = { ok: false, error: `${playbookPath(name)} is a ${result.value.kind} playbook, but the project file uses it for ${kind}` };
        if (result.ok) {
          await bb.storage.kv.set(goodKey, text);
          return result.value;
        }
        problems.push(result.error);
        const last = await bb.storage.kv.get<string>(goodKey);
        const lastParsed = typeof last === "string" ? parsePlaybook(last, name) : null;
        if (lastParsed !== null && lastParsed.ok) {
          problems.push(`${kind} bindings keep running under the last good ${name} (${lastParsed.value.version}).`);
          return lastParsed.value;
        }
        return null;
      };
      for (const [kind, name] of names) {
        const p = await loadPlaybook(name, kind, true);
        if (p !== null) playbooks[kind] = p;
      }
      if (kinds.includes("ticket")) {
        const loaded: Playbook[] = [];
        for (const name of ticketCandidates) {
          const p = await loadPlaybook(name, "ticket", explicitTicket !== null);
          if (p !== null) loaded.push(p);
        }
        for (const name of ticketExtras) {
          const p = await loadPlaybook(name, "ticket", false);
          if (p !== null) loaded.push(p);
        }
        // The configured/default playbook wins its source; an extra only
        // fills the other source.
        for (const p of loaded) {
          if ((p.source === "linear" || p.source === "github") && ticketPlaybooks[p.source] === undefined) ticketPlaybooks[p.source] = p;
        }
        // The playbook `config.playbooks.ticket` names for display: the
        // tracked source's default when it loaded, else whichever did.
        const preferred = playbookNameFor(file, "ticket");
        const primary = loaded.find((p) => p.name === preferred) ?? loaded[0] ?? null;
        if (primary !== null) playbooks.ticket = primary;
        else if (explicitTicket === null) problems.push(`no ticket playbook: ${ticketCandidates.map((n) => playbookPath(n)).join(" and ")} do not exist`);
      }

      /**
       * The dependency watch's two playbooks. They are optional: a project that
       * has not written them runs no dependency watch, which is how the feature
       * is off before `bb stewards init` writes them. One that is present but
       * does not parse is a problem, like any other playbook.
       */
      const loadOptional = async (name: string): Promise<Playbook | null> => {
        const text = texts.get(playbookPath(name)) ?? null;
        if (text === null) return null;
        const goodKey = `good/${projectId}/playbook/${name}`;
        let result = parsePlaybook(text, name);
        if (result.ok) {
          await bb.storage.kv.set(goodKey, text);
          return result.value;
        }
        problems.push(result.error);
        const last = await bb.storage.kv.get<string>(goodKey);
        const lastParsed = typeof last === "string" ? parsePlaybook(last, name) : null;
        if (lastParsed !== null && lastParsed.ok) {
          problems.push(`${name} keeps running under the last good version (${lastParsed.value.version}).`);
          return lastParsed.value;
        }
        return null;
      };
      const depsAlerts = await loadOptional(depsAlertsName);
      const depsPrs = await loadOptional(depsPrsName);

      /**
       * A role's declared pull-watch playbooks (BB-164). A name that is
       * already a kind or dependency playbook reuses it; a new one is parsed
       * like any playbook, with a problem on failure and the last good copy
       * kept. The check reports a watch whose playbook did not parse.
       */
      const watchPlaybooks = new Map<string, Playbook>();
      const watchErrors = new Map<string, string>();
      if (watchNames.size > 0 || ticketWatchNames.size > 0 || adoptedTicketNames.size > 0) {
        const known = new Map<string, Playbook>();
        for (const p of Object.values(playbooks)) if (p !== undefined) known.set(p.name, p);
        for (const p of Object.values(ticketPlaybooks)) if (p !== undefined) known.set(p.name, p);
        if (depsAlerts !== null) known.set(depsAlerts.name, depsAlerts);
        if (depsPrs !== null) known.set(depsPrs.name, depsPrs);
        for (const name of new Set([...watchNames, ...ticketWatchNames, ...adoptedTicketNames])) {
          const reused = known.get(name);
          if (reused !== undefined) {
            watchPlaybooks.set(name, reused);
            continue;
          }
          const text = texts.get(playbookPath(name)) ?? null;
          const goodKey = `good/${projectId}/playbook/${name}`;
          let result = text === null ? ({ ok: false, error: `${playbookPath(name)} does not exist` } as const) : parsePlaybook(text, name);
          if (result.ok) {
            watchPlaybooks.set(name, result.value);
            await bb.storage.kv.set(goodKey, text!);
            continue;
          }
          const last = await bb.storage.kv.get<string>(goodKey);
          const lastParsed = typeof last === "string" ? parsePlaybook(last, name) : null;
          if (lastParsed !== null && lastParsed.ok) {
            watchPlaybooks.set(name, lastParsed.value);
            problems.push(`the watch playbook ${name} keeps running under the last good version (${lastParsed.value.version}).`);
          } else if (ticketWatchNames.has(name)) {
            // A ticket watch's failure is reported by `ticketWatchProblems`,
            // with the watch it belongs to; a pull watch's here.
            watchErrors.set(name, result.error);
          } else if (adoptedTicketNames.has(name)) {
            // A playbook a ticket was adopted under and whose watch has since
            // been removed: read so the binding keeps running, not reported.
          } else {
            problems.push(result.error);
          }
        }
      }

      // BB-246: a ticket watch's playbook must exist and be kind `ticket`.
      const ticketPlaybooksForWatch = new Map<string, Playbook>(watchPlaybooks);
      for (const p of Object.values(ticketPlaybooks)) if (p !== undefined) ticketPlaybooksForWatch.set(p.name, p);
      problems.push(...ticketWatchProblems(file, ticketPlaybooksForWatch, watchErrors));

      let repos: string[] = [];
      try {
        const set = await source.repoSet();
        if (set.error !== null) problems.push(`repos.json: ${set.error}`);
        // In the primary layout the project source's own repo carries `.bb/` and
        // is not repeated in repos.json, but it is a work repo like the others.
        const listed = set.layout === "primary" && set.primary !== null ? [...set.repos, set.primary] : set.repos;
        const all = listed
          .map((r) => githubRepoOf(r.url))
          .filter((r): r is string => r !== null)
          .filter((r, i, arr) => arr.findIndex((x) => lc(x) === lc(r)) === i);
        repos = all.filter((r) => !file.github.exclude.some((x) => lc(x) === lc(r)));
        if (set.error === null) {
          const stray = file.github.exclude.filter((x) => !all.some((r) => lc(r) === lc(x)));
          if (stray.length > 0) problems.push(`github.exclude names ${stray.join(", ")}, not in repos.json`);
        }
      } catch (error) {
        problems.push(`could not read the repo set: ${errorMessage(error)}`);
      }

      /**
       * The project steward's cross-server problems (BB-105): a watch nobody
       * runs, a watch two people run. They are computed here and shown on the
       * project steward's server. Two or more project stewards is normal
       * (BB-230): each server runs only its own login's roles. With no project
       * steward at all there is no such server, so every server with a role
       * shows the "no one is the project steward" line instead.
       */
      if (roles !== null) {
        const stewardProblem = projectStewardProblem(roles);
        if (role?.projectSteward === true) {
          problems.push(...watchProblems(file, roles, repos, depsAlerts !== null));
        } else if (stewardProblem !== null && stewardProblem.startsWith("no one")) {
          // No server has the role, so every server that reads roles.json shows
          // the missing project steward rather than only the "No role" line.
          problems.push(stewardProblem);
        }
        // Every server reports its own pull watches' problems, not only the
        // project steward: a watch on a repo the project does not lease, an
        // unknown or non-pr playbook, a bad glob, or two held roles on one
        // repo (BB-164).
        problems.push(...pullWatchProblems(roles, repos, file.github.exclude, watchPlaybooks));
      }
      // BB-235: a filing target must be one of `linear.teams` or a repo the
      // project leases. The project file's team key is checked by the schema;
      // a repo target and a role's team are checked here, where the repo set
      // is known.
      problems.push(...filingTargetProblems(file, roles, repos));
      // BB-209: a playbook that still writes the pre-rename `approval: me`
      // alias parses as `user`; surface one warning per playbook, however many
      // of the load paths reached it.
      const warnedPlaybooks = new Set<string>();
      for (const p of [...Object.values(playbooks), depsAlerts, depsPrs, ...watchPlaybooks.values()]) {
        if (p === undefined || p === null || warnedPlaybooks.has(p.name)) continue;
        warnedPlaybooks.add(p.name);
        for (const w of p.warnings) warnings.push(`${p.name}: ${w}`);
      }
      return { projectId, source, file, roles, rolesPresent, rolesUnreadable, githubLogin, linearLogin, role, roleNames, playbooks, ticketPlaybooks, depsAlerts, depsPrs, watchPlaybooks, repos, enabled, problems, warnings, hints, loadedAt: now() };
    }

    // ---- the hand-written guidance's meter (BB-35 step 6) ------------------------------

    const guidanceIndexes = new Map<string, { at: number; value: GuidanceUnit[] }>();

    /**
     * Every paragraph of the project's `.bb` AGENTS.md and playbooks, read from
     * committed HEAD and keyed by content hash. The index is derived, never
     * stored: a hand-written unit is never written or retired by this plugin.
     * A read failure leaves the last good index (or none) rather than stopping
     * a citation; a citation that names no unit is reported unknown.
     */
    async function guidanceUnits(projectId: string, force = false): Promise<GuidanceUnit[]> {
      const cached = guidanceIndexes.get(projectId);
      if (!force && cached !== undefined && now() - cached.at < timing.configTtlMs) return cached.value;
      let value: GuidanceUnit[] = [];
      try {
        const config = await loadConfig(projectId);
        if (config !== null) {
          const names = new Set<string>();
          for (const playbook of Object.values(config.playbooks)) if (playbook !== null && playbook !== undefined) names.add(playbook.name);
          if (config.depsAlerts !== null) names.add(config.depsAlerts.name);
          if (config.depsPrs !== null) names.add(config.depsPrs.name);
          for (const name of config.watchPlaybooks.keys()) names.add(name);
          const paths = ["AGENTS.md", ...[...names].map(playbookPath)];
          const files = await config.source.readFiles(paths);
          for (const path of paths) {
            const content = files.get(path) ?? null;
            if (content !== null) value.push(...parseGuidanceUnits(path, content));
          }
        }
      } catch (error) {
        bb.log.warn(`stewards: could not index the guidance of project ${projectId}: ${errorMessage(error)}`);
        return cached?.value ?? [];
      }
      guidanceIndexes.set(projectId, { at: now(), value });
      return value;
    }

    /**
     * Count the lessons and hand-written guidance units one decision or report
     * rested on (BB-35 steps 2 and 6). A lesson's `hits` counts distinct
     * bindings: a second citation from the same binding refreshes
     * `lastCitedAt` but does not count again. A citation with no binding — a
     * project-steward decision about no one binding — counts once per project.
     * Unknown ids are returned, never counted. Counts only: no tier, no
     * transition, nothing written to `.bb`.
     */
    async function countCitations(projectId: string, bindingId: string, cites: readonly string[]): Promise<{ cited: Lesson[]; citedUnits: GuidanceUnit[]; unknown: string[]; unknownUnits: string[] }> {
      const unique = [...new Set(cites)];
      const lessonIds = unique.filter((id) => !id.startsWith(GUIDANCE_UNIT_PREFIX));
      const guidanceIds = unique.filter((id) => id.startsWith(GUIDANCE_UNIT_PREFIX));
      const { cited, unknown } = store.recordCitations(projectId, lessonIds, bindingId);
      const index = guidanceIds.length === 0 ? [] : await guidanceUnits(projectId);
      const handWritten = new Map(index.filter((u) => u.lessonId === null).map((u) => [u.id, u]));
      const citedUnits = guidanceIds.map((id) => handWritten.get(id)).filter((u): u is GuidanceUnit => u !== undefined);
      const unknownUnits = guidanceIds.filter((id) => !handWritten.has(id));
      if (citedUnits.length > 0) store.recordGuidanceCitations(projectId, citedUnits, bindingId);
      return { cited, citedUnits, unknown, unknownUnits };
    }

    /** The "cited …" and "not counted …" lines a citation adds to a tool reply. */
    function citationLines(result: { cited: Lesson[]; citedUnits: GuidanceUnit[]; unknown: string[]; unknownUnits: string[] }): string[] {
      const out: string[] = [];
      if (result.cited.length === 0 && result.citedUnits.length === 0) out.push("no lesson or guidance unit cited");
      else {
        const parts: string[] = [];
        if (result.cited.length > 0) parts.push(`${result.cited.length} lesson${result.cited.length === 1 ? "" : "s"}: ${result.cited.map((l) => `${l.id} (${l.hits} binding${l.hits === 1 ? "" : "s"})`).join(", ")}`);
        if (result.citedUnits.length > 0) parts.push(`${result.citedUnits.length} guidance unit${result.citedUnits.length === 1 ? "" : "s"}: ${result.citedUnits.map((u) => `${u.id} (${u.file})`).join(", ")}`);
        out.push(`cited ${parts.join("; ")}`);
      }
      if (result.unknown.length > 0) out.push(`not counted (no such lesson in this project): ${result.unknown.join(", ")}`);
      if (result.unknownUnits.length > 0) out.push(`not counted (no such guidance unit at .bb HEAD): ${result.unknownUnits.join(", ")}`);
      return out;
    }

    /**
     * The local, per-project switch, keyed by project id: whether this server
     * stewards the project. It lives in the plugin's kv, so a recreated project
     * (a new id) starts off again, and it is off until switched on. `.bb`'s
     * `stewards/project.json` still says the project *can* be stewarded; both
     * hold for anything to run.
     */
    const projectEnabledKey = (projectId: string) => `projects/${projectId}/enabled`;
    async function projectEnabled(projectId: string): Promise<boolean> {
      return (await bb.storage.kv.get<boolean>(projectEnabledKey(projectId))) === true;
    }
    /** Set the switch and drop the cached configuration, so the next read sees it. */
    async function setProjectEnabled(projectId: string, enabled: boolean): Promise<void> {
      if (enabled) await bb.storage.kv.set(projectEnabledKey(projectId), true);
      else await bb.storage.kv.delete(projectEnabledKey(projectId));
      configs.delete(projectId);
    }

    /** Every project with a stewards configuration, whether or not this server has it switched on. */
    async function configuredProjects(force = false, projects?: Awaited<ReturnType<typeof bb.sdk.projects.list>>): Promise<ProjectConfig[]> {
      const list = projects ?? (await bb.sdk.projects.list());
      const out: ProjectConfig[] = [];
      for (const p of list) {
        const config = await loadConfig(p.id, force);
        if (config !== null) out.push(config);
      }
      return out;
    }

    /** Every project this server stewards: configured in `.bb` and switched on here. `projects` reuses a list already fetched this call (BB-95). */
    async function stewardedProjects(force = false, projects?: Awaited<ReturnType<typeof bb.sdk.projects.list>>): Promise<ProjectConfig[]> {
      return (await configuredProjects(force, projects)).filter((c) => c.enabled);
    }

    const playbookFor = (config: ProjectConfig, kind: BindingKind, source?: Source): Playbook | null => {
      // A ticket playbook is chosen by source (BB-234): a project may carry
      // both `linear-tickets` and `github-issues`.
      if (kind === "ticket" && source !== undefined) return config.ticketPlaybooks[source] ?? null;
      return config.playbooks[kind] ?? null;
    };

    /**
     * The pull watch that adopted a binding: the recorded `adoptedBy`, or, for
     * a Dependabot pull request adopted before BB-164 added the column, the
     * deps-prs playbook name (the fallback addition #2 asks for). Null means
     * the label or review path adopted it. A ticket watch (BB-246) is recorded
     * on `adoptedBy` too, but a ticket keeps its adoption label, so this stays
     * null for one: the label path still governs its lifecycle.
     */
    function adoptedByWatch(config: ProjectConfig, b: Pick<Binding, "kind" | "playbook" | "adoptedBy">): string | null {
      if (b.kind !== "pr") return null;
      if (b.adoptedBy !== null) return b.adoptedBy;
      if (b.playbook === depsPrsPlaybookName(config.file)) return depsPrsPlaybookName(config.file);
      return null;
    }

    /**
     * The playbook a pull watch names, or null when it is not readable. A
     * watch may name the project's own pr playbook; a name that is neither a
     * loaded watch playbook nor that one is missing, not a fallback to a
     * different playbook the watch did not ask for (BB-164).
     */
    function playbookForWatchName(config: ProjectConfig, name: string): Playbook | null {
      let found: Playbook | null;
      if (name === depsPrsPlaybookName(config.file)) found = config.depsPrs;
      else {
        found = config.watchPlaybooks.get(name) ?? null;
        if (found === null) {
          const pr = playbookFor(config, "pr");
          found = pr !== null && pr.name === name ? pr : null;
        }
      }
      return found !== null && found.kind === "pr" ? found : null;
    }

    /**
     * The ticket playbook a ticket watch names, or null when it is not
     * readable (BB-246). A ticket watch names a `kind: ticket` playbook; one
     * naming anything else is a `check` problem and adopts nothing.
     */
    function ticketWatchPlaybook(config: ProjectConfig, name: string): Playbook | null {
      const found = config.watchPlaybooks.get(name) ?? null;
      if (found !== null && found.kind === "ticket") return found;
      for (const p of Object.values(config.ticketPlaybooks)) if (p !== undefined && p.name === name && p.kind === "ticket") return p;
      return null;
    }

    /**
     * The playbook a binding runs under. A Dependabot alert target uses the
     * deps-alerts playbook; a pull request or ticket a watch adopted uses the
     * playbook its watch named; everything else uses its kind's playbook.
     */
    function bindingPlaybook(config: ProjectConfig, b: Pick<Binding, "kind" | "playbook" | "entityId" | "adoptedBy" | "source">): Playbook | null {
      if (b.kind === "ops") {
        const target = parseOpsTargetKey(b.entityId);
        if (target?.kind === "dependabot") return config.depsAlerts;
      }
      if (b.kind === "pr" && adoptedByWatch(config, b) !== null) return playbookForWatchName(config, b.playbook);
      if (b.kind === "ticket" && b.adoptedBy !== null) return ticketWatchPlaybook(config, b.playbook);
      return playbookFor(config, b.kind, b.source === "ops" ? undefined : b.source);
    }

    /**
     * Every deployment target a project's playbooks name, each once, by
     * repo/environment. The repos are what the github plugin leases as
     * `deployment_repo`; the environments are matched on a doorbell (BB-53).
     */
    function deploymentTargets(config: ProjectConfig): DeploymentTarget[] {
      const seen = new Set<string>();
      const out: DeploymentTarget[] = [];
      for (const playbook of Object.values(config.playbooks)) {
        for (const target of playbook?.deployments ?? []) {
          const key = targetKeyOf(target).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(target);
        }
      }
      return out;
    }

    /**
     * The earliest deadline among a binding's unsettled deployment watches,
     * so the requeue wakes the steward at the playbook's timeout even if
     * nothing else does. Null when nothing is waiting.
     */
    function deploymentDeadline(deployments: Binding["deployments"]): number | null {
      const deadlines = Object.values(deployments)
        .filter((w) => (w.state === "merged" || w.state === "deploying") && w.deadlineAt !== null)
        .map((w) => w.deadlineAt!);
      return deadlines.length === 0 ? null : Math.min(...deadlines);
    }

    /**
     * A deployment target's recent deployments, read through the github
     * plugin's source contract (BB-59), never `gh` here. Null when the read
     * failed, so the caller leaves the deadline and timeout path alone.
     */
    async function readDeployments(target: DeploymentTarget): Promise<Deployment[] | null> {
      try {
        const out = await sourceRpc("github", "sourceDeployments", { repo: target.repo, environment: target.environment, limit: 10 }, sourceContract.sourceDeployments.output);
        if (out.error !== null) {
          bb.log.warn(`stewards: could not read deployments for ${target.repo} ${target.environment}: ${out.error}`);
          return null;
        }
        return out.deployments;
      } catch (error) {
        bb.log.warn(`stewards: could not read deployments for ${target.repo} ${target.environment}: ${errorMessage(error)}`);
        return null;
      }
    }

    /**
     * The github source as the carries evaluator's reader (BB-132), all
     * through `sourceRpc`, never `gh` here. A failed read is returned as the
     * reader's `error`, so the evaluator reports it and the steward is woken.
     */
    function carriesReader(): CarriesReader {
      return {
        fileAtRef: (repo, path, ref) => sourceRpc("github", "sourceFileAtRef", { repo, path, ref }, sourceContract.sourceFileAtRef.output),
        latestCommit: (repo, branch, path, until) => sourceRpc("github", "sourceLatestCommit", { repo, branch, path, until }, sourceContract.sourceLatestCommit.output),
        workflowRun: (repo, workflow, runNumber) => sourceRpc("github", "sourceWorkflowRun", { repo, workflow, runNumber }, sourceContract.sourceWorkflowRun.output),
        compare: (repo, base, head) => sourceRpc("github", "sourceCompare", { repo, base, head }, sourceContract.sourceCompare.output),
      };
    }

    /**
     * Evaluate a final deployment just applied to a binding's watches against
     * the target's structured `carries` rule (BB-132) and say whether the
     * steward must be woken (BB-204). `before` is the map before the
     * application, so a no-rule watch's first undecided verdict is told from a
     * repeat. A free-text rule and a failed read wake; a `deployed` verdict
     * wakes; a `not-yet` verdict reverts the watch and stays quiet; no
     * matching rule wakes only the first time, then the watch stays
     * `deploying` with the missing rule as its note.
     */
    async function evaluateAppliedDeployment(
      deployments: Binding["deployments"],
      before: Binding["deployments"],
      target: DeploymentTarget,
      movedIds: readonly string[],
      at: number,
    ): Promise<{ deployments: Binding["deployments"]; wake: boolean; notes: string[] }> {
      let next = deployments;
      let wake = typeof target.carries === "string";
      const notes: string[] = [];
      for (const wid of movedIds) {
        const watch = next[wid];
        if (watch === undefined || typeof target.carries === "string") continue;
        const label = `${watch.key}${target.name === undefined ? "" : ` (${target.name})`}`;
        const verdict = await evaluateCarries(target, { merge: watch.mergeSha, prRepo: watch.prRepo, files: watch.files, ref: watch.ref }, carriesReader());
        if (verdict === null) {
          wake = true;
          continue;
        }
        if (verdict.kind === "deployed" || verdict.kind === "not-yet") {
          const settled = reportDeployment(next, { state: verdict.kind, key: watch.key, ...(watch.target === "" ? {} : { target: watch.target }), note: verdict.note }, at, target.timeout);
          if (settled.changed !== null) {
            next = settled.deployments;
            notes.push(`Carries ${verdict.kind} for ${label}: ${verdict.note}`);
            if (verdict.kind === "deployed") wake = true;
          }
        } else {
          const noRule = matchCarriesRule(target.carries, watch.prRepo, watch.files) === null;
          next = { ...next, [wid]: { ...watch, note: verdict.note } };
          notes.push(`Carries not decided for ${label}: ${verdict.note}`);
          if (!noRule || before[wid]?.state === "merged") wake = true;
        }
      }
      return { deployments: next, wake, notes };
    }

    /**
     * A `workflow_run` doorbell's run start, from the doorbell when it carries
     * one, else read back by the run id (BB-132). Null when it cannot be read,
     * which leaves the older arrival-time comparison in place.
     */
    async function readRunStartedAt(repo: string, run: WorkflowRun, runId: string): Promise<number | null> {
      if (run.startedAt !== null && run.startedAt !== "") {
        const at = Date.parse(run.startedAt);
        return Number.isNaN(at) ? null : at;
      }
      const parsed = Number(runId);
      if (!Number.isInteger(parsed) || parsed <= 0) return null;
      try {
        const out = await sourceRpc("github", "sourceWorkflowRun", { repo, runId: parsed }, sourceContract.sourceWorkflowRun.output);
        const startedAt = out.run?.startedAt ?? null;
        if (out.error !== null || startedAt === null) return null;
        const at = Date.parse(startedAt);
        return Number.isNaN(at) ? null : at;
      } catch (error) {
        bb.log.warn(`stewards: could not read workflow run ${runId} start on ${repo}: ${errorMessage(error)}`);
        return null;
      }
    }

    // ---- the sources ---------------------------------------------------------------------

    async function snapshot(source: Source, id: string): Promise<EntitySnapshot | null> {
      const out = await sourceRpc(source, "sourceSnapshot", { id }, sourceContract.sourceSnapshot.output);
      return out.snapshot === null ? null : entitySnapshotSchema.parse(out.snapshot);
    }

    /**
     * An unread sub-issue relation is not "no parent": it leaves the previous
     * snapshot's parent and children in place, so a read that lost them does
     * not look like a removal and adoption keeps the existing nesting (BB-244).
     */
    function keepRelations(prev: EntitySnapshot | null, entity: EntitySnapshot): EntitySnapshot {
      if (entity.relationsUnread !== true || prev === null) return entity;
      return { ...entity, parent: prev.parent, children: prev.children, childrenTotal: prev.childrenTotal };
    }

    /**
     * The linked pull request keys a look reads, at most five (the cap bounds
     * GitHub reads per look, BB-263). The newest are kept: a ticket with more
     * than five linked pull requests must still observe the one that still
     * matters, so older merged ones never displace a newer open one. Today the
     * snapshot contract carries only `url` and `key` (source-contract.ts), so
     * the newest five in timeline order (the tail) are taken; if a source ever
     * carries a per-link state, open and unmerged pull requests are preferred
     * (newest first, then the newest of the rest).
     */
    function linkedPullKeys(entity: EntitySnapshot): string[] {
      const seen = new Set<string>();
      const linked: Array<{ key: string; state: string | null; index: number }> = [];
      entity.linkedPulls.forEach((l, index) => {
        if (l.key === null) return;
        const key = lc(l.key);
        if (seen.has(key)) return;
        seen.add(key);
        const state = (l as { state?: unknown }).state;
        linked.push({ key: l.key, state: typeof state === "string" ? lc(state) : null, index });
      });
      // Timeline order is oldest first, so descending index is newest first.
      const newestFirst = [...linked].sort((a, b) => b.index - a.index);
      const isMerged = (l: { state: string | null }) => l.state !== null && ["merged", "closed"].includes(l.state);
      const carriesState = linked.some((l) => l.state !== null);
      const ordered = carriesState ? [...newestFirst.filter((l) => !isMerged(l)), ...newestFirst.filter(isMerged)] : newestFirst;
      return ordered.slice(0, 5).map((l) => l.key);
    }

    /** A ticket's linked pull requests, read from github. One that cannot be read is left out. */
    async function linkedPulls(entity: EntitySnapshot): Promise<EntitySnapshot[]> {
      const keys = linkedPullKeys(entity);
      const pulls: EntitySnapshot[] = [];
      for (const key of keys) {
        try {
          const pull = await snapshot("github", key);
          if (pull !== null) pulls.push(pull);
        } catch (error) {
          bb.log.warn(`stewards: could not read ${key}, linked from ${entity.key}: ${errorMessage(error)}`);
        }
      }
      return pulls;
    }

    /**
     * A binding's pull requests, re-read from GitHub rather than from its last
     * snapshot (BB-54): a schedule request must not ask about work that has
     * already merged. `complete` is false when the entity or any linked pull
     * request could not be read fresh, so the caller treats the binding as
     * still at work: when the plugin cannot tell, it asks rather than skips.
     */
    async function freshObserved(b: Binding): Promise<{ observed: Observed; complete: boolean } | null> {
      if (b.lastSnapshot === null) return null;
      if (b.source === "ops") return { observed: b.lastSnapshot, complete: true };
      const fresh = await snapshot(b.source, b.entityId).catch(() => null);
      if (fresh === null) return { observed: b.lastSnapshot, complete: false };
      const entity = keepRelations(b.lastSnapshot?.entity ?? null, fresh);
      if (b.kind !== "ticket") return { observed: { entity, pulls: [] }, complete: true };
      const keys = linkedPullKeys(entity);
      const pulls = await linkedPulls(entity);
      return { observed: { entity, pulls }, complete: pulls.length >= keys.length };
    }

    /**
     * `b`'s at-work judgement from a fresh GitHub read, with the read itself
     * (BB-54, BB-89): the schedule wake names the pull request facts from the
     * same read the judgement used.
     */
    async function atWorkWithRead(b: Binding): Promise<{ atWork: boolean; observed: Observed; complete: boolean } | null> {
      const running = store.workers(b.id).some((w) => w.status === "running");
      const fresh = await freshObserved(b);
      if (fresh === null) return null;
      // An incomplete read cannot prove the work is finished (a linked pull
      // request may be open and unread), so drop a "no more coming" report for
      // this judgement: the project steward is woken rather than a request
      // skipped.
      const base = { ...b, lastSnapshot: fresh.observed, ...(fresh.complete ? {} : { noMorePulls: null }) };
      return { atWork: atWork(base, { runningWorker: running }), observed: fresh.observed, complete: fresh.complete };
    }

    /**
     * The overlapping open bindings at work on `b`'s paths, from a fresh
     * GitHub read (BB-54), each with the read the schedule wake reports from
     * (BB-89).
     */
    async function conflictsFresh(b: Binding): Promise<Array<Conflict & { observed: Observed | null; complete: boolean }>> {
      const conflicts: Array<Conflict & { observed: Observed | null; complete: boolean }> = [];
      for (const c of overlapping(b, store.open(b.projectId))) {
        const read = await atWorkWithRead(c.with);
        if (read === null ? atWork(c.with, { runningWorker: store.workers(c.with.id).some((w) => w.status === "running") }) : read.atWork) {
          conflicts.push({ ...c, observed: read?.observed ?? null, complete: read?.complete ?? false });
        }
      }
      return conflicts;
    }

    /**
     * The pull requests linked to a ticket that are leased for it: those
     * still open. One with no snapshot yet (not read, or the read failed) is
     * kept, so a new pull request is watched before its first read.
     */
    function leasedPulls(b: Pick<Binding, "kind" | "lastSnapshot">): string[] {
      if (b.kind !== "ticket" || b.lastSnapshot === null) return [];
      const pulls = b.lastSnapshot.pulls;
      return b.lastSnapshot.entity.linkedPulls
        .map((l) => l.key)
        .filter((k): k is string => k !== null)
        .filter((k) => {
          const seen = pulls.find((p) => lc(p.key) === lc(k));
          return seen === undefined || !["closed", "merged"].includes(lc(seen.state));
        });
    }

    /**
     * Whether the plugin watches a pull request for this binding (BB-154): a
     * ticket with an open linked one, or an open `pr`/`review` binding whose
     * entity is the pull request. A closed or merged pull request is not a
     * source; github will not ring for it again.
     */
    function pullWatch(b: Binding): boolean {
      if (b.kind === "ticket") return leasedPulls(b).length > 0;
      if (b.kind === "pr" || b.kind === "review") {
        const entity = b.lastSnapshot?.entity ?? null;
        return entity !== null && !["closed", "merged"].includes(lc(entity.state));
      }
      return false;
    }

    /** The structured sources that will wake a binding, as the report path reads them (BB-154). */
    function liveWakeSourceFor(b: Binding): boolean {
      const sources: WakeSourceInput = {
        hold: b.hold,
        holdBehind: b.holdBehind,
        mergeBehind: b.mergeBehind,
        holdStack: b.holdStack,
        deployments: b.deployments,
        runningWorkers: store.workers(b.id).filter((w) => w.status === "running").length,
        openEscalations: store.openEscalations(b.id).length,
        openNeeds: store.openNeeds(b.id).length,
        pullRequestWatch: pullWatch(b),
      };
      return hasLiveWakeSource(sources);
    }

    /**
     * The entity keys a binding's merge hold still waits on (BB-256): every
     * named binding that has not yet merged its pull requests or ended. Used
     * for the "held behind" close text; the hold itself stands while
     * `mergeBehind` is non-empty, and the reconcile pass clears it once every
     * target is finished.
     */
    function mergeHoldKeys(b: Binding): string[] {
      return b.mergeBehind.filter((k) => {
        const target = store.find(k, b.projectId);
        return target === null || target.lastSnapshot === null || !finished(target, target.lastSnapshot);
      });
    }

    /**
     * A thread's workspace branch, from its environment, or null when the
     * environment or its branch cannot be read. Cached once known: a thread's
     * branch does not change, and a null is left uncached so a worker whose
     * environment is still provisioning is read again.
     */
    const branchCache = new Map<string, string>();
    async function threadBranch(threadId: string): Promise<string | null> {
      const cached = branchCache.get(threadId);
      if (cached !== undefined) return cached;
      try {
        const info = (await bb.sdk.threads.get({ threadId, include: "environment" })) as { environment?: { branchName?: string | null } | null };
        const branch = info.environment?.branchName ?? null;
        if (branch !== null && branch !== "") branchCache.set(threadId, branch);
        return branch === "" ? null : branch;
      } catch (error) {
        bb.log.warn(`stewards: could not read the branch of ${threadId}: ${errorMessage(error)}`);
        return null;
      }
    }

    /**
     * The pull requests this binding's worker owns, as lowercased keys and
     * URLs (BB-52 rule 0): its head branch is one of the binding's worker
     * threads' branches, or a worker named the URL in its final message. A
     * pull request the plugin cannot tie to the worker is left out, so it is
     * treated as foreign and keeps its activity actionable. Every worker of
     * the binding counts, archived ones included: the branch is cached from
     * when it was read, and a binding whose worker finished but whose pull
     * request is still open must not read as idle (BB-83).
     */
    async function ownPullKeys(b: Binding, workers: readonly Worker[], observed: Observed): Promise<Set<string>> {
      /** Whether a worker's message names a key or URL, without matching a longer number's prefix. */
      const mentions = (text: string, token: string): boolean => {
        const at = text.indexOf(token);
        return at >= 0 && (at + token.length >= text.length || !/[0-9]/u.test(text[at + token.length]!));
      };
      const branches = new Set<string>();
      for (const w of workers) {
        const branch = await threadBranch(w.threadId);
        if (branch !== null) branches.add(branch);
      }
      const reported = new Set<string>();
      for (const w of workers) {
        if (w.result === null || w.result === "") continue;
        for (const e of [observed.entity, ...observed.pulls]) {
          if (e.key !== "" && mentions(w.result, e.key)) reported.add(e.key.toLowerCase());
          if (e.url !== null && e.url !== "" && mentions(w.result, e.url)) reported.add(e.url.toLowerCase());
        }
      }
      const keys = new Set<string>();
      for (const e of [observed.entity, ...observed.pulls]) {
        if (e.pull === null) continue;
        const own = (e.pull.head !== null && branches.has(e.pull.head)) || reported.has(e.key.toLowerCase()) || (e.url !== null && reported.has(e.url.toLowerCase()));
        if (!own) continue;
        keys.add(e.key.toLowerCase());
        if (e.url !== null) keys.add(e.url.toLowerCase());
      }
      return keys;
    }

    // The interest set: what linear and github should lease and ring us
    // about. Sent whole, only when it changed, a moment after the change.
    const lastInterest = new Map<Source, string>();
    function pushInterest(): void {
      debounce("interest", () => serial("interest", sendInterest));
    }
    async function sendInterest(): Promise<void> {
      const projects = [...configs.values()]
        .map((c) => c.value)
        .filter((c): c is ProjectConfig => c !== null && c.enabled);
      // A binding whose project is switched off is not leased any more, even
      // while its stop turn is still running: the doorbell has nothing to wake.
      const off = new Set([...configs.values()].filter((c) => c.value !== null && !c.value.enabled).map((c) => c.value!.projectId));
      const open = store.open().filter((b) => !off.has(b.projectId));
      const sets: Record<Source, { units: string[]; entities: string[]; dependabot: string[]; deployment: string[] }> = {
        linear: {
          units: [...new Set(projects.flatMap((p) => p.file.linear.teams))].sort(),
          entities: [...new Set(open.filter((b) => b.source === "linear").map((b) => b.entityId))].sort(),
          dependabot: [],
          deployment: [],
        },
        github: {
          units: [...new Set(projects.flatMap((p) => p.repos))].sort(),
          entities: [
            ...new Set([
              ...open.filter((b) => b.source === "github").map((b) => b.entityId),
              ...open.flatMap((b) => leasedPulls(b)),
            ]),
          ].sort(),
          // Every repo the project watches for Dependabot alerts. A server
          // whose gh login cannot read alerts has each lease refused as
          // `forbidden`, which it skips; stewards check says so.
          dependabot: [...new Set(projects.flatMap((p) => (p.depsAlerts === null ? [] : roleDepsTargets(p.role, p.repos).map((t) => t.repo))))].sort(),
          // Every repo a playbook names as a deployment target. A login
          // without `deployments:read` has each lease refused as `forbidden`,
          // which it skips; stewards check says so.
          deployment: [...new Set(projects.flatMap((p) => deploymentTargets(p).map((t) => t.repo)))].sort(),
        },
      };
      for (const source of ["linear", "github"] as const) {
        const body = JSON.stringify(sets[source]);
        if (lastInterest.get(source) === body) continue;
        try {
          await sourceRpc(source, "sourceSetInterest", sets[source], sourceContract.sourceSetInterest.output);
          lastInterest.set(source, body);
        } catch (error) {
          bb.log.warn(`stewards: could not tell ${source} what to watch: ${errorMessage(error)}`);
        }
      }
    }

    // ---- threads ----------------------------------------------------------------------------

    type ThreadInfo = { id: string; title: string | null; status: string; archivedAt: number | null; deletedAt: number | null; visibility: string | null; projectId: string | null; environmentId: string | null; environmentHostId: string | null; environmentStatus: string | null; environmentPhase: string | null; providerId: string; parentThreadId: string | null; parentNotifications: string };

    async function threadInfo(threadId: string): Promise<ThreadInfo | null> {
      try {
        const t = (await bb.sdk.threads.get({ threadId, include: "environment" })) as unknown as Partial<ThreadInfo> & { environment?: { hostId?: string | null; status?: string | null; lifecycle?: { phase?: string | null } | null } | null };
        return {
          id: threadId,
          title: t.title ?? null,
          status: String(t.status ?? "idle"),
          archivedAt: t.archivedAt ?? null,
          deletedAt: t.deletedAt ?? null,
          visibility: t.visibility === undefined ? null : String(t.visibility),
          projectId: t.projectId ?? null,
          environmentId: t.environmentId ?? null,
          // The SDK's thread carries its machine and environment state on
          // `environment`, not at the top level.
          environmentHostId: t.environment?.hostId ?? t.environmentHostId ?? null,
          environmentStatus: t.environment?.status ?? t.environmentStatus ?? null,
          environmentPhase: t.environment?.lifecycle?.phase ?? t.environmentPhase ?? null,
          providerId: String(t.providerId ?? ""),
          parentThreadId: t.parentThreadId ?? null,
          parentNotifications: String(t.parentNotifications ?? "auto"),
        };
      } catch (error) {
        const e = error as { code?: string; status?: number };
        if (e.code === "NOT_FOUND" || e.status === 404 || e.status === 410) return null;
        throw error;
      }
    }

    const busy = (status: string) => status === "active" || status === "starting" || status === "pending" || status === "stopping";

    /** True when a thread's environment was destroyed, so it can no longer run the thread. */
    const environmentGone = (info: Pick<ThreadInfo, "environmentStatus" | "environmentPhase">): boolean => info.environmentStatus === "destroyed" || info.environmentPhase === "destroyed";

    /** True when an error is bb's `thread_environment_unavailable`: the thread's environment cannot run it. */
    function isEnvironmentUnavailable(error: unknown): boolean {
      const e = error as { code?: string; message?: unknown };
      if (e.code === "thread_environment_unavailable") return true;
      return typeof e.message === "string" && /environment is unavailable/iu.test(e.message);
    }

    /**
     * Record the hash of a text the plugin sends to a thread, so `userSaid` can
     * skip the plugin's own wakes: bb records them with `initiator: "user"` and
     * a wake quotes the entity's comments verbatim, so only the text tells them
     * from the owner's words (BB-178). Best-effort, but recorded before the
     * send, so a crash cannot leave a plugin turn looking like the owner's.
     */
    async function recordPluginSend(text: string): Promise<void> {
      try {
        await bb.storage.kv.set(`sent/${sentHash(text)}`, now());
      } catch (error) {
        bb.log.warn(`stewards: could not record the hash of a message the plugin sent: ${errorMessage(error)}`);
      }
    }

    /** Message a thread; "gone" when it no longer exists, "unavailable" when its environment cannot run it. */
    async function send(threadId: string, text: string): Promise<"sent" | "gone" | "failed" | "unavailable"> {
      await recordPluginSend(text);
      try {
        await bb.sdk.threads.send({ threadId, input: [{ type: "text", text, mentions: [] }], mode: "auto" });
        // BB-255: a newer wake the plugin sent supersedes any pending retry for
        // that thread, so a stale retry's failure is not acted on and its
        // queued row is dropped.
        await clearWakeRetry(threadId);
        return "sent";
      } catch (error) {
        const e = error as { code?: string; status?: number };
        if (e.code === "NOT_FOUND" || e.status === 404 || e.status === 410) return "gone";
        if (isEnvironmentUnavailable(error)) return "unavailable";
        bb.log.warn(`stewards: could not message thread ${threadId}: ${errorMessage(error)}`);
        return "failed";
      }
    }

    /**
     * Message a thread, bringing it back first if it was archived while it
     * waited. A function for the text is called just before the send, after
     * those awaits, so it reads the store as of the send.
     */
    async function sendTo(threadId: string, text: string | (() => string)): Promise<"sent" | "gone" | "failed" | "unavailable"> {
      const info = await threadInfo(threadId).catch(() => null);
      if (info === null || info.deletedAt !== null) return "gone";
      if (info.archivedAt !== null) await quietly(`unarchive ${threadId}`, () => bb.sdk.threads.unarchive({ threadId }));
      return send(threadId, typeof text === "string" ? text : text());
    }

    async function quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
      try {
        await fn();
      } catch (error) {
        bb.log.warn(`stewards: could not ${what}: ${errorMessage(error)}`);
      }
    }

    const modelArgs = (spec: ModelSpec | null) =>
      spec === null ? {} : { providerId: spec.providerId, ...(spec.model === null ? {} : { model: spec.model }), ...(spec.reasoningLevel === null ? {} : { reasoningLevel: spec.reasoningLevel }) };

    function parseModel(text: string | null): ModelSpec | null {
      if (text === null) return null;
      const parsed = modelSpecSchema.safeParse(text);
      return parsed.success ? parsed.data : null;
    }

    /** A model as `bb thread spawn` flags, for the worker command a wake shows. */
    const workerFlags = (spec: ModelSpec | null) =>
      spec === null ? "" : [`--provider ${spec.providerId}`, spec.model === null ? null : `--model ${spec.model}`, spec.reasoningLevel === null ? null : `--reasoning-level ${spec.reasoningLevel}`].filter((f) => f !== null).join(" ");

    const stewardModel = (b: Binding, playbook: Playbook) => parseModel(b.modelSteward) ?? playbook.models.steward;
    const workerModel = (b: Binding, playbook: Playbook) => parseModel(b.modelWorker) ?? playbook.models.worker;
    const reviewerModel = (b: Binding, playbook: Playbook) => parseModel(b.modelReviewer) ?? playbook.models.reviewer;

    /**
     * The machine a project's threads run on: the host of its checkout.
     *
     * `{ type: "project-default" }` would leave it to core, which picks the
     * server's own machine; a server with no host daemon of its own (bb-gate's)
     * then fails every spawn with "Local host daemon is not initialized".
     * A connected machine is preferred, then the default source. Null when the
     * project has no checkout bb knows of, and core's default is all there is.
     *
     * The last answer is cached for the synchronous per-turn brief, which
     * cannot await this.
     */
    const projectHostCache = new Map<string, { at: number; hostId: string | null }>();

    /**
     * The project's checkout on a machine bb can reach: a `local_path` source,
     * preferring one on a connected host. Null when the project has none. The
     * native project source reads `.bb` here (server.ts, project-git.ts).
     */
    async function projectCheckout(projectId: string): Promise<{ hostId: string; path: string } | null> {
      try {
        const [project, hosts] = await Promise.all([bb.sdk.projects.get({ projectId }), bb.sdk.hosts.list().catch(() => [])]);
        const sources = project.sources.filter((source) => source.type === "local_path");
        const connected = new Set(hosts.filter((host) => host.status === "connected").map((host) => host.id));
        const pick =
          sources.find((source) => source.isDefault && connected.has(source.hostId)) ??
          sources.find((source) => connected.has(source.hostId)) ??
          sources.find((source) => source.isDefault) ??
          sources[0];
        return pick === undefined ? null : { hostId: pick.hostId, path: pick.path };
      } catch (error) {
        bb.log.warn(`stewards: could not find the checkout of ${projectId} (${errorMessage(error)}); leaving it to bb's default`);
        return null;
      }
    }

    async function projectHost(projectId: string): Promise<string | null> {
      const checkout = await projectCheckout(projectId);
      projectHostCache.set(projectId, { at: now(), hostId: checkout?.hostId ?? null });
      return checkout?.hostId ?? null;
    }

    /**
     * The cached project machine, or undefined when it was never read or is
     * older than a sweep. The synchronous per-turn brief cannot await
     * `projectHost`; when the cache cannot answer, it points at
     * `bb stewards spawn-flags` rather than print a command with a machine it
     * is unsure of.
     */
    function cachedProjectHost(projectId: string): string | null | undefined {
      const entry = projectHostCache.get(projectId);
      return entry === undefined || now() - entry.at > timing.sweepMs ? undefined : entry.hostId;
    }

    /**
     * A fresh environment for a project's thread, from its chosen source. A
     * null source (no config) keeps the old multi-repo choice, so a spawn that
     * outlives its configuration is unchanged.
     */
    const freshEnvironment = (source: ProjectSource | null, hostId: string | null): FreshEnvironment =>
      source === null ? multiRepoFreshEnvironment(hostId) : source.freshEnvironment(hostId);

    /** The same, as `bb thread spawn` flags, for the worker command a wake shows. */
    const environmentFlags = (source: ProjectSource | null, hostId: string | null): string =>
      source === null ? multiRepoEnvironmentFlags(hostId) : source.environmentFlags(hostId);

    /** The project's name in bb, or "" when bb cannot say. */
    const projectName = (projectId: string): Promise<string> =>
      bb.sdk.projects
        .get({ projectId })
        .then((p) => p.name.trim())
        .catch(() => "");

    /** "<project name> project steward", or the bare role when bb cannot name the project. */
    async function projectStewardTitle(projectId: string): Promise<string> {
      const name = await projectName(projectId);
      return name === "" ? "Project steward" : `${name} project steward`;
    }

    /**
     * Ask thread-briefs to leave a steward thread alone, once per thread per
     * process. A spawn seeds it; this covers threads spawned before it was.
     */
    const tagged = new Set<string>();
    async function tagThread(threadId: string, briefs: typeof THREAD_BRIEFS_OFF): Promise<void> {
      if (tagged.has(threadId)) return;
      try {
        await bb.sdk.threads.updatePluginMetadata({ threadId, set: { threadBriefs: briefs } });
        tagged.add(threadId);
      } catch (error) {
        bb.log.warn(`stewards: could not tag thread ${threadId} for thread-briefs: ${errorMessage(error)}`);
      }
    }

    /**
     * The binding a newly created thread belongs to: a worker's lifecycle owner
     * or parent when that is a steward, or the steward of the worker a reviewer
     * is a child of. Null for a thread this plugin does not own. Local store
     * lookups only, so an unrelated thread costs nothing.
     */
    function spawnedOwner(thread: { lifecycleOwnerThreadId: string | null; parentThreadId: string | null }): Binding | null {
      for (const id of [thread.lifecycleOwnerThreadId, thread.parentThreadId]) {
        if (id === null) continue;
        const b = store.byThread(id);
        if (b !== null && b.endedAt === null) return b;
        const w = store.worker(id);
        if (w !== null) {
          const owner = store.binding(w.bindingId);
          if (owner !== null && owner.endedAt === null) return owner;
        }
      }
      return null;
    }

    /**
     * The binding's open user-facing items (BB-231): the plugin's and a
     * steward's needs, route-`user` escalations, and open questions. The
     * escalate and forward coverage gates name each of these; the reverse-order
     * wake asks whether a newly filed gate item covers one. Never a subject
     * inferred from the text.
     */
    function userItemsFor(b: Binding): OpenUserItem[] {
      // An auto-filed `decide` need is a placeholder made from a report's
      // `nextAction`, not a real ask, so it is never a coverage candidate
      // (BB-213, BB-231). A route-`user` escalation an open question already
      // covers is the question's, and one an open need links through its
      // `data.escalationId` is that need's, so each ask is listed once.
      const needs = store.openNeeds(b.id).filter((n) => !isAutoFiledNeed(n));
      const linked = new Set(needs.map((n) => (typeof n.data.escalationId === "string" ? n.data.escalationId : null)).filter((x): x is string => x !== null));
      const covered = new Set(store.openQuestionEscalationIds(b.projectId));
      const escalations = store.openEscalations(b.id).filter((x) => !covered.has(x.id) && !linked.has(x.id));
      return openUserFacingItems(b.id, needs, escalations, store.openQuestions(b.projectId));
    }

    /**
     * Whether anything on a binding needs the user: an actionable open need, an
     * open question about it, or an escalation routed to the user (route
     * `user`) that no question or need covers. An escalation routed to the
     * project steward, the binding's own steward or its parent does not: the
     * owner has nothing to press for it (BB-208). A report whose `actor` is
     * `user` does not count by itself (BB-213): the report files a need from its
     * `nextAction`, so the actor is true only as far as that item makes it true.
     * A need the server cannot act on yet is not listed by the sidebar, so it
     * does not make the row say "needs you" either (BB-237): the phrase and the
     * items under it are `needsYou(projectId, { actionableOnly: true })`.
     */
    function needsUser(b: Binding): boolean {
      // The same predicate as `needsYou(projectId, { actionableOnly: true })`,
      // read per binding so the board and sidebar can ask about one row without
      // recomputing every binding's needs (BB-237). A need only counts when
      // `needView` would offer a button; a with-user escalation a question or a
      // need covers is that item's, not the raw row's, so the `covered` set is
      // the one `needsYou` builds.
      if (store.openNeeds(b.id).some((n) => needView(n, b).actionable)) return true;
      const questions = store.openQuestions(b.projectId);
      if (questions.some((q) => q.bindingId === b.id)) return true;
      const escalations = store.openEscalations(b.id).filter((x) => x.route === "user" && !x.isQuestion && x.resolutionKind === null);
      if (escalations.length === 0) return false;
      const openIds = new Set(store.open(b.projectId).map((x) => x.id));
      const covered = new Set<string>(
        [
          ...store.openNeedsForProject(b.projectId).filter((n) => openIds.has(n.bindingId)).map((n) => (typeof n.data.escalationId === "string" ? n.data.escalationId : null)),
          ...questions.map((q) => q.escalationId),
          ...store.openQuestionEscalationIds(b.projectId),
        ].filter((id): id is string => id !== null),
      );
      return escalations.some((x) => !covered.has(x.id));
    }

    /**
     * The `decide` need the plugin auto-files from a report whose actor is
     * `user` (BB-213), marked in `data` so the page's single "Done" button, the
     * wake's note and this reconciliation all agree on which item it is.
     */
    function isAutoFiledNeed(n: Pick<Need, "data">): boolean {
      return n.data.autoFiled === true;
    }

    /**
     * Reconcile the need auto-filed from a report whose actor is `user`
     * (BB-213). A report that names the user but files nothing for them gets a
     * `decide` item from its `nextAction`, so the sidebar badge, the picker
     * count and the effort page's "Needs you" section agree. It is deduped by
     * (binding, kind, url) like every need, so a re-report updates the wording
     * rather than adding a row. A later report with another actor, or one that
     * files its own item or leaves an open question or route-`user` escalation,
     * closes it. A report whose own `approve-pr`/`merge` was refused does not
     * file one either: the refusal says the user is not the actor yet. Returns
     * the item it filed or refreshed, null otherwise.
     */
    function reconcileAutoNeed(b: Binding, actor: string, hadRefusal = false): Need | null {
      const open = store.openNeeds(b.id);
      const url = b.url ?? "";
      const autos = open.filter(isAutoFiledNeed);
      const auto = autos.find((n) => n.url === url) ?? null;
      // A report that changed the entity's link leaves the old row behind; it
      // is the same auto item, so close the stale one rather than keep two.
      for (const stale of autos) if (stale.id !== auto?.id) store.closeNeed(stale.id, "Superseded by a newer report.", "plugin");
      const other = open.filter((n) => n.id !== auto?.id);
      const userItem =
        hadRefusal ||
        other.length > 0 ||
        store.openQuestions(b.projectId).some((q) => q.bindingId === b.id) ||
        store.openEscalations(b.id).some((x) => x.route === "user");
      if (actor !== "user" || userItem) {
        if (auto !== null) store.closeNeed(auto.id, actor === "user" ? "A later report filed its own item for the user." : "A later report named a different actor.", "plugin");
        return null;
      }
      return store.fileNeed({
        bindingId: b.id,
        kind: "decide",
        url,
        what: b.status?.nextAction ?? "The user has the next action.",
        how: "The report named the user as the actor but filed no item for them, so this was filed from its `nextAction`. File the specific item (`approve-pr`) or raise an escalation if that is the real ask.",
        data: { autoFiled: true },
        filedBy: "plugin",
      });
    }

    /**
     * The worker a thread is a child of, if any. A reviewer is spawned with
     * its worker as parent (`--parent-self`, what build-tickets uses). Null
     * for a worker itself and for anything else.
     */
    function reviewerOwner(thread: { parentThreadId: string | null }): Worker | null {
      return thread.parentThreadId === null ? null : store.worker(thread.parentThreadId);
    }

    /**
     * A worker's reviewer threads, as bb lists them: its children, hidden or
     * not, not archived. Null when bb could not be asked, so a caller that must
     * not guess — archiving a worker that might still have a reviewer — can
     * tell "none" from "unknown". Kept per worker for the two reconcile paths
     * that need a reviewer's own status or its direct-children relationship;
     * the batch paths use `descendantsOfMany` (BB-100).
     */
    async function reviewersOf(workerThreadId: string): Promise<Array<{ id: string; status: string }> | null> {
      try {
        const children = await bb.sdk.threads.list({ parentThreadId: workerThreadId, includeHidden: true });
        return children.filter((c) => c.archivedAt === null).map((c) => ({ id: c.id, status: String(c.status) }));
      } catch (error) {
        bb.log.warn(`stewards: could not list the reviewers of worker ${workerThreadId}: ${errorMessage(error)}`);
        return null;
      }
    }

    /**
     * The live threads below each of `workerThreadIds`, in one
     * `experimental_listDescendants` call per batch of up to 200 ids, rather
     * than one `threads.list` per worker (BB-100). Archived threads are
     * omitted by default; hidden ones are included. A worker with any live
     * descendant must not be archived, so the caller reads presence, not the
     * exact child relationship. Null when bb could not be asked, so a caller
     * that must not guess can tell "none" from "unknown".
     */
    async function descendantsOfMany(workerThreadIds: readonly string[]): Promise<Map<string, string[]> | null> {
      const unique = [...new Set(workerThreadIds)];
      const out = new Map<string, string[]>();
      for (let i = 0; i < unique.length; i += 200) {
        try {
          const { threads } = await bb.sdk.threads.experimental_listDescendants({ threadIds: unique.slice(i, i + 200), includeHidden: true });
          for (const row of threads) out.set(row.threadId, row.descendantIds);
        } catch (error) {
          bb.log.warn(`stewards: could not list the descendants of ${unique.length} thread(s): ${errorMessage(error)}`);
          return null;
        }
      }
      return out;
    }

    /**
     * Archive a reviewer whose round is consumed. A worker's turn ending means
     * it has read the verdict (or ended the turn that spawned the reviewer to
     * wait); a reviewer still running is left alone, so the newest round is
     * never archived while its worker is in flight (BB-47).
     */
    async function archiveConsumedReviewers(workerThreadId: string): Promise<void> {
      for (const r of (await reviewersOf(workerThreadId)) ?? []) {
        if (busy(r.status)) continue;
        await quietly(`archive consumed reviewer ${r.id}`, () => bb.sdk.threads.archive({ threadId: r.id }));
      }
    }

    /** A newer reviewer round supersedes the older ones: archive every other child of the worker. */
    async function supersedeOlderReviewers(workerThreadId: string, keep: string): Promise<void> {
      for (const r of (await reviewersOf(workerThreadId)) ?? []) {
        if (r.id === keep) continue;
        await quietly(`archive superseded reviewer ${r.id}`, () => bb.sdk.threads.archive({ threadId: r.id }));
      }
    }

    /**
     * Archive a finished worker once the reconcile that consumed its report
     * has run, so its row leaves the sidebar with the steward's next turn. A
     * worker that ended with a question for the steward, or whose binding
     * needs the user, stays visible; a later message to an archived worker
     * unarchives it (sendTo), and it shows under its effort again (BB-47).
     */
    async function archiveFinishedWorkers(b: Binding): Promise<void> {
      if (needsUser(b)) return;
      await archiveWorkers(store.workers(b.id).filter((w) => w.status === "finished" && workerQuestion(w.result) === null && !workerWaiting(w.result)));
    }

    /**
     * Retire the binding's parked `finished` workers (BB-266). The plugin's
     * own merge consumed the approval they were waiting on, so they are done,
     * not parked; only one that asked the steward a question stays visible.
     * Unlike `archiveFinishedWorkers` this does not wait for the binding to
     * need nobody: the merge has settled their reason to stay.
     */
    async function archiveParkedWorkers(b: Binding): Promise<void> {
      await archiveWorkers(store.workers(b.id).filter((w) => w.status === "finished" && workerQuestion(w.result) === null));
    }

    /**
     * Archive the given finished workers unless one still has an unarchived
     * child. A worker whose reviewer is still unarchived must stay: bb core
     * releases a thread's unarchived children from it when it is archived,
     * so archiving the worker would clear the reviewer's parent: it could
     * no longer wake the worker, and no later pass could find it to archive
     * it. One batched descendant lookup covers every candidate (BB-100); a
     * listing that failed is "unknown", so all the workers wait rather than
     * risking an orphan (BB-47).
     */
    async function archiveWorkers(candidates: readonly Worker[]): Promise<void> {
      if (candidates.length === 0) return;
      const descendants = await descendantsOfMany(candidates.map((w) => w.threadId));
      if (descendants === null) return;
      for (const w of candidates) {
        if ((descendants.get(w.threadId) ?? []).length > 0) continue;
        const info = await threadInfo(w.threadId).catch(() => null);
        if (info === null || info.deletedAt !== null || info.archivedAt !== null || busy(info.status)) continue;
        await quietly(`archive finished worker ${w.threadId}`, () => bb.sdk.threads.archive({ threadId: w.threadId }));
      }
    }

    /**
     * The one-time unhide (BB-93). Before this change a steward waiting on
     * someone else had its thread hidden (`threads.update { visibility:
     * "hidden" }`), and its finished workers and their reviewers with it.
     * Nothing hides a thread any more, but a server upgrading still holds
     * those rows, so the first start after the change shows every live,
     * unarchived hidden thread of an open binding. The marker lives in the
     * plugin's kv store, so a later start does nothing.
     */
    const UNHIDE_ONCE_KEY = "migrations/unhide-hidden-threads";
    async function unhideOnce(): Promise<void> {
      if ((await bb.storage.kv.get<string>(UNHIDE_ONCE_KEY)) != null) return;
      let failed = false;
      for (const b of store.open()) {
        if (b.threadId !== null && !(await showIfHidden(b.threadId))) failed = true;
        const workerIds = store.workers(b.id).map((w) => w.threadId);
        for (const workerId of workerIds) if (!(await showIfHidden(workerId))) failed = true;
        // One batched descendant lookup per binding instead of one
        // `threads.list` per worker (BB-100). A failed lookup leaves the
        // marker unset so the next start retries.
        const descendants = await descendantsOfMany(workerIds);
        if (descendants === null) {
          failed = true;
          continue;
        }
        for (const ids of descendants.values()) for (const id of ids) if (!(await showIfHidden(id))) failed = true;
      }
      // A transient show failure must not burn the one-time marker: leaving it
      // unset makes the next start retry, as the old show-on-every-wake path
      // did. Only a clean pass records it.
      if (!failed) await bb.storage.kv.set(UNHIDE_ONCE_KEY, String(now()));
    }

    /**
     * The one-time BB-213 backfill. Dropping the actor clause from `needsUser`
     * means an open binding whose stored report says the user acts next loses
     * its badge until its steward reports again, which the default requeue can
     * put two days out. On the first start after the change, file the auto item
     * for every such binding that has nothing else for the user, so the rows
     * this ticket is about keep something to press. The marker lives in the
     * plugin's kv store, so a later start does nothing; a failure leaves it
     * unset so the next start retries.
     */
    const AUTO_NEEDS_ONCE_KEY = "migrations/auto-file-user-needs";
    async function backfillAutoNeedsOnce(): Promise<void> {
      if ((await bb.storage.kv.get<string>(AUTO_NEEDS_ONCE_KEY)) != null) return;
      let failed = false;
      for (const b of store.all()) {
        if (b.endedAt !== null || b.status?.actor !== "user") continue;
        try {
          reconcileAutoNeed(b, "user");
        } catch (error) {
          failed = true;
          bb.log.warn(`stewards: BB-213 backfill for ${b.entityKey}: ${errorMessage(error)}`);
        }
      }
      if (!failed) await bb.storage.kv.set(AUTO_NEEDS_ONCE_KEY, String(now()));
    }

    /**
     * The one-time steward mute (BB-253). New threads are muted where they are
     * spawned; this quiets the project steward and binding threads that already
     * exist when the server first runs the change, so an existing tree goes
     * quiet without being respawned. The marker lives in the plugin's kv store,
     * so a later start does nothing. A real failure leaves it unset so the next
     * start retries; a missing push-notifications plugin is "not available" and
     * records the marker, since there is nothing to retry.
     */
    const MUTE_STEWARDS_ONCE_KEY = "migrations/mute-steward-threads";
    async function muteStewardThreadsOnce(): Promise<void> {
      if ((await bb.storage.kv.get<string>(MUTE_STEWARDS_ONCE_KEY)) != null) return;
      const ids = new Set<string>();
      for (const p of store.projects()) if (p.threadId !== null) ids.add(p.threadId);
      for (const b of store.open()) if (b.threadId !== null) ids.add(b.threadId);
      let failed = false;
      for (const id of ids) if (!(await muteStewardThread(id))) failed = true;
      if (!failed) await bb.storage.kv.set(MUTE_STEWARDS_ONCE_KEY, String(now()));
    }

    /** Show a thread hidden in the sidebar; false when the update failed, so the caller can retry. */
    async function showIfHidden(threadId: string): Promise<boolean> {
      const info = await threadInfo(threadId).catch(() => null);
      if (info === null || info.deletedAt !== null || info.archivedAt !== null || info.visibility !== "hidden") return true;
      try {
        await bb.sdk.threads.update({ threadId, visibility: "visible" });
        return true;
      } catch (error) {
        bb.log.warn(`stewards: could not show ${threadId}: ${errorMessage(error)}`);
        return false;
      }
    }

    /**
     * Keep the project steward's title on its project's name, and tag it. A
     * title someone else put there is left alone: only one still showing what
     * this plugin last wrote is updated, or one this plugin never titled (the
     * old "Project steward", or whatever a summarizer renamed it to).
     */
    async function keepProjectSteward(projectId: string): Promise<void> {
      const row = store.project(projectId);
      if (row.threadId === null) return;
      const info = await threadInfo(row.threadId).catch(() => null);
      if (info === null || info.deletedAt !== null) return;
      await tagThread(row.threadId, THREAD_BRIEFS_OFF);
      if (row.title !== null && info.title !== row.title) return;
      const title = await projectStewardTitle(projectId);
      if (info.title !== title) await quietly(`retitle the project steward ${row.threadId}`, () => bb.sdk.threads.update({ threadId: row.threadId!, title }));
      if (row.title !== title) store.patchProject(projectId, { title });
    }

    /**
     * Retire a project steward whose server roles.json no longer names for it
     * (BB-105): archive the thread and clear the row, so it does not stay in
     * the sidebar and the board while never being woken again. A login that
     * could not be read is left alone: that is a transient read failure, not a
     * role change.
     */
    async function retireProjectSteward(config: ProjectConfig): Promise<void> {
      if (!config.rolesPresent || config.rolesUnreadable || config.role?.projectSteward === true) return;
      const row = store.project(config.projectId);
      if (row.threadId === null) return;
      const threadId = row.threadId;
      store.patchProject(config.projectId, { threadId: null, title: null });
      await quietly(`archive the retired project steward ${threadId}`, () => bb.sdk.threads.archive({ threadId }));
      bb.log.info(`stewards: ${config.projectId} is no longer this server's project steward; archived ${threadId}`);
    }

    async function ensureProjectSteward(config: ProjectConfig): Promise<string | null> {
      // Only the login roles.json names as project steward runs it. Without a
      // roles.json the legacy role is every server's, so this is unchanged.
      if (config.role?.projectSteward !== true) return null;
      // A project switched off on this server adopts nothing and wakes nobody;
      // re-read the switch so a wake already in flight cannot respawn it.
      if (!(await projectEnabled(config.projectId))) return null;
      let threadId: string | null = null;
      await serial(`project:${config.projectId}`, async () => {
        const row = store.project(config.projectId);
        if (row.threadId !== null) {
          const info = await threadInfo(row.threadId);
          if (info !== null && info.deletedAt === null) {
            threadId = row.threadId;
            return;
          }
        }
        const title = await projectStewardTitle(config.projectId);
        await recordPluginSend(PROJECT_STEWARD_INTRO);
        const thread = await bb.sdk.threads.spawn({
          projectId: config.projectId,
          environment: freshEnvironment(config.source, await projectHost(config.projectId)),
          prompt: PROJECT_STEWARD_INTRO,
          title,
          ...modelArgs(config.file.projectSteward.model ?? null),
          pluginMetadata: { role: "project", threadBriefs: THREAD_BRIEFS_OFF },
        });
        tagged.add(thread.id);
        // BB-253: the project steward and its whole tree are muted; workers and
        // reviewers inherit the ancestor cap, so only the owner's own threads
        // and needs-you pushes notify.
        await muteStewardThread(thread.id);
        store.patchProject(config.projectId, { threadId: thread.id, title });
        bb.log.info(`stewards: started the project steward for ${config.projectId} (${thread.id})`);
        threadId = thread.id;
      });
      return threadId;
    }

    /**
     * A steward is a child of its parent steward, or of the project steward
     * when it has none, with parent notifications off (BB-245): bb's tree and
     * the sidebar nest it under that parent, and bb does not wake the parent
     * every time the steward finishes a turn. A steward spawned by an earlier
     * version is parented with `auto`; that is set to `off` here, once per run,
     * keeping the parent. A steward that is no thread's child is left alone: it
     * nests only when it is next spawned (no migration).
     */
    const kept = new Set<string>();
    async function keepSteward(projectId: string, threadId: string): Promise<void> {
      if (kept.has(threadId)) return;
      await tagThread(threadId, THREAD_BRIEFS_OFF);
      const info = await threadInfo(threadId).catch(() => null);
      if (info === null || info.deletedAt !== null) return;
      const parent = info.parentThreadId;
      if (parent !== null && info.parentNotifications !== "off" && (store.byThread(parent) !== null || store.projectByThread(parent) !== null)) {
        try {
          // The parent stays; only the notifications change, in this one call.
          await bb.sdk.threads.update({ threadId, parentNotifications: "off" });
        } catch (error) {
          bb.log.warn(`stewards: could not set parent notifications off for steward ${threadId}: ${errorMessage(error)}`);
          return;
        }
      }
      kept.add(threadId);
    }

    /**
     * The project steward's environment, for a new steward to share, waiting
     * for it to attach. `ensureProjectSteward` returns before the provider has
     * created it, so a read taken at once is null and the first stewards of a
     * new project would each get their own environment (BB-111). Polls until
     * the environment has an id and is ready; an already-ready one returns on
     * the first poll. Returns null on timeout, or when the environment is
     * destroyed, so the caller gives the steward a fresh one.
     */
    async function sharedEnvironment(projectThread: string, entityKey: string): Promise<string | null> {
      // A bounded number of polls, so the wait is deterministic and injectable
      // in tests; the last poll is not followed by a sleep.
      const polls = Math.max(1, Math.ceil(timing.environmentWaitMs / timing.environmentPollMs));
      for (let poll = 0; poll < polls; poll += 1) {
        const info = await threadInfo(projectThread).catch(() => null);
        if (info !== null) {
          if (environmentGone(info)) {
            bb.log.info(`stewards: the project steward's environment is destroyed; giving ${entityKey}'s steward its own`);
            return null;
          }
          // An environment id with no readiness field counts as ready.
          if (info.environmentId !== null && (info.environmentStatus === null || info.environmentStatus === "ready")) return info.environmentId;
        }
        if (poll + 1 < polls) await new Promise((resolve) => setTimeout(resolve, timing.environmentPollMs));
      }
      bb.log.info(`stewards: timed out waiting up to ${timing.environmentWaitMs}ms for the project steward's environment; giving ${entityKey}'s steward its own`);
      return null;
    }

    async function spawnSteward(b: Binding, config: ProjectConfig, playbook: Playbook, prompt: string): Promise<string | null> {
      const projectThread = await ensureProjectSteward(config);
      // Stewards decide and delegate; they need no checkout of their own. They
      // share the project steward's environment, and workers get fresh ones.
      const env = projectThread === null ? null : await sharedEnvironment(projectThread, b.entityKey);
      // BB-245: a steward whose binding has an open parent binding with a
      // thread nests under that parent's thread in bb's tree, so a promoted
      // sub-issue appears under its parent steward rather than the project
      // steward. The parent only changes the tree; the environment is still the
      // project steward's. bb cannot re-parent a live thread, so a child stays
      // under a parent that later ends (DESIGN.md §4/§15).
      const parent = b.parentBindingId === null ? null : store.binding(b.parentBindingId);
      const parentThread = parent !== null && parent.projectId === b.projectId && parent.endedAt === null && parent.threadId !== null ? parent.threadId : null;
      const treeParent = parentThread ?? projectThread;
      const base = {
        projectId: b.projectId,
        // A steward is a child of its parent steward, or of the project steward
        // when it has none, with parent notifications off: it trees under that
        // row in the sidebar without waking it on every turn. The parent and
        // the notification mode are set in the same spawn call, so a parented
        // steward is never left on `auto`.
        ...(treeParent === null ? {} : { parentThreadId: treeParent, parentNotifications: "off" as const }),
        prompt,
        title: b.kind === "review" ? `Review ${b.entityKey}: ${b.title ?? ""}`.trim() : b.kind === "ops" ? (b.title ?? `Ops watch: ${b.entityKey}`) : `${b.entityKey}: ${b.title ?? ""}`.trim(),
        ...modelArgs(stewardModel(b, playbook)),
        pluginMetadata: { role: "steward", bindingId: b.id, threadBriefs: THREAD_BRIEFS_OFF },
      };
      let thread: { id: string };
      await recordPluginSend(prompt);
      try {
        thread = await bb.sdk.threads.spawn({ ...base, environment: env === null ? freshEnvironment(config.source, await projectHost(b.projectId)) : { type: "reuse", environmentId: env } });
      } catch (error) {
        if (env === null) throw error;
        bb.log.warn(`stewards: could not share the project steward's environment for ${b.entityKey} (${errorMessage(error)}); giving it its own`);
        thread = await bb.sdk.threads.spawn({ ...base, environment: freshEnvironment(config.source, await projectHost(b.projectId)) });
      }
      tagged.add(thread.id);
      kept.add(thread.id);
      // BB-253: mute the steward; the workers it starts with `--parent-self`
      // and their reviewers inherit the cap with no skill change.
      await muteStewardThread(thread.id);
      store.patch(b.id, { threadId: thread.id });
      bb.log.info(`stewards: ${b.entityKey} is stewarded by thread ${thread.id}`);
      return thread.id;
    }

    /**
     * The dotenv the requester writes for a provide-secret need. The need's
     * own `writeEnv` wins; a stewards setting always uses the requester's
     * temporary storage; otherwise the named worker's thread storage, so the
     * value lands where the worker reads it.
     */
    async function requesterWriteEnv(need: Need, requesterHostId: string | null): Promise<string> {
      const named = typeof need.data.writeEnv === "string" && need.data.writeEnv.trim() !== "" ? need.data.writeEnv.trim() : null;
      if (named !== null) return named;
      if (typeof need.data.setting === "string" && need.data.setting.trim() !== "") return "$BB_THREAD_STORAGE/.secrets.env";
      const workerThreadId = typeof need.data.workerThreadId === "string" ? need.data.workerThreadId : null;
      if (workerThreadId !== null) {
        try {
          const location = await bb.sdk.threads.storageLocation({ threadId: workerThreadId });
          if (typeof location.storageRootPath === "string" && location.storageRootPath !== "") {
            // Only write another thread's storage when it is on the requester's
            // own machine; a cross-host path is not the requester's to write.
            if (requesterHostId === null || location.hostId === requesterHostId) return `${location.storageRootPath.replace(/\/$/u, "")}/.secrets.env`;
            bb.log.warn(`stewards: worker ${workerThreadId} is on ${location.hostId}, not the requester's ${requesterHostId}; writing the requester's own storage`);
          }
        } catch (error) {
          bb.log.warn(`stewards: could not resolve worker ${workerThreadId}'s storage (${errorMessage(error)}); using the requester's own`);
        }
      }
      return "$BB_THREAD_STORAGE/.secrets.env";
    }

    /**
     * Spawn the fixed-prompt requester thread for an open provide-secret need,
     * on the same machine and with the same model the binding's workers use. It
     * is recorded as a worker so the steward is told when it finishes, and
     * bound to the need so `bb stewards secret import` accepts only it.
     */
    async function spawnRequester(b: Binding, need: Need): Promise<string> {
      const config = await loadConfig(b.projectId);
      const playbook = config === null ? null : bindingPlaybook(config, b);
      const model = playbook === null ? parseModel(b.modelWorker) : workerModel(b, playbook);
      const hostId = await projectHost(b.projectId);
      const writeEnv = await requesterWriteEnv(need, hostId);
      const variable = secretVariable(need);
      const title = `Provide ${variable} for ${b.entityKey}`;
      const prompt = requesterPrompt(b, need, writeEnv);
      await recordPluginSend(prompt);
      const thread = await bb.sdk.threads.spawn({
        projectId: b.projectId,
        environment: freshEnvironment(config?.source ?? null, hostId),
        prompt,
        title,
        ...modelArgs(model),
        pluginMetadata: { role: "requester", bindingId: b.id, needId: need.id },
      });
      store.setSecretRequester(thread.id, need.id);
      store.addWorker(thread.id, b.id, title);
      bb.log.info(`stewards: started a requester thread for ${b.entityKey}'s ${variable} (${thread.id})`);
      return thread.id;
    }

    /** Close the provide-secret need a requester was spawned for, once it has finished. */
    async function closeRequesterNeed(threadId: string): Promise<void> {
      const requester = store.secretRequester(threadId);
      if (requester === null) return;
      const need = store.need(requester.needId);
      if (need === null || need.status !== "open") return;
      const b = store.binding(need.bindingId);
      const forwarded = forwardedFor(need);
      const closure = "The requester thread finished; the secret was provided through bb's secure form.";
      store.closeNeed(need.id, closure);
      // Criterion 2: the escalation the question was forwarded from resolves in
      // the same write, and the project steward is told it is answered.
      if (b !== null) await wakeProjectOnForwardedAnswer(b, closure, forwarded);
    }

    // ---- the reconcile loop ------------------------------------------------------------------

    /**
     * A thread the plugin does not know as a steward, a worker or the project
     * steward is one the user runs themselves. Its signed comments count as
     * the user's own words, including for the spec (criterion 4).
     */
    function isUserThread(threadId: string): boolean {
      return store.byThread(threadId) === null && store.worker(threadId) === null && store.projectByThread(threadId) === null;
    }

    /** The spec hash a binding's approval is pinned to, counting the user's own spec comments. */
    const specHashFor = (b: Pick<Binding, "threadId">, entity: EntitySnapshot): string => specHash(entity, b.threadId, isUserThread);

    /** The text a binding's approval pins, stored as `approvedText` so BB-249 can diff a later edit against it. */
    const specTextFor = (b: Pick<Binding, "threadId">, entity: EntitySnapshot): string => specText(entity, b.threadId, isUserThread);

    /**
     * The ready gate for a brief: the live spec hash when the binding has a
     * snapshot, so an approval whose spec changed reads as not passed. The
     * wake does the same; a brief pinned to the approval's own hash would call
     * a stale gate passed on exactly the compacted/non-wake turns it protects.
     */
    const briefGate = (b: Binding, playbook: Playbook) =>
      gateState(playbook, b.ready, b.lastSnapshot === null ? (b.ready.approval?.specHash ?? "") : specHashFor(b, b.lastSnapshot.entity));

    const ownThreads = (b: Binding) => new Set([b.threadId, ...store.workers(b.id).map((w) => w.threadId)].filter((t): t is string => t !== null));

    function routedTo(b: Binding): Array<{ escalation: Escalation; from: Binding }> {
      return store.children(b.id).flatMap((child) => store.openEscalations(child.id).filter((x) => x.route === "parent").map((escalation) => ({ escalation, from: child })));
    }

    /** A delivered wake, and the respawn the recovery path made, when it made one (BB-103). */
    type WakeDelivery = false | { delivered: true; respawned: { from: string | null; to: string } | null };

    /** Send a wake, spawning the steward's thread on the first; false when nothing was delivered. */
    async function deliverWake(b: Binding, config: ProjectConfig, playbook: Playbook, text: string): Promise<WakeDelivery> {
      if (b.threadId === null) {
        await spawnSteward(b, config, playbook, text);
        return { delivered: true, respawned: null };
      }
      // A thread whose environment was destroyed at wake time cannot run the
      // wake. Respawn it rather than detach: the binding is not the user's to
      // end, and `bb thread restore-environment` has no multi-repo restore.
      const info = await threadInfo(b.threadId).catch(() => null);
      if (info !== null && info.deletedAt === null && environmentGone(info)) {
        return respawnSteward(b, config, playbook, text, `its environment is ${info.environmentStatus ?? info.environmentPhase ?? "destroyed"}`);
      }
      // A wake can be the thing that pushes the transcript over the limit;
      // compact first (criterion 4). If compaction makes the thread busy,
      // sendTo queues the wake for the next idle.
      await compactIfLarge(b.threadId, text.length);
      const sent = await sendTo(b.threadId, text);
      if (sent === "gone") {
        // The user deleted the thread: that is a detach they meant.
        store.patch(b.id, { endedAt: now(), endReason: "deleted", manualDetach: true });
        pushInterest();
        return false;
      }
      if (sent === "unavailable") {
        // bb refused the message because the thread's environment cannot run
        // it: recover the steward on a live environment (BB-103).
        return respawnSteward(b, config, playbook, text, "the thread's environment is unavailable");
      }
      return sent === "sent" ? { delivered: true, respawned: null } : false;
    }

    /**
     * A steward whose environment is gone is respawned on the project
     * steward's environment (the `spawnSteward` path): the old thread is
     * archived, never deleted, so `thread.deleted` never marks the binding
     * manually detached; the binding is re-pointed; and the wake becomes the
     * new thread's first prompt. The caller notes the respawn on the binding
     * after it clears the delivered notes, so the next report says so.
     */
    async function respawnSteward(b: Binding, config: ProjectConfig, playbook: Playbook, text: string, why: string): Promise<WakeDelivery> {
      const from = b.threadId;
      const respawned = `${text}\n\n## This steward was respawned\n\nYour previous thread${from === null ? "" : ` (${from})`} could not be woken because ${why}. This is a fresh thread on the project steward's environment, and the binding now points here.`;
      let to: string | null;
      try {
        to = await spawnSteward(b, config, playbook, respawned);
      } catch (error) {
        bb.log.warn(`stewards: could not respawn ${b.entityKey}'s steward: ${errorMessage(error)}`);
        return false;
      }
      if (to === null || to === "") return false;
      if (from !== null && from !== to) await quietly(`archive the unreachable steward thread ${from}`, () => bb.sdk.threads.archive({ threadId: from }));
      bb.log.warn(`stewards: ${b.entityKey}'s steward ${from ?? "(none)"} could not be woken (${why}); respawned as ${to}`);
      pushInterest();
      return { delivered: true, respawned: { from, to } };
    }

    /** Queue the respawn after the caller clears the delivered notes, so the next report names it. */
    function noteRespawn(b: Binding, respawned: { from: string | null; to: string } | null): void {
      if (respawned === null) return;
      store.note(b.id, `The steward was respawned from ${respawned.from ?? "(none)"} to ${respawned.to}: its environment could not deliver the wake.`);
    }

    /**
     * Write the status the plugin observed itself, without a steward turn
     * (BB-203): the page and sidebar are current before the next wake, and the
     * write goes through `patch` so the realtime channel rings. `actor` follows
     * the standing rule (`user` only while a need or a `user` escalation is open),
     * and the record keeps the steward's phase, wait, conditions and resources.
     */
    function patchMechanicalStatus(b: Binding, event: MechanicalEvent): Binding {
      // The approval event is itself the answer to an open approval escalation,
      // so that one does not keep `actor` on the user (BB-203).
      const userWaiting =
        store.openNeeds(b.id).length > 0 ||
        store.openEscalations(b.id).some((x) => x.status === "open" && x.route === "user" && !(event.kind === "approved" && x.kind === "approval"));
      const status = mechanicalStatus(b.status, event, userWaiting, now());
      if (status === null) return b;
      const moved = advanced(b.status, status);
      return store.patch(b.id, { status, statusAt: now(), ...(moved ? { advancedAt: now() } : {}) });
    }

    /** Wake the steward, spawning its thread on the first wake. */
    async function wake(b: Binding, config: ProjectConfig, playbook: Playbook, observed: Observed, changes: string[], reason: WakeReason): Promise<boolean> {
      const gate = gateState(playbook, b.ready, specHashFor(b, observed.entity));
      const workerQuestions = await collectWorkerQuestions(b);
      const text = formatWake({
        reason,
        binding: b,
        playbook,
        observed,
        gate,
        escalations: store.openEscalations(b.id),
        routedToMe: routedTo(b),
        workers: store.workers(b.id),
        workerQuestions,
        children: store.children(b.id).map((c) => ({ binding: c, openEscalations: store.openEscalations(c.id) })),
        workerFlags: [environmentFlags(config.source, await projectHost(b.projectId)), workerFlags(workerModel(b, playbook))].filter((f) => f !== "").join(" "),
        changes,
        needs: store.openNeeds(b.id),
        own: ownThreads(b),
        projectApprovals: projectApprovalsFor(b),
        label: config.file.label,
        conflicts: conflictsOf(b, store.open(b.projectId)),
        deployments: b.deployments,
        assumptions: store.openAssumptions(b.id),
        lessons: store.lessonsByTier(b.projectId, "trial").slice(0, config.file.lessons.trial.max),
        now: now(),
      });
      const delivery = await deliverWake(b, config, playbook, text);
      if (delivery === false) return false;
      const cursor = newestCommentAt(observed);
      const deployDeadline = deploymentDeadline(b.deployments);
      store.patch(b.id, {
        awaitingReport: true,
        wokeAt: now(),
        lastJudgmentAt: now(),
        // BB-255: a wake that landed clears the failed-wake phrase.
        wakeFailure: null,
        // BB-154: the reason this turn was woken, so the report that ends it
        // can count a requeue-only run. Cleared by that report.
        lastWakeReason: reason,
        commentCursor: cursor > b.commentCursor ? cursor : b.commentCursor,
        pending: [],
        archiveWhenIdle: false,
        // A fallback until the report names its own; never later than a
        // deployment's timeout, so the no-deployment wake is not missed.
        requeueAt: deployDeadline === null ? now() + playbook.requeueDefaultMs : Math.min(now() + playbook.requeueDefaultMs, deployDeadline),
      });
      noteRespawn(b, delivery.respawned);
      return true;
    }

    // ---- failed-wake retry (BB-255) ---------------------------------------------------------

    /**
     * The binding a thread belongs to, whether the thread is a steward's own
     * or a worker's; null for a thread the store does not know (a project
     * steward's).
     */
    function bindingForThread(threadId: string): Binding | null {
      const direct = store.byThread(threadId);
      if (direct !== null) return direct;
      const worker = store.worker(threadId);
      return worker === null ? null : store.binding(worker.bindingId);
    }

    /**
     * BB-255: provider-retry asks whether it should re-run a failed turn.
     * Decline a turn this plugin sent (its own wake), which it re-runs itself;
     * allow everything else, including an owner-typed turn on a steward thread.
     * A read that fails is an allow, the contract's fail-open default.
     */
    async function answerRetryConsent(input: { threadId: string; requestId: string }): Promise<RetryConsent> {
      try {
        const [latest] = await bb.sdk.threads.events.list({ threadId: input.threadId, types: ["client/turn/requested"], order: "desc", limit: "1" });
        if ((latest?.data as { originPluginId?: unknown } | undefined)?.originPluginId === bb.pluginId) return { kind: "decline", reason: "stewards re-runs its own failed wake" };
      } catch (error) {
        bb.log.warn(`stewards: could not read the failed turn for retry consent: ${errorMessage(error)}`);
      }
      return { kind: "allow" };
    }

    /**
     * Threads whose failed turn `turn.failed` is deciding on (BB-255). It is
     * set synchronously before the retry RPC is awaited, so the `thread.failed`
     * handler — dispatched just before it — yields and lets this decision win.
     */
    const wakeRetryInFlight = new Set<string>();

    /** Replace the one pending retry for a thread, or drop it. */
    function setWakeRetry(b: Binding, threadId: string, retry: WakeRetry | null): Binding {
      const next = { ...b.wakeRetries };
      if (retry === null) delete next[threadId];
      else next[threadId] = retry;
      return store.patch(b.id, { wakeRetries: next });
    }

    /**
     * The retry request ids the plugin scheduled, keyed to their thread, for a
     * thread the binding record does not cover: a project steward has no
     * binding, and a retry's own failure arrives with a null origin. In memory:
     * a restart loses it, which is the same as the retry being lost.
     */
    type RetriedRequest = { threadId: string; rootRequestId: string; queuedMessageId: string | null };
    const retriedRequests = new Map<string, RetriedRequest>();

    const hasRetriedRequest = (threadId: string): boolean => {
      for (const entry of retriedRequests.values()) if (entry.threadId === threadId) return true;
      return false;
    };

    /** The original request id of the chain stewards is retrying on a thread, or null when none is pending. */
    function chainRootFor(threadId: string): string | null {
      const b = bindingForThread(threadId);
      const retry = b === null ? undefined : b.wakeRetries[threadId];
      if (retry !== undefined) return retry.rootRequestId ?? retry.requestId;
      for (const entry of retriedRequests.values()) if (entry.threadId === threadId) return entry.rootRequestId;
      return null;
    }

    /**
     * The chain a failed turn belongs to: its `client/turn/requested` event's
     * `retryOfRequestId` (the original request), or the request id itself for
     * an original. Null when the event cannot be read.
     */
    async function retryChainRoot(threadId: string, requestId: string): Promise<string | null> {
      try {
        const rows = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: "30" });
        for (const row of rows) {
          const data = row.data as { requestId?: unknown; retryOfRequestId?: unknown };
          if (data.requestId !== requestId) continue;
          return typeof data.retryOfRequestId === "string" ? data.retryOfRequestId : requestId;
        }
      } catch (error) {
        bb.log.warn(`stewards: could not read the retry chain for ${threadId}: ${errorMessage(error)}`);
      }
      return null;
    }

    /** Delete a queued retry row, best-effort; a no-op when there is none. */
    async function deleteQueuedRetry(threadId: string, queuedMessageId: string | null): Promise<void> {
      if (queuedMessageId === null) return;
      await quietly(`delete queued retry ${queuedMessageId}`, () => bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId }));
    }

    /** Drop a pending retry for a thread, deleting its queued row; a no-op when there is none. */
    async function clearWakeRetry(threadId: string): Promise<void> {
      for (const [requestId, entry] of retriedRequests) {
        if (entry.threadId !== threadId) continue;
        await deleteQueuedRetry(threadId, entry.queuedMessageId);
        retriedRequests.delete(requestId);
      }
      const b = bindingForThread(threadId);
      const retry = b === null ? undefined : b.wakeRetries[threadId];
      if (b !== null && retry !== undefined) {
        await deleteQueuedRetry(threadId, retry.queuedMessageId);
        setWakeRetry(b, threadId, null);
      }
    }

    /**
     * The provider error in words. `turn.failed` carries no message, only the
     * structured classification, so the phrase is assembled from it.
     */
    function describeWakeError(errorInfo: ProviderErrorInfo | null): string {
      if (errorInfo === null) return "the provider reported no detail";
      const parts: string[] = [errorInfo.category];
      if (errorInfo.providerCode !== null && errorInfo.providerCode !== "") parts.push(errorInfo.providerCode);
      if (errorInfo.httpStatusCode !== null) parts.push(`HTTP ${errorInfo.httpStatusCode}`);
      return parts.join(" ");
    }

    /** Categories a retry cannot fix: the same credentials, budget or request fail again. */
    const NON_RETRYABLE_WAKE_CATEGORIES = new Set(["unauthorized", "billing", "policy", "bad-request"]);

    /** Whether a retry could plausibly fix the failure. */
    const retryableWakeFailure = (errorInfo: ProviderErrorInfo | null): boolean => errorInfo === null || !NON_RETRYABLE_WAKE_CATEGORIES.has(errorInfo.category);

    /** The latest reset a rate-limit snapshot reports, or null when it reports none. */
    function wakeRateLimitReset(rateLimits: ProviderRateLimitState | null): number | null {
      if (rateLimits === null) return null;
      const blocked = rateLimits.windows.filter((w) => w.status === "blocked");
      const relevant = blocked.length > 0 ? blocked : rateLimits.windows;
      const resets = relevant.flatMap((w) => (w.resetsAtMs === null ? [] : [w.resetsAtMs]));
      return resets.length === 0 ? null : Math.max(...resets);
    }

    /** The `sendAt` for a retry: an exponential backoff, never before a reported rate-limit reset. */
    function wakeRetrySendAt(rateLimits: ProviderRateLimitState | null, attemptNumber: number, at: number): number {
      const backoff = at + timing.wakeRetryBaseMs * 2 ** Math.max(0, attemptNumber - 1);
      const reset = wakeRateLimitReset(rateLimits);
      return reset === null ? backoff : Math.max(backoff, reset);
    }

    /** The requeue interval a wake set, for the hold's upper bound; a fallback when there is none. */
    function wakeRequeueMs(b: Binding | null): number {
      if (b !== null && b.wokeAt !== null && b.requeueAt !== null && b.requeueAt > b.wokeAt) return b.requeueAt - b.wokeAt;
      return timing.wakeRetryBaseMs * 8;
    }

    /**
     * Retry a failed wake the plugin sent, if the failure is retryable and the
     * attempt cap is not reached. Returns true when a retry was scheduled and
     * recorded (the retry's own request id is what recognises its later
     * null-origin failure); false when the caller must give up.
     */
    async function retryFailedWake(args: {
      threadId: string;
      requestId: string;
      rootRequestId: string;
      attemptNumber: number;
      errorInfo: ProviderErrorInfo | null;
      rateLimits: ProviderRateLimitState | null;
      binding: Binding | null;
      worker: Worker | null;
    }): Promise<boolean> {
      if (!retryableWakeFailure(args.errorInfo)) return false;
      if (args.attemptNumber >= WAKE_RETRY_MAX_ATTEMPTS) return false;
      const sendAt = wakeRetrySendAt(args.rateLimits, args.attemptNumber, now());
      let result: Awaited<ReturnType<typeof bb.sdk.threads.retry>>;
      try {
        result = await bb.sdk.threads.retry({ threadId: args.threadId, turnRequestId: args.requestId, sendAt, reason: "Retrying a failed stewards wake" });
      } catch (error) {
        const e = error as { code?: string; status?: number };
        if (e.code === "retry_already_queued") {
          // provider-retry (or a concurrent call) already holds the one live
          // retry for this turn. Treat it as pending so the failure is never
          // given up on; that caller owns the queued row.
          if (args.binding !== null) setWakeRetry(args.binding, args.threadId, { requestId: args.requestId, rootRequestId: args.rootRequestId, attempt: args.attemptNumber + 1, sendAt, holdUntil: sendAt + wakeRequeueMs(args.binding), queuedMessageId: null });
          bb.log.info(`stewards: a retry for ${args.threadId} is already queued; leaving it to the other caller`);
          return true;
        }
        bb.log.warn(`stewards: could not retry ${args.threadId}'s failed wake: ${errorMessage(error)}`);
        return false;
      }
      const retriedId = result.turnRequestId;
      const queuedMessageId = result.delivery === "queued" ? result.queuedMessageId : null;
      // The binding record keeps the queued id for a binding; the in-memory map
      // keeps it for a project steward, which has no binding.
      retriedRequests.set(retriedId, { threadId: args.threadId, rootRequestId: args.rootRequestId, queuedMessageId: args.binding === null ? queuedMessageId : null });
      if (args.binding !== null) setWakeRetry(args.binding, args.threadId, { requestId: retriedId, rootRequestId: args.rootRequestId, attempt: args.attemptNumber + 1, sendAt, holdUntil: sendAt + wakeRequeueMs(args.binding), queuedMessageId });
      // A worker the earlier thread.failed marked failed is running again: the
      // retry stands in for the failure.
      if (args.worker !== null && args.worker.status === "failed") store.setWorker(args.threadId, "running", args.worker.result);
      bb.log.info(`stewards: retrying ${args.threadId}'s failed wake (attempt ${args.attemptNumber + 1}) at ${new Date(sendAt).toISOString()}`);
      return true;
    }

    /**
     * The terminal handling of a failed wake the plugin will not retry again.
     * A steward's binding gets one note naming the failure and the attempts,
     * the `wake failed:` phrase, and one `stuck` escalation whose text is the
     * provider error; nothing is woken. A worker keeps the `thread.failed`
     * path, which marks it failed and wakes the steward. A project steward has
     * no binding to note or phrase, so the failure is logged.
     */
    async function giveUpFailedWake(args: { threadId: string; attemptNumber: number; errorInfo: ProviderErrorInfo | null; binding: Binding | null; worker: Worker | null }): Promise<void> {
      const reason = describeWakeError(args.errorInfo);
      await clearWakeRetry(args.threadId);
      if (args.worker !== null) {
        // The `thread.failed` path, run here so the two handlers cannot race
        // over the same worker.
        const worker = store.worker(args.threadId) ?? args.worker;
        if (!workerInFlight(worker)) return;
        store.setWorker(args.threadId, "failed", reason);
        await closeRequesterNeed(args.threadId);
        store.note(worker.bindingId, `Worker "${worker.title}" failed: ${reason}`);
        scheduleReconcile(worker.bindingId);
        return;
      }
      if (args.binding === null) {
        bb.log.warn(`stewards: ${args.threadId}'s wake failed after ${args.attemptNumber} attempt(s): ${reason}`);
        return;
      }
      const b = store.binding(args.binding.id) ?? args.binding;
      const attempts = `${args.attemptNumber} attempt${args.attemptNumber === 1 ? "" : "s"}`;
      store.note(b.id, `Wake failed after ${attempts}: ${reason}.`);
      store.patch(b.id, { wakeFailure: reason, awaitingReport: false });
      if (!store.openEscalations(b.id).some((x) => x.kind === "stuck")) {
        const escalation = store.escalate({
          bindingId: b.id,
          kind: "stuck",
          question: `The steward's wake failed after ${attempts}: ${reason}.`,
          context: "Every retry the plugin made failed the same way, so the steward could not be woken.",
          meanwhile: "Waiting: the steward cannot be woken until the provider recovers; a later reconcile will try again.",
          route: nextRoute(b, null),
          recommendation: null,
          projectId: b.projectId,
          origin: { threadId: args.threadId, bindingId: b.id, chain: [] },
        });
        // The failed steward is not re-woken, but the escalation's route
        // (project steward, parent, or the user) is told.
        await deliver(b, escalation);
      }
    }

    /**
     * One reconcile of one binding: snapshot, lifecycle, compare, and wake
     * when something actionable changed (or `force` says this is a turn
     * regardless: adoption, the nightly pass). A linked pull request that
     * appeared, closed or merged changes what is leased, so the interest set
     * is pushed again.
     */
    async function reconcileBinding(bindingId: string, force: WakeReason | null): Promise<void> {
      const before = store.binding(bindingId);
      const leased = before === null ? "" : leasedPulls(before).join(" ");
      try {
        await reconcileOnce(bindingId, force);
      } finally {
        const after = store.binding(bindingId);
        if (after !== null && leasedPulls(after).join(" ") !== leased) pushInterest();
      }
    }

    async function reconcileOnce(bindingId: string, force: WakeReason | null): Promise<void> {
      let b = store.binding(bindingId);
      if (b === null) return;
      const config = await loadConfig(b.projectId);
      if (config === null) {
        // The first reconcile after adoption forces the wake, but a transient
        // read can exit here before it; leaving the binding un-threaded for
        // the next sweep to retry, which the wake-reason fallback below makes
        // sure it does (BB-92).
        bb.log.debug(`stewards: could not read the configuration of project ${b.projectId} while reconciling ${b.entityKey}; leaving it for the next sweep`);
        return;
      }
      // A project switched off on this server wakes nobody: a binding the
      // upgrade left open, or one whose stop turn is still running, is not
      // woken by a requeue, a doorbell or the Sentry sweep.
      if (!config.enabled) return;
      const playbook = bindingPlaybook(config, b);
      if (playbook === null) {
        // A pull request or ticket a watch adopted runs under its watch's
        // playbook only. With that playbook gone, the binding ends rather than
        // falling back to a different playbook the watch did not name.
        const watchAdopted = (b.kind === "pr" && adoptedByWatch(config, b) !== null) || (b.kind === "ticket" && b.adoptedBy !== null);
        if (watchAdopted && b.endedAt === null) await finishEnding(b, "unconfigured");
        return;
      }
      if (b.source === "ops") {
        await reconcileOps(b, config, playbook, force);
        return;
      }

      let entity: EntitySnapshot | null;
      try {
        entity = await snapshot(b.source, b.entityId);
      } catch (error) {
        bb.log.warn(`stewards: could not read ${b.entityKey}: ${errorMessage(error)}`);
        return;
      }
      if (entity === null) {
        if (b.endedAt === null) await finishEnding(b, "gone");
        return;
      }
      // An unread relation keeps the last known parent and children (BB-244).
      entity = keepRelations(b.lastSnapshot?.entity ?? null, entity);
      const observed: Observed = { entity, pulls: b.kind === "ticket" ? await linkedPulls(entity) : [] };
      const prev = b.lastSnapshot;

      // BB-53: a merged pull request whose playbook names a deployment target
      // is recorded as awaiting one. The plugin evaluates a structured
      // `carries` rule itself (BB-132); a free-text rule it leaves to the
      // steward, exactly as before.
      const deployTargets = playbook.deployments;
      const deploymentChanges: Change[] = [];
      const deploymentsBefore = b.deployments;
      let deployments = b.deployments;
      if (deployTargets.length > 0) {
        const beforeDeploy = deployments;
        // BB-260: a live-at-merge rule is only live on the default branch, so
        // the record needs to know each merged pull's default branch. Read it
        // only when a target actually has a live rule, and once per repo. A
        // read that fails names no default branch, so the merge is not live
        // (the safe direction) and the watch keeps awaiting a deployment.
        const wantsLive = deployTargets.some((t) => typeof t.carries !== "string" && t.carries.some((r) => r.strategy.kind === "live-at-merge"));
        let isDefaultBase: ((prRepo: string, base: string | null) => boolean) | undefined;
        if (wantsLive) {
          const branches = new Map<string, string | null>();
          for (const p of mergedPulls(observed)) {
            if (branches.has(p.unit)) continue;
            branches.set(p.unit, await github.defaultBranch(p.unit).catch(() => null));
          }
          isDefaultBase = (prRepo, base) => base !== null && branches.get(prRepo) === base;
        }
        deployments = recordMerged(deployments, observed, deployTargets, now(), isDefaultBase);
        if (deployments !== beforeDeploy) {
          const fresh = Object.keys(deployments).filter((k) => beforeDeploy[k] === undefined);
          // A reconcile can also only drop a not-applicable watch (BB-132
          // follow-up): there is nothing new to await, so do not announce it.
          // A live-at-merge watch (BB-260) is already `deployed` when it is
          // recorded: nothing builds or applies its paths, so it has no
          // deployment to await and the steward is woken with the verdict now.
          const liveNow = fresh.filter((k) => deployments[k]?.state === "deployed");
          const awaiting = fresh.filter((k) => deployments[k]?.state !== "deployed");
          if (awaiting.length > 0) deploymentChanges.push({ text: `Awaiting deployment: ${awaiting.join(", ")} via ${deployTargets.map((t) => `${t.repo} ${t.environment}`).join(", ")}`, actionable: true });
          if (liveNow.length > 0) deploymentChanges.push({ text: `Deployed at merge: ${liveNow.map((k) => `${k} — ${deployments[k]?.note ?? "live at merge"}`).join("; ")}`, actionable: true });
        }
        if (deployments !== b.deployments) b = store.patch(b.id, { deployments });
        // BB-59: a deployment that already exists confirms a merge whose
        // doorbell was missed, on the first read and on every sweep. Read
        // before the timeout check so an existing deployment wins over the
        // deadline; with none, the timeout path is exactly as before.
        const evaluatedIds = new Set<string>();
        for (const target of deployTargets) {
          if (!Object.values(deployments).some((w) => (w.state === "merged" || w.state === "deploying") && matchesTarget(target, w.repo, w.environment))) continue;
          const read = await readDeployments(target);
          if (read === null) continue;
          const beforeRead = deployments;
          const applied = applyDeploymentRead(deployments, target, read, now());
          if (applied.changed.length === 0 || applied.deployment === null) continue;
          const state = applied.deployment.state === "" ? "created" : applied.deployment.state;
          const failed = state === "failure" || state === "error";
          const line = `Deployment ${applied.deployment.id} (${state}) for ${target.repo} ${target.environment}${applied.deployment.url === null ? "" : ` — ${applied.deployment.url}`}${typeof target.carries === "string" ? `; the playbook's rule: ${target.carries}` : ""}`;
          const movedIds = Object.keys(applied.deployments).filter((wid) => beforeRead[wid] !== applied.deployments[wid]);
          // BB-204: only a final deployment is applied and evaluated. An
          // in_progress or created one records its facts but moves no watch,
          // so it is a quiet note and not a wake.
          if (!failed && state !== "success") {
            deployments = applied.deployments;
            b = store.patch(b.id, { deployments });
            b = store.note(b.id, line, true);
            continue;
          }
          if (failed) {
            deployments = applied.deployments;
            b = store.patch(b.id, { deployments });
            b = store.note(b.id, line, false);
            bb.log.info(`stewards: deployment ${applied.deployment.id} (${state}) on ${target.repo} ${target.environment} failed ${applied.changed.join(", ")} (read)`);
            continue;
          }
          // BB-132/BB-204: evaluate a success before deciding to wake, so a
          // missed-doorbell not-yet or a repeat no-rule stays quiet.
          const evaluated = await evaluateAppliedDeployment(applied.deployments, beforeRead, target, movedIds, now());
          for (const wid of movedIds) evaluatedIds.add(wid);
          deployments = evaluated.deployments;
          b = store.patch(b.id, { deployments });
          b = store.note(b.id, [line, ...evaluated.notes].join("; "), !evaluated.wake);
          if (evaluated.wake) bb.log.info(`stewards: deployment ${applied.deployment.id} (${state}) on ${target.repo} ${target.environment} concerns ${applied.changed.join(", ")} (read)`);
        }
        // BB-132/BB-204: a watch left `deploying` by an earlier pass is
        // re-evaluated, so a transient read failure is retried, a playbook
        // that adds a rule settles a no-rule watch, and a re-resolved merge
        // commit is picked up. A watch the read just evaluated is skipped, and
        // a missing rule already noted does not wake again.
        const reader = carriesReader();
        for (const [id, watch] of Object.entries(deployments)) {
          if (watch.state !== "deploying") continue;
          if (evaluatedIds.has(id)) continue;
          const target = deployTargets.find((t) => (watch.target === "" ? matchesTarget(t, watch.repo, watch.environment) : targetKeyOf(t) === watch.target));
          if (target === undefined || typeof target.carries === "string") continue;
          const verdict = await evaluateCarries(target, { merge: watch.mergeSha, prRepo: watch.prRepo, files: watch.files, ref: watch.ref }, reader);
          if (verdict === null) continue;
          const label = `${watch.key}${target.name === undefined ? "" : ` (${target.name})`}`;
          if (verdict.kind === "deployed" || verdict.kind === "not-yet") {
            const settled = reportDeployment(deployments, { state: verdict.kind, key: watch.key, ...(watch.target === "" ? {} : { target: watch.target }), note: verdict.note }, now(), target.timeout);
            if (settled.changed !== null) {
              deployments = settled.deployments;
              b = store.patch(b.id, { deployments });
              bb.log.info(`stewards: carries ${verdict.kind} for ${label}: ${verdict.note}`);
            }
          } else {
            if (matchCarriesRule(target.carries, watch.prRepo, watch.files) === null && noRuleNoted(watch.note)) continue;
            deployments = { ...deployments, [id]: { ...watch, note: verdict.note } };
            b = store.patch(b.id, { deployments });
            b = store.note(b.id, `Carries not decided for ${label}: ${verdict.note}`, false);
          }
        }
        const late = timeoutsDue(deployments, now());
        if (late.length > 0) {
          const labels = late.map((id) => (deployments[id] === undefined ? id : `${deployments[id]!.key}${deployments[id]!.target === "" ? "" : ` (${deployments[id]!.target})`}`));
          const first = deployments[late[0]!];
          const target = first === undefined ? undefined : deployTargets.find((t) => (first.target === "" ? matchesTarget(t, first.repo, first.environment) : targetKeyOf(t) === first.target));
          const within = target === undefined ? "" : ` within ${formatDuration(target.timeout)}`;
          deployments = timeOut(deployments, late, now());
          deploymentChanges.push({ text: `No matching deployment for ${labels.join(", ")}${within}${first === undefined ? "" : `; check the run: https://github.com/${first.repo}/actions`}`, actionable: true });
        }
        if (deployments !== b.deployments) b = store.patch(b.id, { deployments });
      }
      const awaitingDeploy = deployTargets.length > 0 && Object.values(deployments).some((w) => w.state === "merged" || w.state === "deploying");

      // The assignee set follows the entity's own source: a Linear ticket the
      // Linear login, a GitHub issue the GitHub login (BB-234). A read that
      // failed never reaches here, so a partial or rate-limited read keeps the
      // binding.
      const owner = entity.source === "github" ? config.githubLogin : config.linearLogin;
      const life = lifecycle(b, playbook, entity, config.file.label, { labelRequired: adoptedByWatch(config, b) === null, owner });
      // A binding with no steward thread is still awaiting adoption: a first
      // wake lost to a transient read is retried on the next reconcile, as the
      // ops, deps and sentry paths already do (BB-92).
      let reason: WakeReason | null = force ?? (b.threadId === null ? "adopted" : null);
      if (life.kind === "stay-ended") {
        const labelled = b.kind === "review" || adoptedByWatch(config, b) !== null || hasLabel(entity, config.file.label);
        signalNeedActionability(b, observed);
        store.patch(b.id, { lastSnapshot: observed, ...(b.manualDetach && !labelled ? { manualDetach: false } : {}) });
        return;
      }
      if (life.kind === "reopen") {
        b = await reopen(b, life.why);
        reason = "reopen";
      }
      // A terminal binding holds open while a deployment is outstanding, but
      // only one that has not begun ending: one already following through (a
      // ticket Done with its pull request still open) must keep falling
      // through to the wake, so the deployment is not swallowed.
      if ((life.kind === "terminal" || life.kind === "detach" || life.kind === "reassigned") && !(life.kind === "terminal" && awaitingDeploy && b.ending === null)) {
        if (b.ending === null) {
          await beginEnding(b, config, playbook, life.kind, observed);
          return;
        }
        // Following through, the steward is woken as before; otherwise its
        // one last turn is under way and there is nothing to add to it.
        if (life.kind !== "terminal" || !followingThrough(b)) {
          signalNeedActionability(b, observed);
          store.patch(b.id, { lastSnapshot: observed });
          return;
        }
        if (b.followThroughUntil !== null && now() >= b.followThroughUntil) {
          await followThroughRanOut(b);
          return;
        }
      } else if (b.ending !== null) {
        signalNeedActionability(b, observed);
        store.patch(b.id, { lastSnapshot: observed });
        return;
      }

      const { phase, stage } = phaseAndStage(playbook, entity.state, entity.labels);
      const currentSpec = specHashFor(b, entity);
      const changes: Change[] = [];
      let ready = b.ready;
      const approval = playbook.ready?.approval;
      const sourceLabel = entity.source === "github" ? "GitHub" : "Linear";
      if (typeof approval === "object" && lc(entity.state) === lc(approval.state) && ready.approval === null) {
        ready = { ...ready, approval: { at: now(), specHash: currentSpec, by: entity.source, approvedText: specTextFor(b, entity) }, voidedAt: null, voidedApprovedText: null, voidedApprovedAt: null };
        changes.push({ text: `Approved in ${sourceLabel} (now ${entity.state})`, actionable: true });
      }
      const workers = store.workers(b.id);
      const workerInFlight = anyWorkerInFlight(workers);
      // Rule 0: which linked pull requests are the worker's own. Read the
      // branches and reported URLs whether or not a worker is in flight: the
      // diff only quiets them while one is, and the idle rule (BB-83) needs the
      // set for a binding whose worker has finished its turn.
      const ownPulls = await ownPullKeys(b, workers, observed);
      // BB-203: an open need or `user` escalation keeps the worker's own pull
      // request activity loud, so the steward can reconcile the user's item.
      const userWaiting = store.openNeeds(b.id).length > 0 || store.openEscalations(b.id).some((x) => x.status === "open" && x.route === "user");
      const fresh = prev === null ? [] : diffObserved(prev, observed, { own: ownThreads(b), stewardThreadId: b.threadId, approved: ready.approval !== null, cursor: b.commentCursor, workerInFlight, userWaiting, ownPulls, stageOf: (state) => phaseOf(playbook, state)?.stage ?? null, userThread: isUserThread });
      changes.push(...fresh);
      // BB-248: a label that changes the phase with no state change is news
      // on its own; a state move already carries its own actionable line. The
      // worker's own build/review loop stays quiet (BB-52).
      const stateMoved = prev !== null && prev.entity.state !== entity.state;
      if (!stateMoved && phase !== b.phase) {
        const own = workerInFlight && isOwnStageChange(b.stage, stage);
        changes.push({ text: `Phase: ${b.phase ?? entity.state} → ${phase}`, actionable: !own });
      }
      changes.push(...deploymentChanges);
      // BB-83: a binding in a build or review stage with nothing to wait on is
      // woken once per idle period, after the grace. The period starts at the
      // later of the last worker's end, the last own pull request's close and
      // the last wake; a worker finish asks for the look at once, without the
      // grace. An idle wake ends the period until one of those happens again.
      const idle = idleInActiveStage(
        { stage, ending: b.ending, hold: b.hold, deployments, workers, ownPulls, escalations: store.openEscalations(b.id), needs: store.openNeeds(b.id), requeueUntil: b.requeueUntil },
        observed,
        now(),
      );
      // Re-read the idle fields from the store: a worker finish may have set
      // `idleWakeNow` (or a deployment verdict reset the period) after this
      // reconcile captured `b`, and writing the stale locals back would lose
      // the loud-at-once look.
      const current = store.binding(b.id);
      let idleSince = current?.idleSince ?? b.idleSince;
      let idleWokenAt = current?.idleWokenAt ?? b.idleWokenAt;
      let idleWakeNow = current?.idleWakeNow ?? b.idleWakeNow;
      if (!idle) {
        idleSince = null;
        idleWokenAt = null;
        idleWakeNow = false;
      } else {
        const lastWorkerEnd = workers.reduce((at, w) => (w.endedAt !== null && w.endedAt > at ? w.endedAt : at), 0);
        if (idleSince === null || lastWorkerEnd > idleSince) {
          idleSince = lastWorkerEnd > 0 ? lastWorkerEnd : (b.wokeAt ?? now());
          idleWokenAt = null;
        }
        if (prev !== null && ownPullClosed(prev, observed, ownPulls)) {
          idleSince = now();
          idleWokenAt = null;
        }
        if (deployments !== deploymentsBefore) {
          idleSince = now();
          idleWokenAt = null;
        }
        if (idleWokenAt === null && b.wokeAt !== null && b.wokeAt > idleSince) idleSince = b.wokeAt;
      }
      if (idle && idleWokenAt === null && (idleWakeNow || (idleSince !== null && now() - idleSince >= playbook.idleGraceMs))) {
        changes.push({ text: IDLE_WAKE_TEXT, actionable: true });
        idleWokenAt = now();
      }
      idleWakeNow = false;
      if (idleSince !== b.idleSince || idleWokenAt !== b.idleWokenAt || idleWakeNow !== b.idleWakeNow) b = store.patch(b.id, { idleSince, idleWokenAt, idleWakeNow });
      // BB-35 step 2: a fresh unsigned comment by the owner that differs from
      // the recommendation on a decision that cited lessons is a correction,
      // counted once. Anyone else's words never count. Only from the second
      // observation on: comments already there at adoption are history, not an
      // event.
      if (prev !== null) countCommentCorrections(b, observed);
      // Criterion 4: a spec comment the user wrote from their own thread is
      // the user's own words. With approval: user it carries its own approval,
      // pinned to the spec it just changed, whether or not an earlier
      // approval has gone stale.
      if (approval === "user" && (ready.approval === null || ready.approval.specHash !== currentSpec) && fresh.some((c) => c.byUser === true)) {
        ready = { ...ready, approval: { at: now(), specHash: currentSpec, by: "user", approvedText: specTextFor(b, entity) }, voidedAt: null, voidedApprovedText: null, voidedApprovedAt: null, declinedSpecHash: null };
        changes.push({ text: "The user's spec comment approves the spec (approval: user)", actionable: true });
      }
      // Only an entry into build from spec: review → build is the worker's
      // normal loop, and an unreported checklist is not an unmet one.
      if (stage === "build" && b.stage === "spec" && prev !== null && gateKnownUnmet(playbook, ready, currentSpec)) {
        changes.push({ text: `Moved into a build stage (${phase}) before the ready gate passed`, actionable: true });
      }
      if (b.requeueAt !== null && b.requeueAt <= now()) changes.push({ text: "Requeue time came", actionable: true });
      if (b.playbookVersion !== playbook.version) changes.push({ text: `Playbook ${playbook.name} updated (${b.playbookVersion} → ${playbook.version})`, actionable: false });
      // A note queued while the steward was busy, or kept quiet, can say what
      // this comparison says again. Comment news is counted from the cursor,
      // which only a wake moves, so the comparison's count is the current one
      // and a queued count is stale; anything else is kept once, and is
      // actionable if either says so.
      const queued = b.pending;
      let loudQueued = queued.filter((n) => n.quiet !== true).length;
      for (const n of queued) {
        if (isCommentNews(n.text)) continue;
        const same = changes.find((c) => c.text === n.text);
        if (same !== undefined) same.actionable ||= n.quiet !== true;
        else changes.push({ text: n.text, actionable: n.quiet !== true });
      }

      signalNeedActionability(b, observed, ready);
      b = store.patch(b.id, { lastSnapshot: observed, phase, stage, title: entity.title, url: entity.url, entityKey: entity.key, playbookVersion: playbook.version, ready });
      // BB-54 item 4: a ticket that links a new pull request re-runs the
      // overlap check, even past its ready gate, and a new pull request clears
      // a "no more coming" report. The report path clears it too, when a
      // steward reports more are coming.
      const linkedBefore = new Set((prev?.entity.linkedPulls ?? []).map((l) => lc(l.key ?? l.url ?? "")));
      const linkedNew = observed.entity.linkedPulls.some((l) => {
        const k = lc(l.key ?? l.url ?? "");
        return k !== "" && !linkedBefore.has(k);
      });
      if (linkedNew) {
        const clear: { noMorePulls?: null; scheduleAsked?: string[] } = {};
        if (b.noMorePulls === true) clear.noMorePulls = null;
        if (b.scheduleAsked.length > 0) clear.scheduleAsked = [];
        if (Object.keys(clear).length > 0) b = store.patch(b.id, clear);
      }
      const approvalEvents = await syncNeeds(b, observed, playbook, changes);
      // BB-264: `syncNeeds` records a derived stacked-PR merge hold on the
      // binding; re-read it so the status below and the wake see the hold.
      b = store.binding(b.id) ?? b;
      // BB-203: write the status the plugin observed itself, without a steward
      // turn, before the wake, so the page and sidebar are current within one
      // refetch. Checks fold into the phrase; approved, merged and deployed
      // name the new state. Applied in that order, so the newest wins.
      const mechanical: MechanicalEvent[] = [];
      if (prev !== null) {
        const checks = ownChecksFinished(prev, observed, ownPulls);
        if (checks !== null) mechanical.push({ kind: "checks", ...checks });
        const merged = ownPullMerged(prev, observed, ownPulls);
        if (merged !== null) mechanical.push({ kind: "merged", ...merged });
      }
      mechanical.push(...approvalEvents);
      const settled = deploymentSettled(deploymentsBefore, deployments);
      if (settled !== null) mechanical.push({ kind: "deployed", ...settled });
      for (const event of mechanical) b = patchMechanicalStatus(b, event);
      // The work this binding was holding others behind has landed: lift them.
      if (allPullsMerged(b, observed) && (prev === null || !allPullsMerged(b, prev))) await releaseBehind(b, "merged its pull requests");
      // BB-89: level-triggered, so a hold placed after its targets finished, or
      // a noMorePulls report that arrived after the merge, lifts on this
      // reconcile rather than waiting for an edge that has already passed.
      // Every target must satisfy `finished`; the release goes through
      // releaseBehind, so the wake, the notes and the re-hold of overlapping
      // waiters are the same as any other lift.
      if (b.holdBehind.length > 0) {
        const projectId = b.projectId;
        const targets = b.holdBehind.map((k) => store.find(k, projectId)).filter((t): t is Binding => t !== null);
        if (targets.length === b.holdBehind.length && targets.every((t) => t.lastSnapshot !== null && finished(t, t.lastSnapshot))) {
          for (const t of targets) await releaseBehind(t, howFinished(t));
          b = store.binding(b.id) ?? b;
        }
      }
      // BB-256: a merge hold is level-triggered the same way, so a hold placed
      // after its targets finished lifts on this look rather than waiting for
      // an edge that has already passed. Every target must satisfy `finished`;
      // the release goes through releaseMergeBehind, so the wake and the note
      // are the same as any other lift.
      if (b.mergeBehind.length > 0) {
        const projectId = b.projectId;
        const targets = b.mergeBehind.map((k) => store.find(k, projectId)).filter((t): t is Binding => t !== null);
        if (targets.length === b.mergeBehind.length && targets.every((t) => t.lastSnapshot !== null && finished(t, t.lastSnapshot))) {
          for (const t of targets) await releaseMergeBehind(t, howFinished(t));
          b = store.binding(b.id) ?? b;
        }
      }
      // BB-215: a stack-wait lifts the moment the work it waits for opens a
      // pull request, or when that work ends without one. Both directions are
      // checked here: this binding's own open pull request (or ending) releases
      // its waiters, and this binding's own stack-wait releases if its targets
      // are open or finished (level-triggered, so a hold placed after the
      // pull request opened or the target ended lifts on the next look).
      await releaseStack(b, observed);
      if (b.holdStack.length > 0) {
        const projectId = b.projectId;
        const targets = b.holdStack.map((k) => store.find(k, projectId)).filter((t): t is Binding => t !== null);
        for (const t of targets) await releaseStack(t, t.lastSnapshot);
        b = store.binding(b.id) ?? b;
      }
      const scheduling = await syncScheduleRequest(b, playbook);
      // BB-55: the start-now backstop is queued by the report that passed the
      // gate, but by the time the turn ends the steward may have obeyed: the
      // ticket is in its build stage, a worker is running, or something now
      // holds it. Re-check here, with the fresh snapshot and the requests
      // filed, and drop the note rather than wake a steward that started.
      if (b.pending.some((n) => n.text === START_WORKER_WAKE)) {
        const startStillDue =
          b.stage === "spec" &&
          gateState(playbook, b.ready, currentSpec).passed &&
          !anyWorkerInFlight(store.workers(b.id)) &&
          b.hold === null &&
          !store.openEscalations(b.id).some((x) => x.kind === "approval" || x.kind === "schedule");
        if (!startStillDue) {
          b = store.patch(b.id, { pending: b.pending.filter((n) => n.text !== START_WORKER_WAKE) });
          for (let i = changes.length - 1; i >= 0; i--) if (changes[i]!.text === START_WORKER_WAKE) changes.splice(i, 1);
        }
        // The drop changed what is queued; `deferred` and the wake reason read
        // this, so it must not stay stale.
        loudQueued = b.pending.filter((n) => n.quiet !== true).length;
      }
      /**
       * Keep news for the next turn: what is actionable as a reason for it, the
       * rest as quiet notes. A quiet comment count is not kept: the next wake
       * counts from the cursor again.
       */
      const keep = (which: Change[]) => {
        for (const c of which) {
          if (!c.actionable && isCommentNews(c.text)) continue;
          if (!queued.some((n) => n.text === c.text && (n.quiet === true) === !c.actionable)) store.note(b.id, c.text, !c.actionable);
        }
      };
      await toldWhileWithUser(b, fresh);
      const due = reason !== null || changes.some((c) => c.actionable);
      if (!due) {
        // Nothing for a turn now; the steward hears it with the next one.
        keep(changes);
        // No turn is coming to report the gate, so look at it here: a gate
        // left waiting on its approver (a report from before this check, a
        // request declined, then the spec changed) is asked for now.
        const approvalAsked = !b.awaitingReport && (await syncApprovalRequest(b, playbook)) !== null;
        const asked = [approvalAsked ? `approval requested for ${b.entityKey}` : null, scheduling === null ? null : `scheduling requested for ${b.entityKey}`].filter((r) => r !== null);
        if (asked.length > 0) await wakeProject(b.projectId, asked.join(" and "), { digestDue: false });
        return;
      }
      if (scheduling !== null) await wakeProject(b.projectId, `scheduling requested for ${b.entityKey}`, { digestDue: false });
      const lines = [...new Set(changes.map((c) => c.text))];

      // Not now: keep the news as notes, delivered at the next turn. A held
      // binding still hears from its people (guidance, approvals, lifecycle).
      const deferred = (await settings.get()).paused || (b.hold !== null && reason === null && loudQueued === 0);
      const info = b.threadId === null ? null : await threadInfo(b.threadId);
      if (deferred || (info !== null && busy(info.status))) {
        keep(changes);
        if (reason !== null && reason !== "changed") store.note(b.id, `Due: ${reason}`);
        return;
      }
      // The steward now has the workers' reports: archive the finished ones
      // that do not need it to stay visible (BB-47). Only once the wake was
      // delivered, so a failed send keeps the worker for the retry.
      // An idle wake is a `changed` turn: there is no lifecycle instruction
      // for it, and the line under What changed is the whole wake (BB-83).
      const idleDue = lines.includes(IDLE_WAKE_TEXT);
      if (await wake(b, config, playbook, observed, lines, reason ?? (idleDue ? "changed" : followingThrough(b) ? "follow-through" : b.requeueAt !== null && b.requeueAt <= now() && loudQueued === 0 ? "requeue" : "changed"))) await archiveFinishedWorkers(store.binding(b.id) ?? b);
    }

    // ---- ops bindings ----------------------------------------------------------------------------
    //
    // An ops binding watches a target the project file lists rather than an
    // entity in a source plugin. The plugin looks with kubectl on the
    // project's machine (kubectl.ts, host.ts), compares what it saw with the
    // fingerprint map, and wakes the steward with the look: at once for a
    // problem that is new or back after its ticket was resolved, and at every
    // requeue whatever it finds, so a problem still failing under its open
    // ticket is one comment per interval and a healthy look is one short
    // "all healthy" report. A sweep's look between requeues that finds
    // nothing new is recorded and wakes nobody.

    // Made on first use: only a project with ops targets needs its host entry.
    let hostClient: ReturnType<typeof bb.hosts.experimental_client<typeof hostContract>> | null = null;
    const KUBECTL_TIMEOUT_MS = 30_000;

    /**
     * Every kubectl call goes through here, and only get, describe, logs and
     * auth can-i pass (kubectlRefusal; host.ts checks again). It runs on the
     * project's machine, the developer's own, where kubectl reaches the
     * cluster as them. Where a stricter wall comes later, it goes here.
     */
    async function runKubectl(projectId: string, args: string[]): Promise<KubectlResult> {
      const refused = kubectlRefusal(args);
      if (refused !== null) throw new Error(refused);
      const hostId = await projectHost(projectId);
      if (deps.kubectl !== undefined) return deps.kubectl(args, { projectId, hostId });
      if (hostId === null) throw new Error("the project has no machine bb can reach to run kubectl on");
      hostClient ??= bb.hosts.experimental_client({ contract: hostContract });
      return hostClient.call("opsKubectl", { args, timeoutMs: KUBECTL_TIMEOUT_MS }, { hostId, timeoutMs: KUBECTL_TIMEOUT_MS + 10_000 });
    }

    const opsReaderFor = (config: ProjectConfig): OpsReader => {
      const context = config.role?.ops?.context;
      return createKubectlReader((args) => runKubectl(config.projectId, args), context === undefined ? {} : { context });
    };

    /**
     * The states of the tickets a look's problems are filed under, read through
     * the filing target's source (BB-235): Linear by key, GitHub by
     * `owner/repo#n`. A GitHub issue is resolved when its state starts with
     * `closed`; its close date is the snapshot's `updatedAt`, since the source
     * contract carries no separate `closedAt`. Null for one that cannot be read.
     */
    async function ticketStates(target: FilingTarget | null, keys: string[]): Promise<Map<string, TicketState>> {
      const out = new Map<string, TicketState>();
      const source: Source = target?.source ?? "linear";
      for (const key of [...new Set(keys)].slice(0, 20)) {
        const e = await snapshot(source, key).catch(() => null);
        const resolved = e !== null && ticketResolved(e);
        out.set(key, e === null ? null : { state: e.state, stateType: e.stateType, closedAt: e.completedAt ?? e.canceledAt ?? (resolved ? (e.updatedAt ?? null) : null), labels: e.labels, url: e.url });
      }
      return out;
    }

    /** At most this many issues a dedup search returns, and how many a look searches for. */
    const DEDUP_LIMIT = 10;

    /**
     * The tickets a fingerprint map has lost, found by searching the filing
     * target's source for the exact `Fingerprint:` line the steward put in the
     * ticket (BB-233's search, read through the target's source since BB-235).
     * Returns the fingerprints adopted, or null when the search could not run
     * or was partial (an older source, a read error), so the caller marks the
     * new findings "dedup unavailable" and the wake tells the steward to
     * search itself rather than risk a duplicate. It only reads; it never
     * files, comments or reassigns.
     */
    async function dedupFingerprints(target: FilingTarget | null, fingerprints: string[]): Promise<Map<string, string> | null> {
      const adopted = new Map<string, string>();
      if (fingerprints.length === 0) return adopted;
      // No target to search is not "nothing found": dedup did not run, so the
      // caller marks the new findings unavailable rather than risk a duplicate.
      if (target === null) return null;
      for (const fingerprint of fingerprints) {
        let out: z.infer<typeof sourceContract.sourceSearchIssues.output>;
        try {
          out = await sourceRpc(target.source, "sourceSearchIssues", { units: [target.target], query: fingerprint, limit: DEDUP_LIMIT }, sourceContract.sourceSearchIssues.output);
        } catch (error) {
          if (!sourceRpcMissing(error)) bb.log.warn(`stewards: the dedup search for ${fingerprint} failed: ${errorMessage(error)}`);
          return null;
        }
        if (out.unsupported || out.errors.length > 0) return null;
        const matches = out.issues.filter((issue) => hasFingerprintLine(issue.description, fingerprint));
        // A duplicate line is meant to be impossible, but if two tickets carry
        // it, prefer one that can still be commented on over one already resolved.
        const open = matches.find((issue) => !ticketResolved(issue));
        if (matches.length > 0) adopted.set(fingerprint, (open ?? matches[0]!).key);
      }
      return adopted;
    }

    /** The fingerprints of a look's sightings with no mapped ticket, for the dedup search. */
    const unmappedFingerprints = (rows: ReadonlyMap<string, FingerprintRow>): string[] => [...rows.values()].filter((r) => r.ticketKey === null).map((r) => r.fingerprint);

    /** Adopt the tickets the dedup search found into the map, so classification sees them like any mapped one. */
    function adoptTickets(b: Binding, rows: Map<string, Fingerprint>, adopted: ReadonlyMap<string, string>): void {
      for (const [fingerprint, ticketKey] of adopted) {
        store.adoptTicket(b.projectId, fingerprint, ticketKey);
        const row = rows.get(fingerprint);
        if (row !== undefined) rows.set(fingerprint, { ...row, ticketKey });
      }
    }

    /** Where a project's ops and dependency watches file: the role's target, or the first Linear team (BB-235). */
    const filingTargetFor = (config: ProjectConfig): FilingTarget | null => roleOpsTeam(config.role, config.file);

    /** The login a filing target files under: this server's GitHub login for a repo, its Linear login for a team. */
    const filingLogin = (target: FilingTarget | null, config: ProjectConfig): string | null => (target?.source === "github" ? config.githubLogin : config.linearLogin);

    /** Every ops target a project watches: the k8s namespaces, the Sentry projects and the Dependabot repositories. */
    const allOpsTargets = (config: ProjectConfig): OpsTarget[] => [...roleK8sTargets(config.role), ...roleSentryTargets(config.role), ...roleDepsTargets(config.role, config.repos)];

    /** One look at an ops binding's target, its problems entered in the fingerprint map and classified against it. */
    async function lookAt(b: Binding, config: ProjectConfig, target: K8sTarget, playbook: Playbook): Promise<OpsLook> {
      const at = now();
      const since = b.opsLook !== null && b.opsLook.error === null ? b.opsLook.at : at - playbook.requeueDefaultMs;
      const filing = filingTargetFor(config);
      try {
        const { sightings, ...rest } = await opsReaderFor(config).look(target, { now: at, since });
        const rows = store.sight(b.projectId, b.id, sightings.map((s) => ({ fingerprint: s.fingerprint, summary: s.summary })));
        const adopted = await dedupFingerprints(filing, unmappedFingerprints(rows));
        if (adopted !== null) adoptTickets(b, rows, adopted);
        const tickets = await ticketStates(filing, [...rows.values()].map((r) => r.ticketKey).filter((k): k is string => k !== null));
        const findings = classify(sightings, rows, tickets, at, filingLogin(filing, config)).map((f) => (adopted === null && f.class === "new" ? { ...f, dedupUnavailable: true } : f));
        return { ...rest, at, target: opsTargetKey(target), error: null, findings };
      } catch (error) {
        return { at, target: opsTargetKey(target), error: errorMessage(error), pods: 0, healthy: 0, deployments: [], warnings: [], logs: "unneeded", notes: [], findings: [] };
      }
    }

    /**
     * The open tickets a new medium or low alert may join, one per repo and
     * ecosystem: grouped from the fingerprint map by ticket, each with the
     * tightest deadline among its alerts. Only batchable (medium and low)
     * fingerprints count, since critical and high never coalesce, and a
     * ticket that is completed or canceled is not open: a new alert for its
     * repo and ecosystem files a new ticket rather than commenting on a
     * resolved one. A ticket whose state cannot be read counts as open, as
     * in `classify`.
     */
    function openBatchedTickets(rows: readonly Fingerprint[], sla: ProjectFile["deps"]["sla"], tickets: ReadonlyMap<string, TicketState>, clockAt: (fingerprint: string, firstSeenAt: number) => number): DepsTicket[] {
      const byTicket = new Map<string, DepsTicket>();
      for (const r of rows) {
        if (r.ticketKey === null || r.severity === null || r.ecosystem === null) continue;
        if (!isBatchable(r.severity as DependabotSeverity)) continue;
        const state = tickets.get(r.ticketKey) ?? null;
        if (ticketResolved(state)) continue;
        const repo = repoOfFingerprint(r.fingerprint);
        if (repo === null) continue;
        // The plugin owns the deadline: it is the alert's own created_at plus
        // the SLA, never Linear's due date (which the source contract does not
        // carry). The plan may tighten the ticket's deadline, never loosen it.
        const dueAt = deadlineAt(r.severity as DependabotSeverity, sla, clockAt(r.fingerprint, r.firstSeenAt));
        const ticket = byTicket.get(r.ticketKey);
        if (ticket === undefined) byTicket.set(r.ticketKey, { ticketKey: r.ticketKey, repo, ecosystem: r.ecosystem, dueAt });
        else ticket.dueAt = Math.min(ticket.dueAt, dueAt);
      }
      return [...byTicket.values()];
    }

    /** One look at a Dependabot alert target: the repository's open alerts, classified and batched. */
    async function lookAtDeps(b: Binding, config: ProjectConfig, target: DependabotTarget): Promise<DepsLook> {
      const at = now();
      const filing = filingTargetFor(config);
      try {
        const out = await sourceRpc("github", "sourceDependabotAlerts", { units: [target.repo], state: "open" }, sourceContract.sourceDependabotAlerts.output);
        const alerts: DependabotAlert[] = out.alerts;
        const rows = store.sight(
          b.projectId,
          b.id,
          alerts.map((a) => {
            const s = sightingOf(a);
            return { fingerprint: s.fingerprint, summary: s.summary, severity: s.severity, ecosystem: s.ecosystem };
          }),
        );
        // A fingerprint the map has lost but Linear still has a ticket for is
        // adopted here, exactly as in the ops look, before the batch plan reads
        // the map: an adopted medium or low alert then joins its ticket like
        // any mapped one.
        const adopted = await dedupFingerprints(filing, unmappedFingerprints(rows));
        if (adopted !== null) adoptTickets(b, rows, adopted);
        // Every fingerprint row, not just this look's: a batched ticket that
        // is no longer in the open alerts still has rows, and whether it is
        // open decides if a new medium or low alert may join it.
        const allRows = store.fingerprints(b.id);
        const sightings: Sighting[] = alerts.map((a) => ({ fingerprint: alertFingerprint(a), workload: a.package, pods: [], container: null, signature: a.severity, summary: `${a.severity} ${a.package}`, restarts: 0, events: [], logs: null, previous: false }));
        const tickets = await ticketStates(filing, [...allRows].map((r) => r.ticketKey).filter((k): k is string => k !== null));
        const findings = classify(sightings, rows, tickets, at, filingLogin(filing, config)).map((f) => (adopted === null && f.class === "new" ? { ...f, dedupUnavailable: true } : f));
        const byFingerprint = new Map(alerts.map((a) => [alertFingerprint(a), a]));
        // The SLA clock is the alert's own created_at, so a binding recreated
        // later does not hand a ticket a fresh deadline (SC-111); a row whose
        // alert is no longer listed keeps the first-seen clock it had.
        const clockAt = (fingerprint: string, firstSeenAt: number): number => {
          const a = byFingerprint.get(fingerprint);
          return a === undefined ? firstSeenAt : alertClockAt(a, firstSeenAt);
        };
        const open = openBatchedTickets(allRows, config.file.deps.sla, tickets, clockAt);
        const depsFindings: DepsFinding[] = [];
        for (const f of findings) {
          const a = byFingerprint.get(f.fingerprint);
          if (a === undefined) continue;
          const firstSeenAt = rows.get(f.fingerprint)?.firstSeenAt ?? at;
          const dueAt = deadlineAt(a.severity, config.file.deps.sla, alertClockAt(a, firstSeenAt));
          const ticketState = f.ticket === null ? null : (tickets.get(f.ticket) ?? null);
          depsFindings.push({
            fingerprint: f.fingerprint,
            alertNumber: a.number,
            severity: a.severity,
            package: a.package,
            ecosystem: a.ecosystem,
            manifestPath: a.manifestPath,
            ghsaId: a.ghsaId,
            fixedVersion: a.fixedVersion,
            summary: a.summary ?? f.summary,
            state: a.state,
            url: a.url,
            dueAt,
            ticketLabels: ticketState?.labels ?? [],
            priority: priorityFor(a.severity),
            class: f.class,
            ticket: f.ticket,
            ticketState: f.ticketState,
            closedAt: f.closedAt,
            window: f.window,
            assignee: f.assignee,
            dedupUnavailable: f.dedupUnavailable,
            firstSeenAt,
            alertCreatedAt: a.createdAt !== null && !Number.isNaN(Date.parse(a.createdAt)) ? a.createdAt : null,
            lastCommentedAt: f.lastCommentedAt,
            batch: batchAlert(a, dueAt, open),
          });
        }
        const look: DepsLook = { at, target: opsTargetKey(target), error: null, viewer: out.viewer, alerts: depsFindings };
        reconcileDepsDecisions(b, config, look, allRows, tickets, byFingerprint, clockAt);
        return look;
      } catch (error) {
        return { at, target: opsTargetKey(target), error: errorMessage(error), viewer: null, alerts: [] };
      }
    }

    // ---- adoption decisions ---------------------------------------------------------------------
    //
    // A ticket filed for a severity deps.autoAdopt does not name is nobody's
    // until the owner says so. The steward used to raise that as one decision
    // escalation from the filing thread, and when that thread was deleted the
    // question went with it (SC-111 sat six days in Backlog). Now the plugin
    // records the decision as durable state keyed by ticket, shows it as a
    // `decide` need on whichever binding watches the repository, reminds the
    // owner once the deadline (or a snooze) has passed, and resolves it when
    // the owner answers, the ticket is labelled, or the ticket closes.

    /** Whether a ticket's severity is one deps.autoAdopt names: such a ticket is adopted when filed and needs no decision. */
    const autoAdopted = (severity: string | null, config: ProjectConfig): boolean => severity !== null && (config.file.deps.autoAdopt as string[]).includes(severity);

    /** Whether the deps-alerts playbook's `may` list lets a steward dismiss an alert on GitHub. */
    const dismissAllowed = (config: ProjectConfig): boolean => config.depsAlerts?.may.includes("dismiss-alert") === true;

    /** The most severe of a ticket's alerts, for the decision's record. */
    function ticketSeverity(severities: ReadonlyArray<string | null>): string | null {
      const order = ["critical", "high", "medium", "low"];
      const known = severities.filter((x): x is string => x !== null).sort((a, b) => order.indexOf(a) - order.indexOf(b));
      return known[0] ?? null;
    }

    /** The earliest deadline among a ticket's alert rows: the SLA clock from each alert's own created_at. */
    function decisionDeadline(rows: ReadonlyArray<Fingerprint>, config: ProjectConfig, clockAt: (fingerprint: string, firstSeenAt: number) => number): number {
      return Math.min(...rows.map((r) => deadlineAt((r.severity ?? "medium") as DependabotSeverity, config.file.deps.sla, clockAt(r.fingerprint, r.firstSeenAt))));
    }

    /** The days past a deadline, in the project's time zone, or null when it has not passed. */
    function overdueDays(dueAt: number, config: ProjectConfig): number | null {
      const at = now();
      if (!overdue(dueAt, at, config.file.nightly.timezone)) return null;
      const today = Date.parse(`${dueDate(at, config.file.nightly.timezone)}T00:00:00Z`);
      const due = Date.parse(`${dueDate(dueAt, config.file.nightly.timezone)}T00:00:00Z`);
      return Math.max(1, Math.round((today - due) / 86_400_000));
    }

    /** The decide item an adoption decision shows as, filed on the binding that watches the repository now; an open one is reworded. */
    function fileAdoptionNeed(b: Binding, config: ProjectConfig, ticketKey: string, fingerprints: string[], alerts: ReadonlyArray<Pick<DependabotAlert, "severity" | "package" | "ecosystem" | "fixedVersion">>, ticket: TicketState, repo: string, dueAt: number, overdueBy: number | null): Need {
      const hasFix = alerts.length > 0 && alerts.some((a) => a.fixedVersion !== null);
      const allowDismiss = dismissAllowed(config);
      const due = dueDate(dueAt, config.file.nightly.timezone);
      return store.fileNeed({
        bindingId: b.id,
        kind: "decide",
        url: ticket?.url ?? ticketKey,
        what: adoptionQuestion(ticketKey, repo, alerts, due, overdueBy),
        how: adoptionHow(allowDismiss),
        data: { adoption: true, ticket: ticketKey, fingerprints, choices: adoptionChoices(hasFix, allowDismiss), dueDate: due },
        filedBy: "plugin",
      });
    }

    /**
     * Raise the adoption decision on a ticket, idempotently: the decision row
     * if it is new, and the decide item on this binding (reworded when it is
     * already open). Called from the steward's report the moment it files, and
     * from every look as the backfill for a ticket inherited by a recreated
     * binding, found by the dedup search, or filed by a thread that never
     * reported.
     */
    function raiseAdoption(b: Binding, config: ProjectConfig, ticketKey: string, rows: ReadonlyArray<Fingerprint>, alerts: ReadonlyArray<Pick<DependabotAlert, "severity" | "package" | "ecosystem" | "fixedVersion">>, ticket: TicketState, dueAt: number, overdueBy: number | null = null): Need | null {
      const repo = parseOpsTargetKey(b.entityId);
      if (repo === null || repo.kind !== "dependabot") return null;
      const fingerprints = rows.map((r) => r.fingerprint);
      const { decision, raised } = store.raiseDepsDecision({ projectId: b.projectId, ticketKey, entityId: b.entityId, fingerprints, severity: ticketSeverity(rows.map((r) => r.severity)), raisedBy: b.threadId, needId: null });
      if (decision.status !== "pending") return null;
      // The item from an earlier binding (recreated, rebound) is closed, not
      // left open and invisible on an ended binding: the one filed here is
      // the live question.
      if (decision.needId !== null) {
        const earlier = store.need(decision.needId);
        if (earlier !== null && earlier.status === "open" && earlier.bindingId !== b.id) store.closeNeed(earlier.id, `Moved to ${b.id}, which watches the repository now.`, "plugin");
      }
      const need = fileAdoptionNeed(b, config, ticketKey, fingerprints, alerts, ticket, repo.repo, dueAt, overdueBy);
      if (decision.needId !== need.id || decision.fingerprints.length !== fingerprints.length || decision.entityId !== b.entityId) store.patchDepsDecision(b.projectId, ticketKey, { needId: need.id, fingerprints, entityId: b.entityId });
      if (raised) bb.log.info(`stewards: raised the adoption decision on ${ticketKey} for ${b.entityKey}`);
      return need;
    }

    /** Settle a pending decision with how it was settled and close its item. */
    function settleAdoption(b: Binding, decision: DepsDecision, resolution: string): void {
      if (!store.resolveDepsDecision(b.projectId, decision.ticketKey, resolution)) return;
      if (decision.needId !== null) {
        const need = store.need(decision.needId);
        if (need !== null && need.status === "open") store.closeNeed(need.id, resolution, "plugin");
      }
    }

    /**
     * Every look: raise the decision for each unadopted ticket in the map that
     * has none, re-file the item on this binding when it was on an earlier
     * one, settle a decision the owner has answered, the ticket has been
     * labelled for, or whose ticket closed, re-raise a snoozed decision when
     * its date arrives, and send the one overdue reminder. The reminder
     * rewords the item and adds a note to the project steward's next wake (so
     * the digest's "needs you" names the deadline); it is recorded once. Only
     * tickets the look could read are judged: an unreadable ticket keeps
     * whatever state the decision had.
     */
    function reconcileDepsDecisions(b: Binding, config: ProjectConfig, look: DepsLook, rows: ReadonlyArray<Fingerprint>, tickets: ReadonlyMap<string, TicketState>, alerts: ReadonlyMap<string, DependabotAlert>, clockAt: (fingerprint: string, firstSeenAt: number) => number): void {
      const byTicket = new Map<string, Fingerprint[]>();
      for (const r of rows) {
        if (r.ticketKey === null) continue;
        const list = byTicket.get(r.ticketKey) ?? [];
        list.push(r);
        byTicket.set(r.ticketKey, list);
      }
      const label = lc(config.file.label);
      for (const [ticketKey, ticketRows] of byTicket) {
        const ticket = tickets.get(ticketKey) ?? null;
        const decision = store.depsDecision(b.projectId, ticketKey);
        const ticketAlerts = ticketRows.map((r) => alerts.get(r.fingerprint)).filter((a): a is DependabotAlert => a !== undefined);
        // A ticket whose state could not be read is left as it is: neither
        // raised (it may be adopted) nor settled (it may still be open).
        if (ticket === null) continue;
        const closed = ticketResolved(ticket);
        const labelled = (ticket.labels ?? []).some((l) => lc(l) === label);
        if (decision !== null && decision.status === "pending") {
          const need = decision.needId === null ? null : store.need(decision.needId);
          if (closed) {
            settleAdoption(b, decision, `${ticketKey} was closed (${ticket.state}).`);
            continue;
          }
          if (labelled) {
            settleAdoption(b, decision, `${ticketKey} was adopted (labelled ${config.file.label}).`);
            continue;
          }
          // The owner answered on the Stewards page or with `bb stewards done`.
          // Only that answer snoozes a decision; the plugin never snoozes or
          // dismisses on a steward's word.
          if (need !== null && need.status === "done") {
            const resolution = need.resolution ?? "Answered.";
            if (resolution.startsWith(`Chose: ${ADOPTION_CHOICES.keep}`)) {
              if (decision.snoozedUntil === null) {
                const until = snoozeUntil(resolution, decision.severity as DependabotSeverity | null, config.file.deps.sla, now());
                store.patchDepsDecision(b.projectId, ticketKey, { snoozedUntil: until, reminded: [] });
                store.note(b.id, `${ticketKey} is snoozed until ${dueDate(until, config.file.nightly.timezone)}; the plugin asks again then.`, true);
              }
            } else {
              settleAdoption(b, decision, resolution);
              continue;
            }
          }
          const current = store.depsDecision(b.projectId, ticketKey)!;
          // A snoozed decision is quiet until its date arrives; then the item
          // is re-filed and the reminder clock runs from the snooze date.
          const snoozeEnded = current.snoozedUntil !== null && current.snoozedUntil <= now();
          if (current.snoozedUntil !== null && !snoozeEnded) continue;
          const dueAt = current.snoozedUntil ?? decisionDeadline(ticketRows, config, clockAt);
          if (snoozeEnded) store.patchDepsDecision(b.projectId, ticketKey, { snoozedUntil: null, reminded: [] });
          const days = overdueDays(dueAt, config);
          raiseAdoption(b, config, ticketKey, ticketRows, ticketAlerts, ticket, dueAt, days);
          const after = store.depsDecision(b.projectId, ticketKey)!;
          if (days === null || after.reminded.includes("overdue")) continue;
          const text = reminderText(ticketKey, dueDate(dueAt, config.file.nightly.timezone), now(), config.file.nightly.timezone);
          store.patchDepsDecision(b.projectId, ticketKey, { reminded: [...after.reminded, "overdue"] });
          const latest = store.depsDecision(b.projectId, ticketKey);
          store.noteProject(b.projectId, `${text} The decision is ${latest?.needId ?? "on the Stewards page"} (${b.entityKey}); it is the owner's to answer, so it belongs under "needs you" in the digest, not in a plan to raise it later.`);
          store.note(b.id, text, true);
          continue;
        }
        if (decision !== null) continue;
        // No decision yet: an open, unlabelled ticket for a severity
        // deps.autoAdopt does not name needs one, whoever filed it and whenever.
        if (closed || labelled) continue;
        if (ticketRows.every((r) => autoAdopted(r.severity, config))) continue;
        const dueAt = decisionDeadline(ticketRows, config, clockAt);
        raiseAdoption(b, config, ticketKey, ticketRows, ticketAlerts, ticket, dueAt, overdueDays(dueAt, config));
      }
    }

    /** What changed between two dependency looks, as the mechanical tier weighs it. */
    function depsChanges(before: DepsLook | null, after: DepsLook, ticketFor: (fingerprint: string) => string | null): Change[] {
      if (after.error !== null) return before === null || before.error === null ? [{ text: `Cannot read ${after.target}: ${after.error}`, actionable: false }] : [];
      const changes: Change[] = [];
      if (before !== null && before.error !== null) changes.push({ text: `${after.target} is readable again`, actionable: false });
      const was = new Map((before?.alerts ?? []).map((a) => [a.fingerprint, a]));
      for (const a of after.alerts) {
        const prev = was.get(a.fingerprint);
        if (a.class === "new" && (prev === undefined || prev.class !== "new")) changes.push({ text: `New alert: ${a.fingerprint} — ${a.summary}`, actionable: true });
        else if (a.class === "returned" && prev?.class !== "returned") changes.push({ text: `Back after ${a.ticket} was resolved (${a.ticketState ?? "closed"}): ${a.fingerprint}`, actionable: true });
        else if (a.class === "recurring" && prev === undefined) changes.push({ text: `Seen again under ${a.ticket}: ${a.fingerprint}`, actionable: false });
      }
      const current = new Set(after.alerts.map((a) => a.fingerprint));
      for (const a of was.values()) {
        if (current.has(a.fingerprint)) continue;
        const ticket = a.ticket ?? ticketFor(a.fingerprint);
        changes.push({ text: `No longer open: ${a.fingerprint}${ticket === null ? "" : ` (${ticket})`}`, actionable: true });
      }
      return changes;
    }

    async function reconcileOps(b: Binding, config: ProjectConfig, playbook: Playbook, force: WakeReason | null): Promise<void> {
      if (b.endedAt !== null || b.ending !== null) return;
      const target = parseOpsTargetKey(b.entityId);
      // A target no longer listed is ended by the sweep.
      if (target === null || !allOpsTargets(config).some((t) => opsTargetKey(t) === b.entityId)) return;
      if (target.kind === "dependabot") {
        await reconcileDeps(b, config, playbook, target, force);
        return;
      }
      if (target.kind === "sentry-project") {
        await reconcileSentry(b, config, playbook, target, force);
        return;
      }
      const before = b.opsLook;
      const look = await lookAt(b, config, target, playbook);
      const requeueCame = b.requeueAt !== null && b.requeueAt <= now();
      // The next look is due a requeue from now, whether or not this one wakes anyone.
      const requeueAt = requeueCame || b.requeueAt === null ? now() + playbook.requeueDefaultMs : b.requeueAt;
      b = store.patch(b.id, { opsLook: look, requeueAt });
      if (look.error !== null) {
        // Nothing to wake the steward with until kubectl can read the target; `bb stewards check` says why.
        if (before?.error !== look.error) bb.log.warn(`stewards: cannot read ${b.entityKey}: ${look.error}`);
        return;
      }

      const changes = lookChanges(before, look);
      if (requeueCame) changes.push({ text: look.findings.length > 0 ? "Requeue time came, with problems still failing" : "Requeue time came: a scheduled look", actionable: true });
      if (b.playbookVersion !== playbook.version) changes.push({ text: `Playbook ${playbook.name} updated (${b.playbookVersion} → ${playbook.version})`, actionable: false });
      const queued = b.pending;
      const loudQueued = queued.filter((n) => n.quiet !== true).length;
      for (const n of queued) {
        const same = changes.find((c) => c.text === n.text);
        if (same !== undefined) same.actionable ||= n.quiet !== true;
        else changes.push({ text: n.text, actionable: n.quiet !== true });
      }
      b = store.patch(b.id, { playbookVersion: playbook.version });
      const keep = () => {
        for (const c of changes) if (!queued.some((n) => n.text === c.text && (n.quiet === true) === !c.actionable)) store.note(b.id, c.text, !c.actionable);
      };
      // A steward that has never been woken is due its first turn as soon as the target can be read.
      const reason = force ?? (b.threadId === null ? "adopted" : null);
      if (reason === null && !changes.some((c) => c.actionable)) {
        keep();
        return;
      }
      const deferred = (await settings.get()).paused || (b.hold !== null && reason === null && loudQueued === 0);
      const info = b.threadId === null ? null : await threadInfo(b.threadId);
      if (deferred || (info !== null && busy(info.status))) {
        keep();
        if (reason !== null && reason !== "changed" && reason !== "adopted") store.note(b.id, `Due: ${reason}`);
        return;
      }
      const text = formatOpsWake({
        reason: reason ?? (requeueCame && loudQueued === 0 ? "requeue" : "changed"),
        binding: b,
        playbook,
        look,
        target: filingTargetFor(config),
        label: config.file.label,
        owner: filingLogin(filingTargetFor(config), config),
        autoAdopt: config.role?.ops?.autoAdopt ?? [],
        escalations: store.openEscalations(b.id),
        changes: [...new Set(changes.map((c) => c.text))],
      });
      const delivery = await deliverWake(b, config, playbook, text);
      if (delivery === false) return;
      store.patch(b.id, { awaitingReport: true, wokeAt: now(), lastJudgmentAt: now(), lastWakeReason: reason, pending: [], archiveWhenIdle: false, requeueAt: now() + playbook.requeueDefaultMs });
      noteRespawn(b, delivery.respawned);
      // The steward now has the workers' reports: archive the finished ones (BB-47).
      await archiveFinishedWorkers(store.binding(b.id) ?? b);
    }

    /** The same turn for a Dependabot alert target: re-list the open alerts and wake on what changed. */
    async function reconcileDeps(b: Binding, config: ProjectConfig, playbook: Playbook, target: DependabotTarget, force: WakeReason | null): Promise<void> {
      const before = b.depsLook;
      const look = await lookAtDeps(b, config, target);
      const requeueCame = b.requeueAt !== null && b.requeueAt <= now();
      const requeueAt = requeueCame || b.requeueAt === null ? now() + playbook.requeueDefaultMs : b.requeueAt;
      b = store.patch(b.id, { depsLook: look, requeueAt });
      if (look.error !== null) {
        if (before?.error !== look.error) bb.log.warn(`stewards: cannot read ${b.entityKey}: ${look.error}`);
        return;
      }

      const changes = depsChanges(before, look, (fp) => store.fingerprint(b.projectId, fp)?.ticketKey ?? null);
      if (requeueCame) changes.push({ text: look.alerts.length > 0 ? "Requeue time came, with alerts still open" : "Requeue time came: a scheduled look", actionable: true });
      if (b.playbookVersion !== playbook.version) changes.push({ text: `Playbook ${playbook.name} updated (${b.playbookVersion} → ${playbook.version})`, actionable: false });
      const queued = b.pending;
      const loudQueued = queued.filter((n) => n.quiet !== true).length;
      for (const n of queued) {
        const same = changes.find((c) => c.text === n.text);
        if (same !== undefined) same.actionable ||= n.quiet !== true;
        else changes.push({ text: n.text, actionable: n.quiet !== true });
      }
      b = store.patch(b.id, { playbookVersion: playbook.version });
      const keep = () => {
        for (const c of changes) if (!queued.some((n) => n.text === c.text && (n.quiet === true) === !c.actionable)) store.note(b.id, c.text, !c.actionable);
      };
      const reason = force ?? (b.threadId === null ? "adopted" : null);
      if (reason === null && !changes.some((c) => c.actionable)) {
        keep();
        return;
      }
      const deferred = (await settings.get()).paused || (b.hold !== null && reason === null && loudQueued === 0);
      const info = b.threadId === null ? null : await threadInfo(b.threadId);
      if (deferred || (info !== null && busy(info.status))) {
        keep();
        if (reason !== null && reason !== "changed" && reason !== "adopted") store.note(b.id, `Due: ${reason}`);
        return;
      }
      const text = formatDepsWake({
        reason: reason ?? (requeueCame && loudQueued === 0 ? "requeue" : "changed"),
        binding: b,
        playbook,
        look,
        target: filingTargetFor(config),
        label: config.file.label,
        owner: filingLogin(filingTargetFor(config), config),
        autoAdopt: config.file.deps.autoAdopt,
        timeZone: config.file.nightly.timezone,
        escalations: store.openEscalations(b.id),
        decisions: store.depsDecisions(b.projectId, b.entityId).filter((d) => d.status === "pending"),
        changes: [...new Set(changes.map((c) => c.text))],
      });
      const delivery = await deliverWake(b, config, playbook, text);
      if (delivery === false) return;
      store.patch(b.id, { awaitingReport: true, wokeAt: now(), lastJudgmentAt: now(), lastWakeReason: reason, pending: [], archiveWhenIdle: false, requeueAt: now() + playbook.requeueDefaultMs });
      noteRespawn(b, delivery.respawned);
      // The steward now has the workers' reports: archive the finished ones (BB-47).
      await archiveFinishedWorkers(store.binding(b.id) ?? b);
    }

    // ---- Sentry targets ----------------------------------------------------------------------------
    //
    // A sentry-project target is read with the plugin's own Sentry token (a
    // secret setting), not through a source plugin: there is no sentry plugin,
    // and the source contract has no use for one. bb-gate-hooks rings the
    // binding the moment Sentry sees a new issue or a regression (the loop
    // below holds a `project` lease per target and an `issue` lease per issue
    // with a ticket); the look at every sweep and requeue is the backstop
    // when hooks are down, listing what is new or regressed since the last
    // look. The Sentry issue id is the fingerprint.

    const sentryToken = async (): Promise<string | null> => {
      const value = (await settings.get()).sentryToken;
      const token = typeof value === "string" ? value.trim() : "";
      return token === "" ? null : token;
    };
    const sentryReader = async (): Promise<SentryReader> => {
      const value = (await settings.get()).sentryApiUrl;
      const apiUrl = typeof value === "string" && value.trim() !== "" ? value.trim() : SENTRY_API_URL;
      return createSentryReader(fetchImpl, { apiUrl, token: sentryToken });
    };
    /** Issue ids doorbells named since each binding's last look. */
    const sentryRung = new Map<string, Set<string>>();
    /** At most this many rung issues are read one by one when the list does not carry them. */
    const RUNG_PER_LOOK = 10;
    /** An issue with a ticket is leased while it was seen within this long. */
    const ISSUE_LEASE_WINDOW_MS = 30 * 86_400_000;

    const openSentryBindings = (): Array<{ binding: Binding; target: SentryTarget }> =>
      store
        .open()
        .filter((b) => b.kind === "ops")
        .flatMap((b) => {
          const target = parseOpsTargetKey(b.entityId);
          return target?.kind === "sentry-project" ? [{ binding: b, target }] : [];
        });

    /** One look at a Sentry project: the issues new, regressed, rung or still firing since the last look, classified against the fingerprint map. */
    async function lookAtSentry(b: Binding, config: ProjectConfig, target: SentryTarget, playbook: Playbook): Promise<SentryLook> {
      const at = now();
      const key = opsTargetKey(target);
      const since = b.sentryLook !== null && b.sentryLook.error === null ? b.sentryLook.at : at - playbook.requeueDefaultMs;
      const rung = sentryRung.get(b.id) ?? new Set<string>();
      const notes: string[] = [];
      try {
        const reader = await sentryReader();
        const issues = await reader.issues(target);
        const byId = new Set(issues.map((i) => i.id));
        // A rung issue the list does not carry (older activity, or more than a page away) is read by itself.
        for (const id of [...rung].filter((x) => !byId.has(x)).slice(0, RUNG_PER_LOOK)) {
          try {
            const issue = await reader.issue(id);
            // Gone (resolved, or not this token's to see), or another organization's project with the same slug.
            if (issue === null || (issue.project !== null && issue.project !== target.project) || !issueInOrg(issue, target.org)) continue;
            issues.push(issue);
          } catch (error) {
            notes.push(`Issue ${id}, which Sentry rang for, could not be read (${errorMessage(error)})`);
          }
        }
        const known = new Set(store.fingerprints(b.id).map((r) => r.fingerprint));
        const sightings = sentrySightings(issues, { since }, rung, known);
        sentryRung.delete(b.id);
        const rows = store.sight(
          b.projectId,
          b.id,
          sightings.map((s) => ({ fingerprint: s.fingerprint, summary: sentrySummary(s.issue) })),
        );
        const tickets = await ticketStates(filingTargetFor(config), [...rows.values()].map((r) => r.ticketKey).filter((k): k is string => k !== null));
        // The one write: with ops.sentry.resolveOnDone on, a mapped ticket
        // that is Done while its issue is still unresolved is resolved in
        // Sentry. Canceled and open tickets, and issues Sentry has already
        // resolved, are left alone. A 403 (the token lacks event:write) is
        // one note per look, and the rest of the look's resolves are skipped.
        const unresolvedById = new Map(issues.filter((i) => i.status === "unresolved").map((i) => [i.id, i]));
        if (config.role?.ops?.sentry?.resolveOnDone ?? false) {
          let refused = false;
          for (const t of sentryResolveTargets(rows.values(), tickets, new Set(unresolvedById.keys()))) {
            if (refused) break;
            const issue = unresolvedById.get(t.fingerprint)!;
            const resolved = await reader.resolve(t.fingerprint);
            if (resolved.ok) notes.push(`Resolved ${issue.shortId} in Sentry: ${t.ticket} is ${t.state}`);
            else if (resolved.status === 403) {
              notes.push(`Sentry refused to resolve ${issue.shortId} (403): the token is missing the event:write scope, so the rest of this look's resolves were skipped`);
              refused = true;
            } else notes.push(`Could not resolve ${issue.shortId} in Sentry (${resolved.error})`);
          }
        }
        const asSightings: Sighting[] = sightings.map((s) => ({ fingerprint: s.fingerprint, workload: s.issue.shortId, pods: [], container: null, signature: s.reasons[0] ?? "ongoing", summary: sentrySummary(s.issue), restarts: 0, events: [], logs: null, previous: false }));
        const classified = classify(asSightings, rows, tickets, at, filingLogin(filingTargetFor(config), config));
        const findings: SentryFinding[] = [];
        let eventsRead = 0;
        for (const [i, s] of sightings.entries()) {
          const c = classified[i]!;
          let event: SentryFinding["event"] = null;
          if (eventsRead < EVENTS_PER_LOOK) {
            eventsRead += 1;
            try {
              event = await reader.latestEvent(s.issue.id);
            } catch (error) {
              notes.push(`The latest event of ${s.issue.shortId} could not be read (${errorMessage(error)})`);
            }
          }
          const { issue } = s;
          findings.push({
            fingerprint: s.fingerprint,
            shortId: issue.shortId,
            title: issue.title,
            culprit: issue.culprit,
            permalink: issue.permalink,
            level: issue.level,
            substatus: issue.substatus,
            count: issue.count,
            userCount: issue.userCount,
            firstSeen: issue.firstSeen,
            lastSeen: issue.lastSeen,
            reasons: s.reasons,
            event,
            class: c.class,
            ticket: c.ticket,
            ticketState: c.ticketState,
            firstSeenAt: c.firstSeenAt,
            lastCommentedAt: c.lastCommentedAt,
          });
        }
        const covered = new Set(findings.map((f) => f.fingerprint));
        const unresolved = issues.filter((i) => i.status === "unresolved");
        const recent = unresolved.filter((i) => !covered.has(i.id)).slice(0, RECENT_PER_LOOK).map(recentLine);
        return { at, target: key, error: null, unresolved: unresolved.length, recent, notes, findings };
      } catch (error) {
        return emptySentryLook(at, key, errorMessage(error));
      }
    }

    /**
     * The same turn for a Sentry project: look, compare with the last look,
     * and wake on what changed. A look that fails for want of a token wakes
     * the steward once, so it files the provide-secret need; any other
     * failure is logged, and `bb stewards check` says why.
     */
    async function reconcileSentry(b: Binding, config: ProjectConfig, playbook: Playbook, target: SentryTarget, force: WakeReason | null): Promise<void> {
      const before = b.sentryLook;
      const look = await lookAtSentry(b, config, target, playbook);
      const requeueCame = b.requeueAt !== null && b.requeueAt <= now();
      const requeueAt = requeueCame || b.requeueAt === null ? now() + playbook.requeueDefaultMs : b.requeueAt;
      b = store.patch(b.id, { sentryLook: look, requeueAt });
      if (look.error !== null && before?.error !== look.error) bb.log.warn(`stewards: cannot read ${b.entityKey}: ${look.error}`);
      if (look.error !== null && look.error !== NO_TOKEN) return;

      const changes = sentryChanges(before, look, playbook.requeueDefaultMs);
      if (requeueCame && look.error === null) changes.push({ text: look.findings.length > 0 ? "Requeue time came, with issues to act on" : "Requeue time came: a scheduled look", actionable: true });
      if (b.playbookVersion !== playbook.version) changes.push({ text: `Playbook ${playbook.name} updated (${b.playbookVersion} → ${playbook.version})`, actionable: false });
      const queued = b.pending;
      const loudQueued = queued.filter((n) => n.quiet !== true).length;
      for (const n of queued) {
        const same = changes.find((c) => c.text === n.text);
        if (same !== undefined) same.actionable ||= n.quiet !== true;
        else changes.push({ text: n.text, actionable: n.quiet !== true });
      }
      b = store.patch(b.id, { playbookVersion: playbook.version });
      const keep = () => {
        for (const c of changes) if (!queued.some((n) => n.text === c.text && (n.quiet === true) === !c.actionable)) store.note(b.id, c.text, !c.actionable);
      };
      // A steward that has never been woken is due its first turn as soon as the project can be read, or the need for a token can be filed.
      const reason = force ?? (b.threadId === null ? "adopted" : null);
      if (reason === null && !changes.some((c) => c.actionable)) {
        keep();
        return;
      }
      const deferred = (await settings.get()).paused || (b.hold !== null && reason === null && loudQueued === 0);
      const info = b.threadId === null ? null : await threadInfo(b.threadId);
      if (deferred || (info !== null && busy(info.status))) {
        keep();
        if (reason !== null && reason !== "changed" && reason !== "adopted") store.note(b.id, `Due: ${reason}`);
        return;
      }
      const text = formatSentryWake({
        reason: reason ?? (requeueCame && loudQueued === 0 ? "requeue" : "changed"),
        binding: b,
        playbook,
        look,
        target: filingTargetFor(config),
        label: config.file.label,
        owner: filingLogin(filingTargetFor(config), config),
        autoAdopt: config.role?.ops?.autoAdopt ?? [],
        escalations: store.openEscalations(b.id),
        changes: [...new Set(changes.map((c) => c.text))],
      });
      const delivery = await deliverWake(b, config, playbook, text);
      if (delivery === false) return;
      store.patch(b.id, { awaitingReport: true, wokeAt: now(), lastJudgmentAt: now(), lastWakeReason: reason, pending: [], archiveWhenIdle: false, requeueAt: now() + playbook.requeueDefaultMs });
      noteRespawn(b, delivery.respawned);
      // The steward now has the workers' reports: archive the finished ones (BB-47).
      await archiveFinishedWorkers(store.binding(b.id) ?? b);
    }

    // The subscriber: one stream to bb-gate-hooks for the `sentry` source,
    // proven with the plugin's token (bb-gate/docs/hooks.md, "Sentry"). A
    // project lease is sent as org/slug and leased under the slug, which is
    // what a doorbell carries as its unit; an issue lease is the issue id.
    // Without BB_HOOKS_URL, or without a token, nothing is leased and the
    // sweeps carry the watch.
    const hooksUrl = env[HOOKS_URL_ENV]?.trim() ?? "";
    /** The leases bb-gate-hooks refused at the last renewal, by `<kind> <id>`, for `bb stewards check`. */
    let sentryRefused = new Map<string, string>();

    function sentryLeases(): Lease[] {
      const seen = new Set<string>();
      const out: Lease[] = [];
      const add = (kind: Lease["kind"], id: string) => {
        const k = `${kind} ${id}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ kind, id });
      };
      for (const c of configs.values()) {
        if (c.value === null || !c.value.enabled) continue;
        for (const t of roleSentryTargets(c.value.role)) add("project", `${t.org}/${t.project}`);
      }
      const recent = now() - ISSUE_LEASE_WINDOW_MS;
      for (const { binding } of openSentryBindings()) {
        for (const r of store.fingerprints(binding.id)) if (r.ticketKey !== null && r.lastSeenAt >= recent) add("issue", r.fingerprint);
      }
      return out;
    }

    /** A Sentry doorbell: the issue id, and the project slug when the service named one. Every binding it concerns looks. */
    function onSentryDoorbell(id: string, unit: string | null): void {
      for (const { binding, target } of openSentryBindings()) {
        const byUnit = unit !== null && unit === target.project;
        const byIssue = store.fingerprint(binding.projectId, id)?.bindingId === binding.id;
        if (!byUnit && !byIssue) continue;
        const rung = sentryRung.get(binding.id) ?? new Set<string>();
        rung.add(id);
        sentryRung.set(binding.id, rung);
        scheduleReconcile(binding.id);
      }
    }

    const sentryHooks = createHooksLoop({
      fetch: fetchImpl,
      baseUrl: hooksUrl,
      now,
      log: bb.log,
      token: sentryToken,
      watchIds: sentryLeases,
      onDoorbell: (kind, id, unit) => {
        if (kind === "issue") onSentryDoorbell(id, unit);
      },
      async onRejected(rejected: Rejection[]) {
        sentryRefused = new Map(rejected.map((r) => [`${r.kind} ${r.id}`, r.reason]));
        for (const r of rejected) bb.log.warn(`stewards: bb-gate-hooks refused a Sentry ${r.kind} lease on ${r.id} (${r.reason}); only the periodic look sees it`);
      },
      async sweep() {
        // Coverage cannot be proven: every Sentry binding looks for itself.
        for (const { binding } of openSentryBindings()) scheduleReconcile(binding.id);
      },
    });
    const sentryWanted = () => [...configs.values()].some((c) => c.value !== null && c.value.enabled && roleSentryTargets(c.value.role).length > 0);

    /**
     * One ops binding per configured target. A target taken out of the
     * project file ends its binding; put back, the same binding and thread
     * resume. One detached by hand stays ended while its target is listed,
     * as a ticket stays detached while it keeps its label. The Dependabot
     * targets come from the project's repos (or its explicit dependabot
     * targets) and run the deps-alerts playbook.
     */
    async function syncOpsBindings(config: ProjectConfig): Promise<void> {
      const wanted = new Map<string, { target: OpsTarget; playbook: Playbook }>();
      const opsPlaybook = playbookFor(config, "ops");
      if (opsPlaybook !== null) for (const target of roleOpsTargets(config.role)) wanted.set(opsTargetKey(target), { target, playbook: opsPlaybook });
      if (config.depsAlerts !== null) for (const target of roleDepsTargets(config.role, config.repos)) wanted.set(opsTargetKey(target), { target, playbook: config.depsAlerts });
      const existing = store.all(config.projectId).filter((b) => b.kind === "ops");
      for (const b of existing) {
        if (wanted.has(b.entityId)) continue;
        if (b.endedAt === null) {
          await serial(`b:${b.id}`, async () => {
            const fresh = store.binding(b.id);
            if (fresh !== null && fresh.endedAt === null) await finishEnding(fresh, "unconfigured");
          });
        } else if (b.manualDetach) store.patch(b.id, { manualDetach: false });
      }
      if ((await settings.get()).paused) return;
      for (const [key, { target, playbook }] of wanted) {
        const b = existing.find((x) => x.entityId === key);
        if (b === undefined) {
          let created: Binding;
          const title = target.kind === "k8s-namespace" ? `Ops watch: ${target.name}` : target.kind === "dependabot" ? `Deps watch: ${target.repo}` : `Sentry watch: ${target.org}/${target.project}`;
          try {
            created = store.create({ projectId: config.projectId, source: "ops", entityId: key, entityKey: key, url: null, title, kind: "ops", playbook: playbook.name, playbookVersion: playbook.version, parentBindingId: null, phase: "watching", stage: null });
          } catch {
            continue; // made concurrently
          }
          bb.log.info(`stewards: watching ${key} with an ops binding (${playbook.name})`);
          // A Sentry project is leased as soon as it is watched; the next renewal would otherwise be up to half a lease away.
          if (target.kind === "sentry-project") sentryHooks.added("project", `${target.org}/${target.project}`).catch((error: unknown) => bb.log.warn(`stewards: could not lease ${key} right away: ${errorMessage(error)}`));
          await serial(`b:${created.id}`, () => reconcileBinding(created.id, "adopted"));
        } else if (b.endedAt !== null && !b.manualDetach) {
          await serial(`b:${b.id}`, async () => {
            const fresh = store.binding(b.id);
            if (fresh === null || fresh.endedAt === null) return;
            await reopen(fresh, `${key} is configured again`);
            await reconcileBinding(b.id, "reopen");
          });
        }
      }
    }

    // ---- lifecycle -------------------------------------------------------------------------------

    async function stopWorkers(b: Binding): Promise<void> {
      for (const w of store.workers(b.id)) {
        if (!workerInFlight(w)) continue;
        store.setWorker(w.threadId, "stopped", w.result, "stopped");
        await quietly(`stop worker ${w.threadId}`, () => bb.sdk.threads.stop({ threadId: w.threadId }));
      }
    }

    /**
     * How long after a worker's turn a terminal-state report in its final
     * message still counts as it having set the state (BB-52 rule 4). A stale
     * report from an earlier Done does not suppress a later one.
     */
    const TERMINAL_WORKER_REPORT_MS = 15 * 60_000;

    /**
     * The one wrap-up (terminal) or stop (detach, disabled, reassigned) turn
     * before the binding ends. A detach stops the workers now: someone took
     * the label off; a reassignment or an unassignment releases the binding
     * the same way. A terminal state leaves them running through the wrap-up
     * turn, in which the steward may keep the binding open to follow through
     * (a deploy to watch, production to verify); they are stopped when it
     * ends.
     */
    async function beginEnding(b: Binding, config: ProjectConfig, playbook: Playbook, kind: "terminal" | "detach" | "disabled" | "reassigned", observed: Observed): Promise<void> {
      // BB-52 rule 4: the steward's own last report already named the terminal
      // state, or a worker's final message says it moved the entity there, so
      // the binding's own last turn set it and said the work is done. End from
      // the mechanical tier rather than waking for a wrap-up it has already
      // done. A terminal state set by anyone else leaves neither signal and
      // still wakes. The source contract carries no state-change actor, so
      // these two reports are the attribution the plugin has.
      const stewardDone = b.status !== null && isTerminal(playbook, b.status.phase);
      const workerDone =
        kind === "terminal" &&
        store.workers(b.id).some((w) => w.result !== null && (w.endedAt === null || now() - w.endedAt <= TERMINAL_WORKER_REPORT_MS) && workerReportedTerminal(w.result, observed.entity.key, playbook));
      const ownDone = kind === "terminal" && (stewardDone || workerDone);
      signalNeedActionability(b, observed);
      b = store.patch(b.id, { ending: kind, endingAt: now(), followThrough: null, followThroughUntil: null, lastSnapshot: observed, clearedToStart: false });
      // Whatever its work was holding back can go now: landed, canceled or no longer managed, it is not merging later.
      await releaseBehind(b, kind === "terminal" ? `reached ${observed.entity.state}` : kind === "disabled" ? "the project was switched off" : kind === "reassigned" ? "was reassigned away from this server" : "was detached");
      if (kind !== "terminal") await stopWorkers(b);
      bb.log.info(`stewards: ${b.entityKey} ${kind === "terminal" ? `reached ${observed.entity.state}` : kind === "disabled" ? "is ending because its project was switched off" : kind === "reassigned" ? "was reassigned away from this server" : "was detached"}; one last turn`);
      if (b.threadId === null) {
        await finishEnding(b, kind);
        return;
      }
      const info = await threadInfo(b.threadId);
      if (info === null || info.deletedAt !== null) {
        await finishEnding(b, kind);
        return;
      }
      if (ownDone) {
        bb.log.info(`stewards: ${b.entityKey} was already reported done in its own last turn; ending without a wrap-up wake`);
        await finishEnding(b, "terminal");
        return;
      }
      await wake(b, config, playbook, observed, [kind === "terminal" ? `Terminal: ${observed.entity.state}` : kind === "disabled" ? "Stewards for this project were switched off on this server" : kind === "reassigned" ? `Reassigned: ${observed.entity.assignees.join(", ") || "no assignee"}` : `The ${config.file.label} label was removed`], kind);
    }

    /**
     * The stop turn for a binding whose project was switched off on this
     * server. An entity binding reuses its ordinary wake shape; an ops, deps
     * or Sentry binding has no entity snapshot, so it gets its own wake built
     * from the look it already holds. Either way the workers are stopped now
     * and the binding ends when the turn goes idle.
     */
    async function beginDisabledEnding(b: Binding, config: ProjectConfig, playbook: Playbook): Promise<void> {
      if (b.kind !== "ops" && b.lastSnapshot !== null) {
        await beginEnding(b, config, playbook, "disabled", b.lastSnapshot);
        return;
      }
      b = store.patch(b.id, { ending: "disabled", endingAt: now(), followThrough: null, followThroughUntil: null, clearedToStart: false });
      await releaseBehind(b, "the project was switched off");
      await stopWorkers(b);
      bb.log.info(`stewards: ${b.entityKey} is ending because its project was switched off; one stop turn`);
      if (b.threadId === null) {
        await finishEnding(b, "disabled");
        return;
      }
      const info = await threadInfo(b.threadId);
      if (info === null || info.deletedAt !== null) {
        await finishEnding(b, "disabled");
        return;
      }
      const delivery = await deliverWake(b, config, playbook, disabledOpsWake(b, config, playbook));
      if (delivery === false) return;
      // BB-154: the turn's reason, so a stale requeue cannot be counted by its report.
      store.patch(b.id, { awaitingReport: true, wokeAt: now(), lastJudgmentAt: now(), lastWakeReason: "disabled", pending: [], archiveWhenIdle: false });
      noteRespawn(b, delivery.respawned);
    }

    /** The stop turn's text for an ops, deps or Sentry binding: its own wake with the look it last held. */
    function disabledOpsWake(b: Binding, config: ProjectConfig, playbook: Playbook): string {
      const changes = ["Stewards for this project were switched off on this server. This is your stop turn: take no new actions and start no workers."];
      const target = parseOpsTargetKey(b.entityId);
      const filing = roleOpsTeam(config.role, config.file);
      const owner = filingLogin(filing, config);
      const escalations = store.openEscalations(b.id);
      if (target?.kind === "dependabot" && b.depsLook !== null) {
        return formatDepsWake({ reason: "disabled", binding: b, playbook, look: b.depsLook, target: filing, label: config.file.label, owner, autoAdopt: config.file.deps.autoAdopt, timeZone: config.file.nightly.timezone, escalations, decisions: store.depsDecisions(b.projectId, b.entityId).filter((d) => d.status === "pending"), changes });
      }
      if (target?.kind === "sentry-project" && b.sentryLook !== null) {
        return formatSentryWake({ reason: "disabled", binding: b, playbook, look: b.sentryLook, target: filing, label: config.file.label, owner, autoAdopt: config.role?.ops?.autoAdopt ?? [], escalations, changes });
      }
      if (target?.kind === "k8s-namespace" && b.opsLook !== null) {
        return formatOpsWake({ reason: "disabled", binding: b, playbook, look: b.opsLook, target: filing, label: config.file.label, owner, autoAdopt: config.role?.ops?.autoAdopt ?? [], escalations, changes });
      }
      return `# ${b.entityKey}\n\nStewards for this project were switched off on this server. This is your stop turn: take no new actions on the target and start no workers; running workers have been stopped. End with steward_report, saying where things stand. Switching the project back on resumes this binding.`;
    }

    /**
     * End the binding, archive its thread, and hand its children to the next
     * ancestor. Its last turn said the work is done; workers are archived with
     * it, as their lifecycle owner. thread-briefs is asked not to archive
     * stewards, because between wakes a steward reads done while its entity
     * is still open. A thread still running (an ending that timed out) is left
     * in the sidebar rather than archived mid-turn.
     */
    async function finishEnding(b: Binding, reason: string): Promise<void> {
      b = store.patch(b.id, { ending: null, endingAt: null, followThrough: null, followThroughUntil: null, endedAt: now(), endReason: reason, awaitingReport: false, requeueAt: null });
      // Mechanical cleanup, not a decision: the origin binding has ended, so
      // resolve its escalations without queuing a wake it would never read
      // (BB-60).
      for (const x of store.openEscalations(b.id)) store.resolve(x.id, "The binding ended.", "plugin", false);
      await releaseBehind(b, `ended (${reason})`);
      await stopWorkers(b);
      const info = b.threadId === null ? null : await threadInfo(b.threadId).catch(() => null);
      if (info !== null && info.deletedAt === null && info.archivedAt === null) {
        if (busy(info.status)) {
          // Its wrap-up turn is still running (the ending came from another
          // idle, or timed out): the idle that ends that turn archives it.
          store.patch(b.id, { archiveWhenIdle: true });
          bb.log.info(`stewards: ${b.entityKey}'s steward is still in its last turn; archiving it when that ends`);
        } else {
          await quietly(`archive ${b.entityKey}'s steward`, () => bb.sdk.threads.archive({ threadId: info.id }));
        }
      }
      // Parent ends first: promoted children still open move up a level.
      const up = b.parentBindingId === null ? null : store.binding(b.parentBindingId);
      const next = up !== null && up.endedAt === null ? up : null;
      for (const child of store.children(b.id)) {
        store.patch(child.id, { parentBindingId: next?.id ?? null });
        store.note(child.id, `Your parent ${b.entityKey} ended (${reason}); you now report to ${next === null ? "the project steward" : next.entityKey}.`);
      }
      bb.log.info(`stewards: ${b.entityKey} ended (${reason})`);
      pushInterest();
    }

    async function reopen(b: Binding, why: string): Promise<Binding> {
      // The wake that follows brings the thread back if it was archived meanwhile.
      b = store.patch(b.id, { endedAt: null, endReason: null, ending: null, endingAt: null, followThrough: null, followThroughUntil: null, awaitingReport: false, missedReports: 0 });
      bb.log.info(`stewards: ${b.entityKey} resumed (${why})`);
      pushInterest();
      return store.note(b.id, why);
    }

    /**
     * BB-116: whether the per-project switch-off holds this binding and it is
     * due back now that the project is on. A binding whose stop turn is still
     * running (`ending === "disabled"`, not ended) is held; so is one the turn
     * already ended (`endReason === "disabled"`), unless it was detached by
     * hand. A binding that fully ended for any other reason is not.
     */
    const switchOffHeld = (b: Pick<Binding, "endedAt" | "ending" | "endReason" | "manualDetach">): boolean =>
      (b.endedAt === null && b.ending === "disabled") || (b.endedAt !== null && b.endReason === "disabled" && !b.manualDetach);

    /**
     * The playbook's cap on follow-through came before the steward said it
     * was done. The binding ends as any terminal one does, and the project
     * steward hears what was left, since nobody else will.
     */
    async function followThroughRanOut(b: Binding): Promise<void> {
      const what = b.followThrough ?? "(not said)";
      const stopped = store.workers(b.id).filter((w) => w.status === "running").map((w) => w.title);
      bb.log.warn(`stewards: ${b.entityKey}'s follow-through ran out (${what})`);
      await finishEnding(b, "terminal");
      await wakeProject(b.projectId, `follow-through ran out on ${b.entityKey}`, {
        digestDue: false,
        notes: [
          `${b.entityKey} reached a terminal state and its steward kept it open to follow through: ${JSON.stringify(what)}. That ran out before the steward said it was done, so the binding ended${stopped.length > 0 ? ` and these workers were stopped: ${stopped.join("; ")}` : ""}.`,
          "Decide from the project's guidance whether the work needs finishing. Reopening the entity resumes its steward; do not do a steward's work yourself.",
        ],
      });
    }

    // ---- adoption ------------------------------------------------------------------------------

    const projectFor = (configs: ProjectConfig[], entity: Pick<EntitySnapshot, "source" | "unit">) =>
      configs.find((c) => (entity.source === "linear" ? c.file.linear.teams.includes(entity.unit.toUpperCase()) : c.repos.some((r) => lc(r) === lc(entity.unit)))) ?? null;

    /** Whether one glob (or the bot logins on the synthesized watch) matches a value, ignoring case. */
    function watchPatternMatches(pattern: string | string[], value: string): boolean {
      const patterns = Array.isArray(pattern) ? pattern : [pattern];
      return patterns.some((p) => globMatches(lc(p), lc(value)));
    }

    /**
     * The first pull watch a pull request matches, or null (BB-164). The
     * synthesized Dependabot watches come first, then the role's declared
     * ones, so first match wins. A watch with no `match.author` matches only a
     * pull request authored by the role holder's own GitHub login; any other
     * author must be named. `title`, `branch` and `author` are checked when the
     * caller has them (the full snapshot; the nightly list carries only repo
     * and author); `paths` only on the full snapshot, where a pull request with
     * 100 or more changed files never matches (fail closed: GitHub lists the
     * first 100 only).
     */
    function matchPullWatch(config: ProjectConfig, e: { unit: string; title?: string | null; branch?: string | null; author: string | null; files?: string[] }): PullWatch | null {
      for (const watch of rolePullWatches(config.role, config.repos, depsPrsPlaybookName(config.file))) {
        if (lc(watch.repo) !== lc(e.unit)) continue;
        const m = watch.match;
        if (m.title !== undefined && e.title !== undefined && (e.title === null || !watchPatternMatches(m.title, e.title))) continue;
        if (m.branch !== undefined && e.branch !== undefined && (e.branch === null || !watchPatternMatches(m.branch, e.branch))) continue;
        if (m.author !== undefined) {
          if (e.author === null || !watchPatternMatches(m.author, e.author)) continue;
        } else if (e.author === null || config.githubLogin === null || lc(e.author) !== lc(config.githubLogin)) continue;
        if (m.paths !== undefined && e.files !== undefined) {
          if (e.files.length === 0 || e.files.length >= 100) continue;
          if (!e.files.every((f) => m.paths!.some((p) => globMatches(p, f)))) continue;
        }
        return watch;
      }
      return null;
    }

    /** The playbook a matched pull watch runs under, or null when it is not readable. */
    function pullWatchPlaybook(config: ProjectConfig, watch: PullWatch): Playbook | null {
      return playbookForWatchName(config, watch.playbook);
    }

    /**
     * The first ticket watch a labelled, assigned issue matches, or null
     * (BB-246). `labels` means every named label is present, ignoring case;
     * `title` is a glob in the decide list's dialect. First match wins. The
     * caller has already checked the adoption label and the assignee.
     */
    function matchTicketWatch(config: ProjectConfig, e: { labels: string[]; title?: string | null }): TicketWatch | null {
      for (const watch of config.file.tickets) {
        const m = watch.match;
        if (m.labels !== undefined && !m.labels.every((name) => e.labels.some((l) => lc(l) === lc(name)))) continue;
        if (m.title !== undefined && (e.title === undefined || e.title === null || !watchPatternMatches(m.title, e.title))) continue;
        return watch;
      }
      return null;
    }

    /**
     * Which kind of binding an entity wants in this project, or null for none.
     * `assignees`, `requestedReviewers`, `title`, `branch` and `files` are
     * absent on the nightly pass's list, which is permissive: `maybeAdopt`
     * re-checks with the full snapshot. The pull watches run first, then the
     * labelled-author path, then the review path (BB-164).
     *
     * Adoption follows one human-set owner per kind of work (BB-115): a ticket
     * is this server's when its Linear login is an assignee, a labelled pull
     * request when its GitHub login is the author, and a teammate's review only
     * where its GitHub login is a requested reviewer. A pull request matching a
     * role's watch is adopted under that watch's playbook on that holder's
     * server only, with no label. The rule is the same with or without a
     * roles.json project steward; a login that cannot be read adopts nothing.
     */
    function adoptionKind(
      config: ProjectConfig,
      e: { source: Source; kind: "issue" | "pull"; state: string; labels: string[]; author: string | null; draft: boolean; unit: string; title?: string | null; branch?: string | null; files?: string[]; assignees?: string[]; requestedReviewers?: string[] },
      viewer: string | null,
    ): BindingKind | null {
      const labelled = e.labels.some((l) => lc(l) === lc(config.file.label));
      if (e.source === "linear") {
        const playbook = playbookFor(config, "ticket", "linear");
        if (!labelled || playbook === null || isTerminal(playbook, e.state)) return null;
        // A login that cannot be read adopts nothing (BB-115, addendum 2).
        if (config.rolesUnreadable) return null;
        // The Linear assignee is the owner. A ticket assigned to another login,
        // or to nobody, is adopted nowhere here; the new assignee's server
        // picks it up on the doorbell or the next sweep. `assignees` is absent
        // on the nightly list, so `maybeAdopt` re-checks the full snapshot.
        if (e.assignees !== undefined) {
          const mine = config.linearLogin !== null && e.assignees.some((a) => lc(a) === lc(config.linearLogin));
          if (!mine) return null;
        }
        return "ticket";
      }
      if (e.source === "github" && e.kind === "issue") {
        // A labelled GitHub issue in a listed repo, assigned to this server's
        // GitHub login, is a ticket too (BB-234). The same ownership rule as
        // Linear: another assignee, or nobody, is adopted nowhere. The
        // nightly list lacks assignees, so `maybeAdopt` re-checks the full
        // snapshot; an unreadable githubLogin adopts nothing (BB-115).
        const playbook = playbookFor(config, "ticket", "github");
        if (!labelled || playbook === null || isTerminal(playbook, e.state)) return null;
        if (config.githubLogin === null) return null;
        if (e.assignees !== undefined) {
          const mine = e.assignees.some((a) => lc(a) === lc(config.githubLogin));
          if (!mine) return null;
        }
        return "ticket";
      }
      if (e.kind !== "pull") return null;
      // A login that cannot be read adopts nothing (BB-115, addendum 2).
      if (config.rolesUnreadable) return null;
      // A role's pull watches run before the label and review paths, first
      // match wins: the synthesized Dependabot watch first, then the declared
      // watches, so a bot PR a human labelled `bb-managed` keeps its watch's
      // steward rather than being adopted nowhere (BB-164).
      if (matchPullWatch(config, e) !== null) return "pr";
      // A labelled pull request is this server's own work only when its author
      // is this server's GitHub login; another author's is handled on the
      // author's server. An unlabelled pull request of my own falls through to
      // the review path and is ignored there.
      if (labelled) {
        const playbook = playbookFor(config, "pr");
        if (playbook === null || isTerminal(playbook, e.state)) return null;
        if (e.author === null || config.githubLogin === null || lc(e.author) !== lc(config.githubLogin)) return null;
        return "pr";
      }
      const review = playbookFor(config, "review");
      if (review === null || !config.file.reviews.enabled || e.draft || e.state !== "open") return null;
      if (e.author === null || viewer === null || lc(e.author) === lc(viewer)) return null;
      if (review.skipAuthors.some((a) => lc(a) === lc(e.author))) return null;
      // A review steward is made only where this server's GitHub login is a
      // requested reviewer, checked once, at adoption; the binding survives
      // GitHub dropping the reviewer until the pull request is merged or
      // closed. `requestedReviewers` is absent on the nightly list, so
      // `maybeAdopt` re-checks the full snapshot.
      if (e.requestedReviewers !== undefined && (config.githubLogin === null || !e.requestedReviewers.some((r) => lc(r) === lc(config.githubLogin)))) return null;
      return "review";
    }

    /** Whether a GitHub parent key ("owner/repo#N") is in the project's repo set, ignoring case (BB-244). */
    function parentInRepoSet(config: ProjectConfig, key: string): boolean {
      const repo = key.split("#")[0] ?? "";
      return config.repos.some((r) => lc(r) === lc(repo));
    }

    /**
     * The nearest bound ancestor of an issue, walking up a few parents, on
     * either source. An unread relation is not "no parent": it leaves the
     * binding's nesting alone. On GitHub the walk stays inside the project's
     * repo set, compared ignoring case; a parent in another repository counts
     * as unmanaged and is not read (BB-244).
     */
    async function managedAncestor(entity: EntitySnapshot, config: ProjectConfig): Promise<Binding | null> {
      if (entity.relationsUnread === true) return null;
      let parent = entity.parent;
      for (let depth = 0; parent !== null && depth < 5; depth++) {
        if (entity.source === "github" && !parentInRepoSet(config, parent.key)) return null;
        const bound = store.byEntity(entity.source, parent.id);
        if (bound !== null && bound.endedAt === null) return bound;
        const snap = await snapshot(entity.source, parent.id).catch(() => null);
        parent = snap?.parent ?? null;
      }
      return null;
    }

    /** Adopt an entity if it should be. Returns the new binding, or null. */
    async function maybeAdopt(entity: EntitySnapshot, projects: ProjectConfig[]): Promise<Binding | null> {
      if ((await settings.get()).paused) return null;
      const config = projectFor(projects, entity);
      if (config === null) return null;
      if (store.byEntity(entity.source, entity.id) !== null) return null;
      const full = { ...entity, draft: entity.pull?.draft ?? false, requestedReviewers: entity.pull?.requestedReviewers ?? [], title: entity.title, branch: entity.pull?.head ?? null, files: entity.pull?.files };
      const kind = adoptionKind(config, full, entity.viewer);
      if (kind === null) return null;
      // BB-246: once adoption says ticket, a ticket watch (if any) chooses the
      // playbook; the pull watches only apply to a pull request.
      const ticketWatch = kind === "ticket" ? matchTicketWatch(config, entity) : null;
      const watch = kind === "pr" ? matchPullWatch(config, { unit: entity.unit, title: entity.title, branch: entity.pull?.head ?? null, author: entity.author, files: entity.pull?.files }) : null;
      const playbook = ticketWatch !== null ? ticketWatchPlaybook(config, ticketWatch.playbook) : watch !== null ? pullWatchPlaybook(config, watch) : playbookFor(config, kind, entity.source);
      if (playbook === null) return null;
      // Both sources nest: a GitHub issue with a managed parent gets its
      // `parentBindingId` like a Linear one (BB-244).
      const parent = kind === "ticket" ? await managedAncestor(entity, config) : null;
      const { phase, stage } = phaseAndStage(playbook, entity.state, entity.labels);
      let b: Binding;
      try {
        b = store.create({
          projectId: config.projectId,
          source: entity.source,
          entityId: entity.id,
          entityKey: entity.key,
          url: entity.url,
          title: entity.title,
          kind,
          playbook: playbook.name,
          playbookVersion: playbook.version,
          adoptedBy: ticketWatch !== null ? ticketWatchId(ticketWatch) : watch === null ? null : pullWatchId(watch),
          parentBindingId: parent?.id ?? null,
          phase,
          stage,
        });
      } catch {
        return null; // adopted concurrently
      }
      bb.log.info(`stewards: adopted ${entity.key} as a ${kind} binding (${playbook.name})`);
      if (parent !== null) {
        store.note(parent.id, `Sub-issue ${entity.key} was promoted and has its own steward now.`);
        scheduleReconcile(parent.id);
      }
      await serial(`b:${b.id}`, () => reconcileBinding(b.id, "adopted"));
      pushInterest();
      return b;
    }

    /**
     * A GitHub Deployment doorbell (BB-53). The entity id is
     * "owner/repo#<deployment id>" and the deployment object carries the
     * environment and state. Every open binding whose playbook names that repo
     * and environment as a deployment target and is awaiting one hears it; the
     * plugin evaluates a structured carries rule itself (BB-132) and wakes the
     * steward only when the verdict settles a watch or is the first
     * undecidable one (BB-204).
     */
    async function onDeploymentDoorbell(id: string, deployment: Deployment): Promise<void> {
      const hash = id.lastIndexOf("#");
      const repo = hash === -1 ? "" : id.slice(0, hash);
      if (repo === "") return;
      const state = deployment.state === "" ? "created" : deployment.state;
      const failed = state === "failure" || state === "error";
      const final = failed || state === "success";
      const projects = await stewardedProjects();
      for (const config of projects) {
        for (const open of store.open(config.projectId)) {
          // Serialize the per-binding work with a reconcile and re-read the
          // binding inside, so a report or a sweep that lands during a carries
          // read is not overwritten with the stale map (BB-204 review).
          await serial(`b:${open.id}`, async () => {
            let b = store.binding(open.id);
            if (b === null || b.endedAt !== null) return;
            const playbook = bindingPlaybook(config, b);
            if (playbook === null || playbook === undefined) return;
            for (const target of playbook.deployments) {
              if (lc(target.repo) !== lc(repo) || lc(target.environment) !== lc(deployment.environment)) continue;
              const watches = Object.values(b.deployments).filter((w) => lc(w.repo) === lc(target.repo) && lc(w.environment) === lc(target.environment) && w.state !== "deployed" && w.state !== "failed");
              if (watches.length === 0) continue;
              const line = `Deployment ${deployment.id} (${state}) for ${repo} ${target.environment}${deployment.url === null ? "" : ` — ${deployment.url}`}${typeof target.carries === "string" ? `; the playbook's rule: ${target.carries}` : ""}`;
              // A deployment that has not reached a final status has not
              // applied the image yet, so no watch can move: a quiet note
              // records it and no reconcile is scheduled (BB-204).
              if (!final) {
                b = store.note(b.id, line, true);
                continue;
              }
              const before = b.deployments;
              const applied = applyDeployment(before, target, deployment, now());
              const moved = Object.keys(applied.deployments).filter((wid) => before[wid] !== applied.deployments[wid]);
              if (moved.length === 0) continue;
              if (failed) {
                b = store.patch(b.id, { deployments: applied.deployments });
                b = store.note(b.id, line, false);
                bb.log.info(`stewards: deployment ${deployment.id} (${state}) on ${repo} ${target.environment} failed ${applied.changed.join(", ")}`);
                scheduleReconcile(b.id);
                continue;
              }
              // A success: evaluate the carries rule mechanically and wake
              // the steward only for a settled watch or the first undecidable
              // one.
              const evaluated = await evaluateAppliedDeployment(applied.deployments, before, target, moved, now());
              b = store.patch(b.id, { deployments: evaluated.deployments });
              // BB-203 regression: a doorbell settles the watch here, so the
              // reconcile that follows sees no edge and never writes the
              // deployed status. Write it at the settle instead.
              const settled = deploymentSettled(before, evaluated.deployments);
              if (settled !== null) b = patchMechanicalStatus(b, { kind: "deployed", ...settled });
              b = store.note(b.id, [line, ...evaluated.notes].join("; "), !evaluated.wake);
              if (evaluated.wake) {
                bb.log.info(`stewards: deployment ${deployment.id} (${state}) on ${repo} ${target.environment} concerns ${applied.changed.join(", ")}`);
                scheduleReconcile(b.id);
              }
            }
          });
        }
      }
    }

    /**
     * A GitHub `workflow_run` doorbell (BB-61). The entity id is
     * "owner/repo#<run id>" and the object carries the workflow, conclusion,
     * URL, head sha and attempt. A run of a workflow the playbook's
     * deployment target names wakes every binding on that repo awaiting a
     * deployment, once per (run id, attempt). The watch's state is not moved:
     * the plugin forwards the fact that a named workflow failed, and the
     * steward applies its playbook as for a timeout. The plugin assumes
     * nothing about images, tags or pins, and never matches the run's sha.
     */
    async function onWorkflowRunDoorbell(id: string, run: WorkflowRun, receivedAt: number): Promise<void> {
      const hash = id.lastIndexOf("#");
      const repo = hash === -1 ? "" : id.slice(0, hash);
      const runId = hash === -1 ? "" : id.slice(hash + 1);
      if (repo === "") return;
      const projects = await stewardedProjects();
      // The run's start is the same for every binding; read it back by run id
      // once (BB-132), only when a binding actually has an awaiting watch.
      let runStartedAt: number | null | undefined;
      const startedAt = async (): Promise<number | null> => {
        if (runStartedAt === undefined) runStartedAt = await readRunStartedAt(repo, run, runId);
        return runStartedAt;
      };
      for (const config of projects) {
        for (const b of store.open(config.projectId)) {
          const playbook = bindingPlaybook(config, b);
          if (playbook === null || playbook === undefined) continue;
          const targets = playbook.deployments.filter((t) => lc(t.repo) === lc(repo) && matchesWorkflow(t, run));
          if (targets.length === 0) continue;
          if (!Object.values(b.deployments).some((w) => (w.state === "merged" || w.state === "deploying") && lc(w.repo) === lc(repo))) continue;
          const applied = applyWorkflowRun(b.deployments, id, repo, run, receivedAt, await startedAt());
          if (applied.recorded.length === 0) continue;
          // Persist the event even when it wakes nobody (a run that started
          // before every open watch's merge): a repeat delivery of the same
          // run and attempt must not wake that watch later (BB-61, BB-132).
          store.patch(b.id, { deployments: applied.deployments });
          if (applied.woken.length === 0) {
            store.note(b.id, `${workflowRunLine(repo, run, awaitingOnRepo(applied.deployments, repo))} It started before these merges, so it was recorded rather than woken.`, true);
            continue;
          }
          store.note(b.id, workflowRunLine(repo, run, awaitingOnRepo(applied.deployments, repo)), false);
          bb.log.info(`stewards: workflow run ${id} (${run.conclusion}) on ${repo} concerns ${applied.woken.join(", ")}`);
          scheduleReconcile(b.id);
        }
      }
    }

    /** A ring from a source: look at the binding(s) it concerns, or consider adopting. */
    async function onRing(source: Source, id: string): Promise<void> {
      const bound = store.byEntity(source, id);
      if (bound !== null) scheduleReconcile(bound.id);
      if (source === "github") {
        // A Dependabot alert doorbell names the alert, not the repository's
        // ops binding; wake that repository's dependency watch. An id with a
        // github binding is an issue or pull request, not an alert.
        const repo = bound === null ? repoOfFingerprint(id) : null;
        if (repo !== null) {
          const deps = store.byEntity("ops", opsTargetKey({ kind: "dependabot", repo }));
          if (deps !== null && deps.endedAt === null) scheduleReconcile(deps.id);
        }
        for (const t of store.open()) {
          if (t.kind === "ticket" && (t.lastSnapshot?.entity.linkedPulls ?? []).some((l) => lc(l.key) === lc(id))) scheduleReconcile(t.id);
        }
      }
      if (bound !== null) return;
      const projects = await stewardedProjects();
      if (projects.length === 0) return;
      const entity = await snapshot(source, id);
      if (entity === null) return;
      await maybeAdopt(entity, projects);
    }

    /** A labelled ticket with no assignee, listed read-only in the digest (BB-115). */
    type UnassignedTicket = { key: string; title: string | null; url: string | null };

    /**
     * The nightly backstop for adoption: everything adoptable that has no
     * binding, oldest first, at most `perPass` per project per pass so
     * turning stewards on does not start every steward at once. With
     * `collectUnassigned` it also returns the labelled tickets nobody is
     * assigned, which are adopted nowhere and belong in the digest.
     */
    async function adoptionPass(config: ProjectConfig, opts: { collectUnassigned?: boolean } = {}): Promise<{ adopted: number; unassigned: UnassignedTicket[] }> {
      const candidates: Array<{ source: Source; id: string; createdAt: string }> = [];
      const ask = async (source: Source, units: string[]) => {
        if (units.length === 0) return;
        try {
          const out = await sourceRpc(source, "sourceAdoptable", { units, label: config.file.label, limit: 300 }, sourceContract.sourceAdoptable.output);
          for (const e of out.errors) bb.log.warn(`stewards: ${source} adoption list: ${e}`);
          for (const e of out.entities) {
            if (store.byEntity(source, e.id) !== null) continue;
            if (adoptionKind(config, { source, ...e }, out.viewer) === null) continue;
            candidates.push({ source, id: e.id, createdAt: e.createdAt ?? "" });
          }
        } catch (error) {
          bb.log.warn(`stewards: could not list adoptable ${source} entities: ${errorMessage(error)}`);
        }
      };
      await ask("linear", config.file.linear.teams);
      await ask("github", config.repos);
      candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      // The digest's orphan list: every labelled ticket nobody is assigned.
      // Only Linear candidates are read for it; the per-pass cap still bounds
      // how many stewards a pass starts.
      const unassigned: UnassignedTicket[] = [];
      const orphanSnapshots = new Map<string, EntitySnapshot>();
      if (opts.collectUnassigned) {
        for (const c of candidates.filter((x) => x.source === "linear")) {
          const entity = await snapshot("linear", c.id).catch(() => null);
          if (entity === null) continue;
          orphanSnapshots.set(c.id, entity);
          if (entity.assignees.length === 0 && hasLabel(entity, config.file.label)) unassigned.push({ key: entity.key, title: entity.title, url: entity.url });
        }
      }
      let adopted = 0;
      for (const c of candidates) {
        if (adopted >= config.file.adoption.perPass) break;
        const entity = orphanSnapshots.get(c.id) ?? (await snapshot(c.source, c.id).catch(() => null));
        if (entity !== null && (await maybeAdopt(entity, [config])) !== null) adopted++;
      }
      return { adopted, unassigned };
    }

    // ---- escalations -----------------------------------------------------------------------------
    //
    // Up the tree: the parent steward, then the project steward, which
    // decides from the project's guidance and forwards to the user only what
    // the project file calls a big decision. A forward to the user is the
    // project steward asking them in its own thread; thread-briefs shows that
    // thread as waiting on them, so nothing here asks for attention itself.

    async function wakeProject(projectId: string, reason: string, opts: { digestDue: boolean; notes?: string[] }): Promise<void> {
      const config = await loadConfig(projectId);
      if (config === null) return;
      const threadId = await ensureProjectSteward(config);
      if (threadId === null) return;
      const records = opts.digestDue ? digestRecords(projectId) : undefined;
      if (opts.digestDue) store.patchProject(projectId, { digestPending: true });
      const info = await threadInfo(threadId).catch(() => null);
      if (info === null || info.deletedAt !== null) return;
      if (info.archivedAt !== null) await quietly(`unarchive ${threadId}`, () => bb.sdk.threads.unarchive({ threadId }));
      // Read as of the send, so an escalation resolved meanwhile is left out,
      // and marked delivered in the same step, so a prompt sent right after
      // lists it as still open rather than new. The text is built before the
      // mark, so a throw while building it leaves nothing marked.
      const open = store.open(projectId);
      // An approval escalation to the project steward carries the decide-list
      // listing, fetched once here from the pull request's changed files, so
      // the wake names every entry that matched and the one that decides
      // (BB-135).
      const routedRaw = open.flatMap((b) => store.openEscalations(b.id).filter((x) => x.route === "project").map((escalation) => ({ escalation, from: b })));
      const routed = await Promise.all(
        routedRaw.map(async (r) => {
          if (r.escalation.kind !== "approval") return r;
          const pull = r.from.lastSnapshot === null ? undefined : observedPulls(r.from, r.from.lastSnapshot).find((p) => (p.url ?? p.key) === r.escalation.url);
          if (pull === undefined) return r;
          return {
            ...r,
            listing: formatDecisionListing(explainDecision(await pullChangedFiles(pull), config.file.bigDecisions)),
            // A reviewer's owner call makes the approval the owner's, whatever
            // the decide list matched, so the wake says so and the project
            // steward forwards rather than approves (BB-192).
            escalated: prGate(pull, { projectApprovals: projectApprovalsFor(r.from), ...productGateOptions(r.from, pull) }).escalated,
          };
        }),
      );
      const coveredWithUser = new Set(store.openQuestionEscalationIds(projectId));
      const withUser = open.flatMap((b) => store.openEscalations(b.id).filter((x) => x.route === "user" && !x.isQuestion && x.kind !== "approval" && x.resolutionKind === null && !coveredWithUser.has(x.id)).map((escalation) => ({ escalation, from: b })));
      const bindings = open.map((binding) => ({ binding, openEscalations: store.openEscalations(binding.id) }));
      const questions = store.openQuestions(projectId).map((question) => ({ question, about: question.bindingId === null ? null : store.binding(question.bindingId) }));
      const needs = open.flatMap((b) => store.openNeeds(b.id).map((need) => ({ need, binding: b })));
      const assumptions = store.openAssumptionsForProject(projectId).map((assumption) => ({ assumption, binding: assumption.bindingId === null ? null : (store.binding(assumption.bindingId) ?? null) }));
      const text = formatProjectWake({ reason, bindings, routed, withUser, problems: config.problems, digestDue: opts.digestDue, notes: opts.notes ?? [], bigDecisions: config.file.bigDecisions, standingRules: config.file.standingRules, questions, needs, assumptions, lessons: store.allLessons(projectId), lessonRules: config.file.lessons, timeZone: config.file.nightly.timezone, label: config.file.label, ...(records === undefined ? {} : { records }) });
      const delivered = { ids: routed.filter((r) => r.escalation.deliveredAt === null).map((r) => r.escalation.id), at: 0 };
      delivered.at = store.markDelivered(delivered.ids);
      // A wake can be the thing that pushes the transcript over the limit.
      await compactIfLarge(threadId, text.length);
      const sent = await send(threadId, text);
      if (sent !== "sent") store.undeliver(delivered.ids, delivered.at);
      // The notes were only peeked at, so a failed or skipped send leaves them
      // queued for the next digest rather than losing them.
      else if (opts.digestDue) store.clearProjectNotes(projectId);
    }

    /** What the digest is written from, since the last one (or a day back): read from the tables, never from the project steward's memory. */
    function digestRecords(projectId: string): DigestRecords {
      const row = store.project(projectId);
      const since = row.digestAt ?? now() - 86_400_000;
      const all = store.all(projectId);
      const open = all.filter((b) => b.endedAt === null);
      const openWith = (pick: (x: Escalation) => boolean) => open.flatMap((b) => store.openEscalations(b.id).filter(pick).map((escalation) => ({ escalation, from: b })));
      const coveredInDigest = new Set(store.openQuestionEscalationIds(projectId));
      return {
        previous: row.digest === null ? null : { text: row.digest, at: row.digestAt ?? 0 },
        since,
        notes: store.peekProjectNotes(projectId),
        moved: open.filter((b) => b.advancedAt !== null && b.advancedAt >= since),
        ended: all.filter((b) => b.endedAt !== null && b.endedAt >= since),
        answered: store.answeredSince(projectId, since),
        withUser: openWith((x) => x.route === "user" && x.resolutionKind === null && !x.isQuestion && !coveredInDigest.has(x.id)),
        needs: open.flatMap((b) => store.openNeeds(b.id).map((need) => ({ need, binding: b }))),
        assumptions: store.openAssumptionsForProject(projectId).map((assumption) => ({ assumption, binding: assumption.bindingId === null ? null : (store.binding(assumption.bindingId) ?? null) })),
        stuck: openWith((x) => x.kind === "stuck"),
        noWakeSource: open.filter((b) => b.noWakeSource),
        stall: openWith((x) => x.kind === "stall"),
        // BB-247: the dated waits still ahead, listed separately from stalls.
        datedWaits: open.filter((b) => b.requeueUntil !== null && b.requeueUntil > now()),
        held: open.filter((b) => b.hold !== null),
      };
    }

    // ---- lessons -------------------------------------------------------------------------------
    //
    // A lesson is a general rule the project steward drew from an escalation
    // or its own judgement. It is pending until its text is found at `.bb`
    // HEAD. Since BB-106 made `.bb` a directory on the primary repo's default
    // branch, a promoted or retired lesson lands as a reviewed pull request
    // (BB-108): the project steward publishes the `guidance-<thread>` branch,
    // and this plugin opens the pull request. A `procedure` lesson's PR is
    // merged by the project steward at once; a `boundary` one waits for the
    // owner to merge it, and the lesson is marked merged when the PR merges.

    /** Close the open Review PR/Drop item for a boundary lesson, if one is filed. */
    function closeLessonNeed(lesson: Lesson, resolution: string): void {
      if (lesson.bindingId === null) return;
      store.closeNeedByKey(lesson.bindingId, "decide", lesson.id, resolution);
    }

    /** The files a lesson may never target: the decide list, the roles split, and anything under them. */
    function lessonFileAllowed(file: string): boolean {
      return file !== PROJECT_FILE && file !== ROLES_FILE;
    }

    /**
     * The primary repo a lesson's pull request opens on, from the project's
     * chosen source (BB-107): multi-repo's repo set, or native git's checkout
     * `origin`. A native project can open the pull request the same way once
     * its `guidance-<thread>` branch is published; the branch push itself is
     * still multi-repo's `workspace_publish_guidance`.
     */
    async function lessonRepo(projectId: string): Promise<{ repo: string } | { error: string }> {
      const config = await loadConfig(projectId);
      if (config === null) return { error: "the project has no readable configuration to read its primary repo from" };
      let set: Awaited<ReturnType<ProjectSource["repoSet"]>>;
      try {
        set = await config.source.repoSet();
      } catch (error) {
        bb.log.warn(`stewards: could not read the repo set for a lesson pull request: ${errorMessage(error)}`);
        return { error: "could not read the project's primary repo" };
      }
      if (set.primary === null) return { error: "the project source has no origin to open a lesson pull request on" };
      const repo = githubRepoOf(set.primary.url);
      if (repo === null) return { error: `the project source's origin ${set.primary.url} is not a GitHub repo` };
      return { repo };
    }

    /** The signed body of a lesson's pull request: the id, the anchor, and the steward that proposed it. */
    function lessonPrBody(lesson: Lesson, text: string, threadId: string, retire: boolean): string {
      const binding = lesson.bindingId === null ? null : store.binding(lesson.bindingId);
      const anchor = retire ? retiredLessonAnchor(lesson.id) : lessonAnchor(lesson.id);
      return [
        `${retire ? "Retires" : "Lands"} lesson \`${lesson.id}\` in \`${lesson.file}\` (proposed by the project steward${binding === null ? "" : ` for ${binding.entityKey}`}).`,
        "",
        `Anchor: \`${anchor}\``,
        "",
        text,
        "",
        `_— from bb thread ${threadId}_`,
      ].join("\n");
    }

    type LessonPrResult = { ok: boolean; repo: string | null; url: string | null; number: number | null; branch: string | null; message: string };

    /**
     * Open the pull request that lands a lesson's anchored block on the primary
     * repo. The branch has already been published by
     * `workspace_publish_guidance`; this only turns it into a PR. The
     * self-widening guard (BB-35 limit 1) is enforced here, before anything is
     * opened, and the same branch is reused when a nightly pass lands several
     * lessons in one publish. A retirement asks for `fresh` so the promotion's
     * merged PR is never reused.
     */
    async function openLessonPr(lesson: Lesson, text: string, opts: { retire?: boolean } = {}): Promise<LessonPrResult> {
      const retire = opts.retire === true;
      const projectThreadId = store.project(lesson.projectId).threadId;
      const branch = lesson.branch ?? (projectThreadId === null ? null : lessonBranchFor(projectThreadId));
      if (!lessonFileAllowed(lesson.file)) return { ok: false, repo: null, url: null, number: null, branch, message: `a lesson may never target ${lesson.file}` };
      if (projectThreadId === null) return { ok: false, repo: null, url: null, number: null, branch, message: "the project steward has no thread yet, so nothing has been published" };
      if (branch === null) return { ok: false, repo: null, url: null, number: null, branch, message: "the lesson has no branch to open a pull request from" };
      if (lesson.branch === null) store.setLessonBranch(lesson.id, branch);
      const primary = await lessonRepo(lesson.projectId);
      if ("error" in primary) return { ok: false, repo: null, url: null, number: null, branch, message: primary.error };
      const already = retire ? lesson.retirePr : lesson.pr;
      if (already !== null) {
        const ref = parsePullRef(already);
        return { ok: true, repo: primary.repo, url: already, number: ref?.number ?? null, branch, message: `already open at ${already}` };
      }
      if (!retire) {
        // Several lessons landed in one nightly publish share a branch, so they
        // share one pull request.
        const sibling = store.allLessons(lesson.projectId).find((l) => l.id !== lesson.id && l.status === "pending" && l.branch === branch && l.pr !== null);
        if (sibling !== undefined && sibling.pr !== null) {
          store.setLessonPr(lesson.id, sibling.pr);
          const ref = parsePullRef(sibling.pr);
          return { ok: true, repo: primary.repo, url: sibling.pr, number: ref?.number ?? null, branch, message: `reuses ${sibling.pr}` };
        }
      }
      const base = await github.defaultBranch(primary.repo).catch((error: unknown) => {
        bb.log.warn(`stewards: could not read ${primary.repo}'s default branch: ${errorMessage(error)}`);
        return null;
      });
      if (base === null) return { ok: false, repo: primary.repo, url: null, number: null, branch, message: `could not read ${primary.repo}'s default branch` };
      const head = branch.replace(/^refs\/heads\//u, "");
      try {
        const created = await github.createPull(primary.repo, { head, base, title: `${retire ? "Retire" : "Lesson"} ${lesson.id}: ${lesson.file}`, body: lessonPrBody(lesson, text, projectThreadId, retire) });
        if (retire) store.setLessonRetirePr(lesson.id, created.url);
        else store.setLessonPr(lesson.id, created.url);
        return { ok: true, repo: primary.repo, url: created.url, number: created.number, branch, message: `opened ${created.url}` };
      } catch (error) {
        return { ok: false, repo: primary.repo, url: null, number: null, branch, message: errorMessage(error) };
      }
    }

    /**
     * The `.bb` files the pull request may change: this lesson's own file and
     * the files of the lessons that share its PR (several lessons in one
     * publish). The project file and `roles.json` are never allowed, so a
     * hand-edited pre-guard row cannot widen the set.
     */
    function lessonPrFiles(projectId: string, url: string, lessonId: string): string[] {
      return [
        ...new Set(
          store
            .allLessons(projectId)
            .filter((l) => (l.id === lessonId || l.pr === url || l.retirePr === url) && lessonFileAllowed(l.file))
            .map((l) => l.file),
        ),
      ];
    }

    /**
     * The narrow guard the old fast-forward enforced, on the pull request
     * (BB-35 limit 1, BB-108): the PR must change only the files of the lessons
     * published on its branch, and this lesson's file must carry its anchor.
     * Returns why it refuses, or null when the PR is safe to merge. Fails
     * closed when the read is unavailable.
     */
    async function verifyLessonPr(lesson: Lesson, result: LessonPrResult, anchor: string): Promise<string | null> {
      if (result.repo === null || result.number === null || result.branch === null) return "the pull request could not be read";
      if (github.files === undefined) return "the pull request's changed files cannot be read";
      let files: string[];
      try {
        files = await github.files(result.repo, result.number);
      } catch (error) {
        return `could not read the pull request's changed files: ${errorMessage(error)}`;
      }
      // `files` reads one page; a full page means there may be more to check.
      if (files.length >= 100) return "the pull request changes too many files to verify";
      const allowed = lessonPrFiles(lesson.projectId, result.url ?? "", lesson.id);
      const bad = files.filter((path) => !allowed.some((file) => path === file || path === `.bb/${file}`));
      if (bad.length > 0) return `the pull request changes files other than the lesson's own: ${bad.slice(0, 5).join(", ")}`;
      const path = files.find((p) => p === lesson.file || p === `.bb/${lesson.file}`);
      if (path === undefined) return `the pull request does not change ${lesson.file}`;
      if (github.fileContent === undefined) return `${path} cannot be read from the pull request`;
      let content: string | null;
      try {
        content = await github.fileContent(result.repo, path, result.branch.replace(/^refs\/heads\//u, ""));
      } catch (error) {
        return `could not read ${path} from the pull request: ${errorMessage(error)}`;
      }
      if (content === null || !content.includes(anchor)) return `${path} does not carry the lesson's anchor`;
      return null;
    }

    /** Squash-merge a lesson's pull request as the project steward, and mark the lesson merged. The narrow guard is checked first, and a refusal is recorded as a note, like a refused open, so the nightly wake shows it. */
    async function mergeLessonPr(lesson: Lesson, result: LessonPrResult, note: string, opts: { retire?: boolean; verb?: string } = {}): Promise<{ ok: boolean; message: string }> {
      if (result.repo === null || result.number === null) return { ok: true, message: `pull request opened at ${result.url ?? "?"}` };
      const retire = opts.retire === true;
      const problem = await verifyLessonPr(lesson, result, retire ? retiredLessonAnchor(lesson.id) : lessonAnchor(lesson.id));
      if (problem !== null) {
        store.noteLesson(lesson.id, problem);
        return { ok: false, message: `pull request refused: ${problem}` };
      }
      try {
        const { sha } = await github.squashMerge(result.repo, result.number, `Lesson ${lesson.id}`, note);
        store.markLessonMerged(lesson.id, sha, result.branch ?? lesson.branch, note);
        return { ok: true, message: `${opts.verb ?? "merged"} at ${sha ?? result.url ?? "?"}${result.branch === null ? "" : ` on ${result.branch}`}` };
      } catch (error) {
        const message = errorMessage(error);
        store.noteLesson(lesson.id, message);
        return { ok: false, message: `pull request refused: ${message}` };
      }
    }

    /**
     * Close a lesson's open pull request (Drop). A promotion pull request can
     * be shared by several pending lessons in one publish, so it is closed only
     * when no other pending lesson still references it; the survivors keep it.
     */
    async function closeLessonPr(lesson: Lesson, url?: string | null): Promise<void> {
      const pr = url === undefined ? (lesson.retirePr ?? lesson.pr) : url;
      if (pr === null) return;
      const shared = store.allLessons(lesson.projectId).some((l) => l.id !== lesson.id && l.status === "pending" && (l.pr === pr || l.retirePr === pr));
      if (shared) return;
      const ref = parsePullRef(pr);
      if (ref === null) return;
      await github.closePull(ref.repo, ref.number).catch((error: unknown) => bb.log.warn(`stewards: could not close ${pr}: ${errorMessage(error)}`));
    }

    /** Land a procedure lesson at once, or file a boundary one for the owner to review. */
    async function completeLesson(lesson: Lesson, action: "complete" | "drop"): Promise<string> {
      if (action === "drop") {
        await closeLessonPr(lesson);
        store.markLessonDropped(lesson.id, "Dropped by the project steward.");
        closeLessonNeed(lesson, "Dropped by the project steward.");
        return "dropped";
      }
      if (lesson.scope === "boundary" && lesson.bindingId === null) return "a boundary lesson needs the binding it came from; record it with binding.";
      // A publish that landed several lessons in one branch may already have
      // put this one's anchored text at HEAD when an earlier lesson merged;
      // observe it rather than opening a pull request with no commits.
      const atHead = (await readFiles(lesson.projectId, [lesson.file]).catch(() => new Map<string, string | null>())).get(lesson.file) ?? null;
      if (atHead !== null && hasLessonAnchor(atHead, lesson.id)) {
        store.markLessonMerged(lesson.id, lesson.mergeSha, lesson.branch, "Already at .bb HEAD.");
        closeLessonNeed(lesson, "Already at .bb HEAD.");
        return "already landed at .bb HEAD";
      }
      const result = await openLessonPr(lesson, withLessonAnchor(lesson.text, lesson.id));
      if (!result.ok) {
        store.noteLesson(lesson.id, result.message);
        return `pull request refused: ${result.message}`;
      }
      if (lesson.scope === "boundary") {
        fileBoundaryLessonNeed(lesson, result.branch, result.url);
        return `boundary lesson; Review PR/Drop filed for the user at ${result.url ?? "?"}`;
      }
      return (await mergeLessonPr(lesson, result, "Landed by the project steward (procedure lesson).")).message;
    }

    /**
     * Remove a retired lesson's text from `.bb` as a pull request, leaving the
     * retired anchor behind. The project steward has already removed the text
     * and published the branch. A lesson that never reached the file is retired
     * in the row alone.
     */
    async function retireLesson(lesson: Lesson): Promise<string> {
      if (lesson.status !== "merged") {
        store.markLessonDropped(lesson.id, "Retired before it reached the file.");
        return "retired (it was not in the file)";
      }
      // A publish that retired several lessons in one branch may already have
      // put this one's retired anchor at HEAD when an earlier retire merged.
      const atHead = (await readFiles(lesson.projectId, [lesson.file]).catch(() => new Map<string, string | null>())).get(lesson.file) ?? null;
      if (atHead !== null && atHead.includes(retiredLessonAnchor(lesson.id))) {
        store.markLessonDropped(lesson.id, `Retired; the anchored text was removed from ${lesson.file}.`);
        closeLessonNeed(lesson, "Already retired at .bb HEAD.");
        return "already retired at .bb HEAD";
      }
      const result = await openLessonPr(lesson, retiredLessonAnchor(lesson.id), { retire: true });
      if (!result.ok) {
        store.noteLesson(lesson.id, result.message);
        return `retire refused: ${result.message}`;
      }
      if (lesson.scope === "boundary") {
        fileBoundaryLessonNeed(lesson, result.branch, result.url, true);
        return `boundary retire; Review PR/Drop filed for the user at ${result.url ?? "?"}`;
      }
      const merged = await mergeLessonPr(lesson, result, `Retired; the anchored text was removed from ${lesson.file}.`, { retire: true, verb: "retired" });
      if (merged.ok) store.markLessonDropped(lesson.id, `Retired; the anchored text was removed from ${lesson.file}.`);
      return merged.message;
    }

    /** Each pass, a lesson whose anchored text is already at `.bb` HEAD is merged, however it got there. */
    async function reconcileLessons(config: ProjectConfig): Promise<void> {
      const pending = store.lessons(config.projectId).filter((lesson) => lesson.tier !== "retired");
      for (const lesson of pending) {
        // One lesson's file being unreadable — a bad path, a transient read
        // failure — must not stop every other lesson being checked.
        let content: string | null = null;
        try {
          content = (await config.source.readFiles([lesson.file])).get(lesson.file) ?? null;
        } catch (error) {
          bb.log.warn(`stewards: could not read lesson ${lesson.id}'s file ${lesson.file}: ${errorMessage(error)}`);
          continue;
        }
        // The anchor is the marker; a lesson merged before step 3 has only the
        // wording, so a plain-text match still counts.
        if (content !== null && (hasLessonAnchor(content, lesson.id) || normalizeLessonText(content).includes(normalizeLessonText(lesson.text)))) {
          store.markLessonMerged(lesson.id, lesson.mergeSha, lesson.branch);
          closeLessonNeed(lesson, "The anchored text is at .bb HEAD.");
        }
      }
      await reconcileLessonPrs(config);
    }

    /**
     * A pending lesson's pull request is the merge signal (BB-108): read it
     * through the github source and mark the lesson merged when it merged,
     * closing the owner's Review PR item. The read is best-effort, so one
     * unreadable pull request does not stop the others.
     */
    async function reconcileLessonPrs(config: ProjectConfig): Promise<void> {
      for (const lesson of store.allLessons(config.projectId)) {
        // A pending lesson lands when its promotion PR merges; a retired lesson
        // whose anchored text is still in the file (status merged) is dropped
        // when its retire PR merges. The two PRs are kept apart so a promotion
        // merge never retires a lesson and a retire merge never lands one.
        const retire = lesson.status === "merged" && lesson.retirePr !== null;
        if (!retire && lesson.status !== "pending") continue;
        const pr = retire ? lesson.retirePr : lesson.pr;
        if (pr === null) continue;
        const ref = parsePullRef(pr);
        if (ref === null) continue;
        try {
          const pull = await snapshot("github", `${ref.repo}#${ref.number}`);
          if (pull?.pull?.merged === true) {
            if (retire) store.markLessonDropped(lesson.id, `Retired; the anchored text was removed from ${lesson.file}.`);
            else store.markLessonMerged(lesson.id, lesson.mergeSha, lesson.branch, "The pull request merged.");
            closeLessonNeed(lesson, "The pull request merged.");
          }
        } catch (error) {
          bb.log.warn(`stewards: could not read lesson ${lesson.id}'s pull request ${pr}: ${errorMessage(error)}`);
        }
      }
    }

    /**
     * Apply the mechanical tier transitions (BB-35 step 3): promote a trial
     * that earned it, retire a trial or promoted lesson that aged out or was
     * corrected, retire a superseded lesson, and displace the lowest-scoring
     * promoted lesson when a file is full. The decisions are pure (lessons.ts);
     * this only writes them. A promotion the project steward has not landed
     * yet is still `pending`, and a retirement of a lesson that is in the file
     * keeps `merged` until the text is removed.
     */
    function applyLessonTransitions(config: ProjectConfig): void {
      const transitions = planLessonTransitions(store.allLessons(config.projectId), config.file.lessons, now());
      for (const transition of transitions) {
        const lesson = store.lesson(transition.id);
        if (lesson === null || lesson.tier === "retired") continue;
        if (transition.action === "promote") {
          store.setLessonTier(transition.id, "promoted");
          continue;
        }
        retireLessonByRule(lesson, transition.reason);
      }
    }

    /** Retire a lesson the mechanical rules decided against, keeping the row and the file state. */
    function retireLessonByRule(lesson: Lesson, reason: string): void {
      // A retirement of a lesson that never landed resolves the row here:
      // there is no anchored text to remove, so nothing waits on the project
      // steward and the row must not linger as pending. One that is in the
      // file stays `merged` until its text is removed through the wake.
      if (lesson.status === "pending") store.markLessonDropped(lesson.id, `Retired: ${reason}.`);
      else {
        store.setLessonTier(lesson.id, "retired");
        store.noteLesson(lesson.id, `Retired: ${reason}.`);
      }
      // A validation item that asked about a lesson the rules retired anyway
      // must not linger as a question the user can still answer.
      const open = store.openLessonValidationNeed(lesson.id);
      if (open !== null) store.closeNeed(open.id, `Retired: ${reason}.`, "plugin");
    }

    /** The branch a lesson is published on, from its record or the project steward's thread. */
    function lessonBranch(lesson: Lesson): string | null {
      const threadId = store.project(lesson.projectId).threadId;
      return lesson.branch ?? (threadId === null ? null : lessonBranchFor(threadId));
    }

    /**
     * File the boundary lesson's Review PR/Drop item (BB-35 steps 3/5, BB-108).
     * It is the existing validation escalation: only the owner merging the pull
     * request makes a boundary lesson permanent, and an unanswered item leaves
     * the lesson in trial.
     */
    function fileBoundaryLessonNeed(lesson: Lesson, branch: string | null, prUrl: string | null, retire = false): boolean {
      if (lesson.bindingId === null) return false;
      store.fileNeed({
        bindingId: lesson.bindingId,
        kind: "decide",
        url: lesson.id,
        what: `Review or drop the ${retire ? "retirement of the " : ""}boundary lesson for ${lesson.file}`,
        how: [
          retire
            ? "The nightly pass retired this boundary lesson, so removing its anchored text also changes the boundary and only you may make it permanent."
            : "The project steward recorded a general rule that changes its own escalation boundary, so only you may make it permanent.",
          "",
          `> ${lesson.text}`,
          "",
          `File: \`${lesson.file}\`. Branch: \`${branch ?? "(not published yet)"}\`.`,
          prUrl === null ? "The pull request is not open yet." : `Review the pull request at ${prUrl}; the lesson is marked ${retire ? "dropped" : "merged"} when it merges. Drop closes it and discards the lesson.`,
        ].join("\n"),
        data: { lessonId: lesson.id, branch, file: lesson.file, prUrl, retire, choices: ["Review PR", "Drop"], validation: "boundary-promotion" },
        filedBy: "project",
      });
      return true;
    }

    /** File the mixed-evidence Keep/Retire question (BB-35 step 5). Silence retires the lesson. */
    function fileMixedEvidenceNeed(lesson: Lesson): boolean {
      if (lesson.bindingId === null) return false;
      store.fileNeed({
        bindingId: lesson.bindingId,
        kind: "decide",
        url: lesson.id,
        what: `Keep or retire the lesson for ${lesson.file}`,
        how: [
          `This promoted lesson has ${lesson.hits} citation${lesson.hits === 1 ? "" : "s"} and ${lesson.corrections} correction${lesson.corrections === 1 ? "" : "s"}, so its evidence is mixed.`,
          "",
          `> ${lesson.text}`,
          "",
          `File: \`${lesson.file}\`. Keep leaves it in \`.bb\`; Retire removes its anchored text. Silence retires it on the next nightly pass.`,
        ].join("\n"),
        data: { lessonId: lesson.id, file: lesson.file, choices: ["Keep", "Retire"], validation: "mixed-evidence" },
        filedBy: "plugin",
      });
      return true;
    }

    /**
     * BB-35 step 5: file the rare validation escalations, rate-capped. The
     * queue is ordered by score; at most `lessons.validations.perWeek` of this
     * project's validation items may be filed in a rolling week and the rest
     * wait. The budget covers every user-facing lesson question, including the
     * boundary Merge/Drop the project steward files by hand at `complete` time:
     * a manual filing is the project steward's explicit override, and it still
     * spends a slot so the user is not asked twice in one week. Silence is the
     * default: an unanswered mixed-evidence question retires the lesson on the
     * next pass, while a boundary Merge/Drop left unanswered leaves the lesson
     * in trial.
     */
    function applyValidations(config: ProjectConfig): void {
      const at = now();
      const requests = planValidations(store.allLessons(config.projectId), config.file.lessons, at);
      if (requests.length === 0) return;
      let remaining = Math.max(0, config.file.lessons.validations.perWeek - store.validationsFiledSince(config.projectId, at - 7 * 86_400_000));
      for (const request of requests) {
        const lesson = store.lesson(request.id);
        if (lesson === null || lesson.tier === "retired") continue;
        // A mixed-evidence question filed on an earlier pass and still
        // unanswered retires the lesson: silence is the default. A boundary
        // Merge/Drop left open leaves the lesson in trial. The question is
        // closed with the lesson by `retireLessonByRule`.
        if (request.validation === "mixed-evidence" && lesson.validationFiledAt !== null) {
          retireLessonByRule(lesson, "no answer to the keep/retire question");
          continue;
        }
        if (store.openLessonValidationNeed(lesson.id) !== null) continue;
        if (remaining <= 0) continue;
        const branch = request.validation === "boundary-promotion" ? lessonBranch(lesson) : null;
        if (branch !== null) store.setLessonBranch(lesson.id, branch);
        const filed = request.validation === "boundary-promotion" ? fileBoundaryLessonNeed(lesson, branch, lesson.pr) : fileMixedEvidenceNeed(lesson);
        if (!filed) {
          // A lesson with no binding (a hand-edited or pre-guard row) has no
          // item to live on; say so once rather than skipping it in silence.
          store.noteLesson(lesson.id, "No binding to file the validation item on; record the lesson with a binding.");
          continue;
        }
        store.markLessonValidationFiled(lesson.id, at);
        remaining -= 1;
      }
    }

    /**
     * The escalation's cluster key, computed from its playbook and question and
     * written the first time (BB-35 steps 4/6). The after-the-fact ask needs it
     * so the lesson recorded from the thread follow-up can settle the cluster.
     */
    function ensureEscalationCluster(x: Escalation): string {
      if (x.clusterKey !== null) return x.clusterKey;
      const b = x.bindingId === "" ? null : store.binding(x.bindingId);
      const key = clusterKey(b?.playbook ?? null, x.question);
      store.setEscalationCluster(x.id, key);
      return key;
    }

    /**
     * The cluster a lesson recorded for a binding settles (BB-35 step 6): the
     * escalation it names, or the binding's outstanding after-the-fact ask
     * (the one the project steward collected a why for in its thread). Null
     * when neither exists, so an ordinary lesson is not linked to a cluster it
     * did not answer. `settleClusterRationale` is the caller's next step.
     */
    function lessonClusterFor(bindingId: string | null, escalationId: string | null): string | null {
      let x = escalationId === null ? null : store.escalation(escalationId);
      // Only the after-the-fact follow-up's ask links a lesson to a cluster; an
      // unanswered page box is not what the project steward is recording a why
      // for.
      if (x === null && bindingId !== null) x = store.escalationsAskedNotGiven(bindingId).find((e) => e.rationaleWanted === AFTER_THE_FACT_RATIONALE_WHY) ?? null;
      return x === null ? null : ensureEscalationCluster(x);
    }

    /**
     * BB-35 step 4: cluster the escalations routed to the user under their
     * playbook. A question that repeats an earlier one is a repeat: the page
     * asks why, once per cluster, so the answer becomes a lesson. A cluster
     * that already shows a box, has been asked, or has a lesson from an
     * after-the-fact thread follow-up is left alone — never twice for one
     * cluster, across mechanisms (BB-35 step 6).
     */
    function applyRationaleClustering(config: ProjectConfig): void {
      const rows = store.openUserEscalations(config.projectId);
      const byKey = new Map<string, Escalation[]>();
      for (const x of rows) {
        // Only a question has the page's box; a raw route-`user` escalation
        // (an approval request) never asks.
        if (!x.isQuestion) continue;
        // A question with no binding (the project steward's own) has no
        // playbook, but still clusters by its wording.
        const b = x.bindingId === "" ? null : store.binding(x.bindingId);
        const key = x.clusterKey ?? clusterKey(b?.playbook ?? null, x.question);
        store.setEscalationCluster(x.id, key);
        byKey.set(key, [...(byKey.get(key) ?? []), x]);
      }
      for (const [key, members] of byKey) {
        if (members.length < 2) continue;
        // A rationale supplied anywhere in the cluster settles it for good, so
        // a repeat after the box was answered is not asked again. A lesson the
        // project steward recorded from the cluster's after-the-fact follow-up
        // settles it too, across mechanisms (BB-35 step 6).
        if (store.escalationsByCluster(config.projectId, key).some((x) => x.rationaleGiven) || store.lessonsByCluster(config.projectId, key).length > 0) continue;
        // One box at a time: if any open member already shows the box or has
        // been asked, the repeats are left alone.
        if (members.some((x) => x.rationaleWanted !== null || x.rationaleAsked)) continue;
        // One box per cluster: the oldest is the first, the next is the repeat.
        store.setEscalationRationale(members[1]!.id, REPEAT_RATIONALE_WHY);
      }
    }

    /**
     * Count a correction when the owner's answer to an escalation differs from
     * the steward's recommendation on it and the decision cited lessons
     * (BB-35 step 2). Observed, never asked for; `correctionsCounted` keeps one
     * reversal to one count.
     */
    function countCorrections(x: Escalation, answer: string): void {
      if (x.recommendation === null || !answerDiffers(answer, x.recommendation)) return;
      // BB-35 step 4: the answer went against the recommendation, so the
      // project steward asks why once after the fact, cited or not — unless
      // the page box already collected their reasoning.
      const fresh = store.escalation(x.id) ?? x;
      if (!fresh.rationaleAsked && !fresh.rationaleGiven) {
        // Give it a cluster key so the lesson the project steward records from
        // the thread follow-up can settle it (BB-35 step 6).
        ensureEscalationCluster(fresh);
        store.setEscalationRationale(x.id, AFTER_THE_FACT_RATIONALE_WHY);
      }
      if (x.correctionsCounted || x.citedLessons.length === 0) return;
      store.recordCorrections(x.citedLessons);
      store.markEscalationCorrected(x.id);
    }

    /**
     * The same for an unsigned comment the owner wrote on the entity itself: it
     * differs from the recommendation on an open escalation that cited
     * lessons. A signed comment belongs to a thread, and anyone else's words
     * never count (BB-35 step 2).
     */
    function countCommentCorrections(b: Binding, observed: Observed): void {
      const viewer = observed.entity.viewer;
      if (viewer === null) return;
      const comments = newHumanComments(observed.entity, b.commentCursor, ownThreads(b));
      if (comments.length === 0) return;
      for (const x of store.openEscalations(b.id)) {
        if (x.recommendation === null) continue;
        if (!comments.some((c) => commentDiffersFromRecommendation(c, viewer, x.recommendation))) continue;
        // BB-35 step 4: the owner's own unsigned comment that goes against the
        // recommendation is the after-the-fact case too. Only the owner's words
        // reach here; anyone else's comment never sets an ask. A cluster key is
        // written so the follow-up's lesson settles the cluster (BB-35 step 6).
        if (!x.rationaleAsked) {
          ensureEscalationCluster(x);
          store.setEscalationRationale(x.id, AFTER_THE_FACT_RATIONALE_WHY);
        }
        if (x.correctionsCounted || x.citedLessons.length === 0) continue;
        store.recordCorrections(x.citedLessons);
        store.markEscalationCorrected(x.id);
      }
    }

    /** Where an escalation goes next, above where it is. */
    function nextRoute(b: Binding, from: EscalationRoute | null): EscalationRoute {
      if (from === null) {
        const parent = b.parentBindingId === null ? null : store.binding(b.parentBindingId);
        return parent !== null && parent.endedAt === null && parent.threadId !== null ? "parent" : "project";
      }
      if (from === "steward" || from === "parent") return "project";
      return "user";
    }

    async function deliver(b: Binding, x: Escalation): Promise<void> {
      if (x.route === "user") return;
      // A worker's escalation is for the binding's own steward.
      if (x.route === "steward") {
        store.note(b.id, `Escalation ${x.id} from a worker (${x.kind}): ${x.question}`);
        scheduleReconcile(b.id);
        return;
      }
      if (x.route === "parent" && b.parentBindingId !== null) {
        store.note(b.parentBindingId, `Escalation ${x.id} from ${b.entityKey} (${x.kind}): ${x.question}`);
        scheduleReconcile(b.parentBindingId);
        return;
      }
      await wakeProject(b.projectId, `escalation from ${b.entityKey}`, { digestDue: false });
    }

    /**
     * Keep the gate's approval request in step with the gate. While the
     * checklist is met, the ticket is substantial and the current spec has
     * no approval, one `approval` escalation is open with the approver: the
     * project steward, or the user with `approval: user`. It is the plugin's,
     * so the approver hears whatever the steward wrote, and it closes itself
     * once the gate passes or no longer needs an approval. A request the
     * approver declined (guidance + resolve) is not made again until the
     * spec changes. A Linear-state approval is the steward's to wait for.
     *
     * Returns a request just filed with the project steward, for the caller
     * to wake it, once, with whatever else it has to say.
     */
    async function syncApprovalRequest(b: Binding, playbook: Playbook): Promise<Escalation | null> {
      const mode = playbook.ready?.approval ?? null;
      if (mode === null || typeof mode === "object" || b.lastSnapshot === null) return null;
      // `approval: user` is the user's, and is filed as an `approve-spec` need by
      // syncNeeds; the escalation below is only for the project steward.
      if (mode === "user") return null;
      const open = store.openEscalations(b.id).filter((x) => x.kind === "approval" && x.resolutionKind !== "approve-decline");
      const current = specHashFor(b, b.lastSnapshot.entity);
      const gate = gateState(playbook, b.ready, current);
      const wanted = approvalWanted(gate) && b.endedAt === null && b.ending === null && b.ready.declinedSpecHash !== current;
      if (!wanted) {
        const why = gate.passed ? "The spec is approved." : !gate.checklistMet ? "Withdrawn: the ready checklist is no longer met." : !gate.approvalNeeded ? "Withdrawn: the ticket is not substantial." : "Withdrawn.";
        for (const x of open) store.resolve(x.id, why);
        return null;
      }
      if (open.length > 0) return null;
      // BB-251: the request lists the open assumptions it covers, and records
      // their ids, so the approval confirms exactly those. An assumption
      // recorded after this request was shown is not on the list and stays open.
      const coveredAssumptions = store.openAssumptions(b.id);
      const assumptionListing =
        coveredAssumptions.length === 0 ? "" : ` It covers ${coveredAssumptions.length} open assumption${coveredAssumptions.length === 1 ? "" : "s"}: ${coveredAssumptions.map((a) => `${a.id} — ${a.text}`).join("; ")}.`;
      // BB-249: a re-approval after an edit carries the same diff the user's
      // item does, so the project steward reads a change rather than a document.
      const prior = b.ready.approval;
      const approvedText = prior?.approvedText ?? b.ready.voidedApprovedText;
      const reapproval = approvedText !== null ? specDiff(approvedText, specTextFor(b, b.lastSnapshot.entity)) : null;
      const x = store.escalate({
        bindingId: b.id,
        kind: "approval",
        question:
          `Approve ${b.entityKey}'s spec${b.title === null ? "" : ` (${b.title})`}? The ready checklist is met and the ticket is ${b.ready.substantial === null ? "not yet judged, so treated as substantial" : "substantial"}${b.ready.why === null ? "" : ` (${b.ready.why})`}; ` +
          (gate.approvalStale ? "the spec has changed since its last approval." : "the current spec has no approval.") +
          assumptionListing,
        meanwhile: "Waiting: no implementation workers start until it is approved.",
        route: "project",
        recommendation: null,
        data: {
          assumptionIds: coveredAssumptions.map((a) => a.id),
          ...(reapproval === null ? {} : { specDiff: reapproval.diff, specChangedLines: reapproval.changedLines }),
        },
      });
      bb.log.info(`stewards: ${b.entityKey}'s ready gate waits on the project steward; asked for approval (${x.id})`);
      return x;
    }

    /**
     * Keep the scheduling request in step with the world. A ticket whose ready
     * gate has passed, with no worker running yet, that touches what another
     * binding is already building or reviewing, is the project steward's to
     * schedule: one `schedule` escalation is open with it, naming the overlap.
     * It is the plugin's, like the approval request, so the ticket steward
     * waits rather than starting a worker into a rebase. The project steward
     * either holds the ticket behind that work (`steward_update { hold, behind }`,
     * which resolves the request and lifts itself when the work lands) or lets
     * it start (guidance + resolve). A decided request is not made again for
     * the same bindings; a new overlap asks again.
     *
     * Returns a request just filed, for the caller to wake the project steward.
     */
    async function syncScheduleRequest(b: Binding, playbook: Playbook): Promise<Escalation | null> {
      const open = store.openEscalations(b.id).filter((x) => x.kind === "schedule");
      // Cleared: the gate has passed and nothing holds or schedules it, so it
      // is starting now, and the next ticket to pass its gate, before Linear
      // shows this one In Progress, schedules against it rather than racing it.
      const cleared = (v: boolean) => {
        if (b.clearedToStart !== v) store.patch(b.id, { clearedToStart: v });
      };
      const withdraw = (why: string, startable: boolean) => {
        for (const x of open) store.resolve(x.id, why);
        cleared(startable);
        return null;
      };
      if (b.kind !== "ticket" || b.endedAt !== null || b.ending !== null || b.lastSnapshot === null) return withdraw("Withdrawn.", false);
      if (b.hold !== null) return withdraw("Held.", false);
      const gate = gateState(playbook, b.ready, specHashFor(b, b.lastSnapshot.entity));
      if (!gate.passed) return withdraw("Withdrawn: the ready gate no longer passes.", false);
      // Finished work is not scheduled against anything: there is nothing left to start.
      if (b.lastSnapshot !== null && finished(b, b.lastSnapshot)) return withdraw("Withdrawn: the work is finished.", false);
      if (b.stage === "review" || store.workers(b.id).some((w) => w.status === "running")) return withdraw("Withdrawn: the work has started.", true);
      const conflicts = await conflictsFresh(b);
      if (conflicts.length === 0) return withdraw("Withdrawn: nothing in flight overlaps it now.", true);
      const keys = conflicts.map((c) => c.with.entityKey);
      if (open.length > 0) {
        cleared(false);
        return null;
      }
      if (keys.every((k) => b.scheduleAsked.includes(k))) {
        cleared(true);
        return null;
      }
      cleared(false);
      store.patch(b.id, { scheduleAsked: keys });
      const overlap = conflicts
        .map((c) => {
          const open = c.observed === null ? null : openPull(c.with, c.observed);
          const stack = open === null ? "" : `; its pull request ${open.key}${open.head === null || open.head === "" ? "" : ` is open on ${open.head}`}`;
          return `${c.with.entityKey} (${c.with.phase ?? "?"}; ${pullFacts(c.with, c.observed, c.complete)}) on the overlapping files ${c.on.join(", ")}${stack}`;
        })
        .join("; ");
      const x = store.escalate({
        bindingId: b.id,
        kind: "schedule",
        question:
          `Schedule ${b.entityKey}${b.title === null ? "" : ` (${b.title})`}? Its ready gate has passed, and it overlaps at file level with what is already being changed by ${overlap}. ` +
          `The default is to stack it, not to wait for the merge: when the earlier pull request is open, steward_update { binding: "${b.entityKey}", guidance: "Start now, branch from <its head branch> with that branch as PR base", resolve: "<this escalation>" }; when it has no pull request yet, steward_update { binding: "${b.entityKey}", hold: "<why>", stack: [${keys.map((k) => JSON.stringify(k)).join(", ")}] }, which lifts as soon as that pull request opens and wakes the steward with its head branch. ` +
          `Use a behind hold only when that work must land on the default branch first: steward_update { binding: "${b.entityKey}", hold: "<why>", behind: [${keys.map((k) => JSON.stringify(k)).join(", ")}] }, which lifts once its pull requests merge or it ends. ` +
          `When the overlap is harmless or the new ticket matters more (then consider holding the other one instead), let it start now with steward_update { binding: "${b.entityKey}", guidance: "Start now: <why>", resolve: "<this escalation>" }.`,
        meanwhile: "Waiting: no implementation workers start until it is scheduled.",
        route: "project",
        recommendation: null,
      });
      bb.log.info(`stewards: ${b.entityKey} overlaps ${keys.join(", ")}; asked the project steward to schedule it (${x.id})`);
      return x;
    }

    /**
     * How a finished target's hold release reads (BB-89): the ending it
     * reached, or the merge that finished it.
     */
    function howFinished(b: Binding): string {
      if (b.endedAt !== null) return `ended (${b.endReason ?? "ended"})`;
      if (b.ending === "terminal") return `reached ${b.lastSnapshot?.entity.state ?? "a terminal state"}`;
      return "merged its pull requests";
    }

    /**
     * The work a merge hold waits on has landed (BB-256): take `b`'s key off
     * every merge hold that names it, and where nothing is left to wait for,
     * clear the hold, note it on the held binding and wake its steward. The
     * next look files the Merge item again if the pull request is still open
     * with its gate met, so a stuck loop still surfaces.
     */
    async function releaseMergeBehind(b: Binding, how: string): Promise<void> {
      const key = lc(b.entityKey);
      const waiting = store.open(b.projectId).filter((h) => h.id !== b.id && h.mergeBehind.some((k) => lc(k) === key));
      if (waiting.length === 0) return;
      for (const h of waiting) {
        const rest = h.mergeBehind.filter((k) => lc(k) !== key);
        if (rest.length > 0) {
          store.patch(h.id, { mergeBehind: rest });
          store.note(h.id, `${b.entityKey} ${how}; your merge hold stays until ${rest.join(", ")} ${rest.length === 1 ? "does" : "do"} too.`, true);
          continue;
        }
        store.patch(h.id, { mergeBehind: [] });
        store.note(h.id, `Merge hold lifted: ${b.entityKey}, which it waited behind, ${how}. The plugin files the Merge item again on the next look if the pull request is still open with its gate met.`);
        scheduleReconcile(h.id);
      }
      bb.log.info(`stewards: ${b.entityKey} ${how}; released the merge hold on ${waiting.map((h) => h.entityKey).join(", ")}`);
    }

    /**
     * The work `b` was holding others behind has landed (`how`: its pull
     * requests merged, or it ended): take it off every hold that waits behind
     * it, lift the holds with nothing left to wait for, wake those stewards,
     * and tell the project steward. A lifted binding that now overlaps other
     * work asks to be scheduled again on its next look.
     */
    async function releaseBehind(b: Binding, how: string): Promise<void> {
      // A stack-wait on this binding lifts on the same endings: the work it
      // waited to stack on will not open a pull request now.
      await releaseStack(b, b.lastSnapshot, how);
      // A merge hold on this binding lifts on the same endings (BB-256).
      await releaseMergeBehind(b, how);
      const key = lc(b.entityKey);
      const waiting = store.open(b.projectId).filter((h) => h.id !== b.id && h.holdBehind.some((k) => lc(k) === key));
      if (waiting.length === 0) return;
      const fullyLifted: Binding[] = [];
      for (const h of waiting) {
        const rest = h.holdBehind.filter((k) => lc(k) !== key);
        if (rest.length > 0) {
          store.patch(h.id, { holdBehind: rest });
          store.note(h.id, `${b.entityKey} ${how}; your hold stays until ${rest.join(", ")} ${rest.length === 1 ? "does" : "do"} too.`, true);
          continue;
        }
        fullyLifted.push(h);
      }
      // One lift can free several waiters that overlap each other. Release the
      // first by priority, then age; re-hold the rest behind it, so two
      // branches do not start into the same files in one tick (BB-54).
      const order = [...fullyLifted].sort((x, y) => (PRIORITY_ORDER[x.priority ?? "normal"] ?? 2) - (PRIORITY_ORDER[y.priority ?? "normal"] ?? 2) || x.createdAt - y.createdAt);
      const released: Binding[] = [];
      const reheld: string[] = [];
      for (const h of order) {
        const blocker = released.find((r) => touchesOverlap(r.touches, h.touches).length > 0);
        if (blocker !== undefined) {
          store.patch(h.id, { holdBehind: [blocker.entityKey] });
          store.note(h.id, `Hold lifted from ${b.entityKey}, but it overlaps ${blocker.entityKey}, which is starting first: the hold now waits behind ${blocker.entityKey} and lifts itself when that work lands.`);
          reheld.push(h.entityKey);
          continue;
        }
        store.patch(h.id, { hold: null, holdBehind: [] });
        store.note(h.id, `Hold lifted: ${b.entityKey}, which it waited behind, ${how}. Rebase anything already branched before building on.`);
        released.push(h);
        scheduleReconcile(h.id);
      }
      const lifted = released.map((h) => h.entityKey);
      bb.log.info(`stewards: ${b.entityKey} ${how}; ${lifted.length === 0 ? "nothing lifted" : `lifted the hold on ${lifted.join(", ")}`}${reheld.length === 0 ? "" : `; re-held ${reheld.join(", ")}`}`);
      if (lifted.length === 0) return;
      // Silent only when the work waited on is finished (its ticket is
      // terminal with its PRs merged, or every linked PR merged and its
      // steward reported no more coming). Anything else wakes the project
      // steward, as today: the plugin cannot tell, so it asks.
      if (b.lastSnapshot !== null && finished(b, b.lastSnapshot)) {
        store.noteProject(
          b.projectId,
          `Lifted the hold on ${lifted.join(", ")}: ${b.entityKey}, which ${lifted.length === 1 ? "it" : "they"} waited behind, ${how}, and its work is finished. No turn needed; this is the record.`,
        );
        return;
      }
      await wakeProject(b.projectId, `${b.entityKey} ${how}`, { digestDue: false, notes: [`Lifted the hold on ${lifted.join(", ")}: ${b.entityKey}, which ${lifted.length === 1 ? "it" : "they"} waited behind, ${how}. Each is woken; one that still overlaps other work asks you to schedule it again.`] });
    }

    const shortSha = (sha: string | null | undefined) => (sha === null || sha === undefined ? "?" : sha.slice(0, 7));

    /**
     * The work a stack-wait waits for now has an open pull request (BB-215),
     * or it is finished/ended without one: lift the wait and wake the waiting
     * steward with the pull request's key and head branch, so it branches from
     * that branch and opens its own pull request with that branch as the base.
     * A `behind` hold lifts when its target merges or ends; this one lifts the
     * moment the pull request opens, which is what lets a stacked ticket start
     * before the base lands. The `how` argument is for the end paths, which
     * know why the target is gone; the level check judges `finished` instead,
     * so a hold placed after the target already ended still lifts.
     */
    async function releaseStack(target: Binding, observed: Observed | null, how?: string): Promise<void> {
      const open = observed === null ? null : openPull(target, observed);
      const done =
        how ??
        (open === null && observed !== null && target.lastSnapshot !== null && finished(target, target.lastSnapshot) ? howFinished(target) : null);
      if (open === null && done === null) return;
      const key = lc(target.entityKey);
      const waiting = store.open(target.projectId).filter((h) => h.id !== target.id && h.holdStack.some((k) => lc(k) === key));
      if (waiting.length === 0) return;
      const branch = open === null ? null : open.head === null || open.head === "" ? null : open.head;
      const where =
        open === null
          ? `${target.entityKey} ${done} without a pull request to stack on`
          : `${target.entityKey}'s pull request ${open.key} is open${branch === null ? "" : ` on ${branch}`}`;
      const start = branch === null ? "Start now on the default branch." : `Start now, branch from ${branch} with that branch as PR base.`;
      // One lift can free several waiters that overlap each other. Release the
      // first by priority, then age; re-stack the rest on it, so two branches
      // do not start into the same files in one tick (BB-215).
      const order = [...waiting].sort((x, y) => (PRIORITY_ORDER[x.priority ?? "normal"] ?? 2) - (PRIORITY_ORDER[y.priority ?? "normal"] ?? 2) || x.createdAt - y.createdAt);
      const released: Binding[] = [];
      for (const h of order) {
        const rest = h.holdStack.filter((k) => lc(k) !== key);
        if (rest.length > 0) {
          store.patch(h.id, { holdStack: rest });
          store.note(h.id, `${where}; your stack-wait stays until ${rest.join(", ")} ${rest.length === 1 ? "also has one" : "also have one"}.`, true);
          continue;
        }
        const blocker = released.find((r) => touchesOverlap(r.touches, h.touches).length > 0);
        if (blocker !== undefined) {
          store.patch(h.id, { holdStack: [blocker.entityKey] });
          store.note(h.id, `Stack-wait lifted from ${target.entityKey}, but it overlaps ${blocker.entityKey}, which is starting first: the wait now stacks on ${blocker.entityKey} and lifts when its pull request opens.`, true);
          continue;
        }
        store.patch(h.id, { hold: null, holdStack: [] });
        store.note(h.id, `Stack-wait lifted: ${where}. ${start}`);
        scheduleReconcile(h.id);
        released.push(h);
      }
      const lifted = released.map((h) => h.entityKey);
      bb.log.info(`stewards: ${target.entityKey} ${open === null ? done : `opened ${open.key}`}; ${lifted.length === 0 ? "no stack-wait lifted" : `released the stack-wait on ${lifted.join(", ")}`}`);
    }

    /**
     * The approval helpers bound to this server's store, GitHub writer and
     * snapshot readers (approvals.ts). The plugin's approval code lives there
     * so a change to it is always the owner's (BB-153).
     */
    const approvalsCtx: ApprovalsContext = {
      store,
      github,
      now,
      shortSha,
      scheduleReconcile,
      snapshot,
      linkedPulls,
      threadInfo,
      sendTo,
      wakeProject,
      pullChangedFiles,
      loadDecisions: async (projectId) => (await loadConfig(projectId))?.file.bigDecisions ?? [],
      observedPulls,
      mechanicalStatus: patchMechanicalStatus,
    };

    /** Every pull request a binding observes: a pr binding's own entity, and a ticket's linked pulls. */
    function observedPulls(b: Binding, observed: Observed): EntitySnapshot[] {
      const own = observed.entity.pull === null ? [] : [observed.entity];
      return b.kind === "ticket" ? [...own, ...observed.pulls] : own;
    }

    /**
     * Whether a linked pull request belongs to a ticket binding rather than
     * merely mentioning it (BB-239). A pull request cross-referenced in the
     * ticket's timeline but belonging to another ticket's binding files no
     * `approve-pr`/`merge` item and raises no approval escalation here; it
     * stays in the wake as context. It belongs when a worker of the binding
     * reported or opened it (`ownPulls`), or its head branch or title names
     * the ticket: the worker branch convention `bb/<owner>-<repo>-<n>-…`, or
     * the ticket named in the title (`(#<n>)` for a GitHub issue, the key
     * `ENG-12`/`BB-239` for a Linear ticket). The closing set is not in the
     * snapshot contract, so a closing pull request with neither a worker nor a
     * naming branch or title is not recognized in this first cut (BB-239 spec).
     */
    function pullBelongsToTicket(b: Binding, pull: EntitySnapshot, ownPulls: ReadonlySet<string>): boolean {
      const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      if (ownPulls.has(lc(pull.key)) || (pull.url !== null && ownPulls.has(lc(pull.url)))) return true;
      const key = b.entityKey.trim();
      const number = /(\d+)$/u.exec(key)?.[1] ?? null;
      if (number === null) return false;
      const slug = lc(key).replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
      const head = lc(pull.pull?.head ?? "");
      if (head !== "" && slug !== "" && new RegExp(`(?:^|[-/])${escape(slug)}(?:[-/]|$)`, "u").test(head)) return true;
      const title = pull.title ?? "";
      // A GitHub issue's worker titles its pull request with the issue number,
      // and only a pull request in the issue's own repo counts (a different
      // repo's #12 is not this ticket). A Linear ticket's title names the key
      // (e.g. "… (ENG-12)"); `(#<n>)` there would be a GitHub number and could
      // match another repo's pull request (BB-239 review round 1).
      const repo = key.includes("#") ? key.slice(0, key.indexOf("#")) : "";
      if (b.source === "github") return title.includes(`(#${number})`) && lc(pull.unit) === lc(repo);
      return new RegExp(`(?:^|[^a-z0-9])${escape(lc(key))}(?:[^a-z0-9]|$)`, "u").test(lc(title));
    }

    /**
     * The schedule wake's pull request facts (BB-89): how many of a binding's
     * linked pull requests are open and how many merged, and whether its
     * steward has reported that no more are coming. Facts only; the wake draws
     * no conclusion from them.
     */
    function pullFacts(b: Binding, observed: Observed | null, complete: boolean): string {
      if (observed === null) return "pull requests not read, no more pull requests: not reported";
      const pulls = observedPulls(b, observed);
      const merged = pulls.filter((p) => p.pull?.merged === true).length;
      const open = pulls.filter((p) => p.pull?.merged !== true && lc(p.state) !== "closed").length;
      const facts = `${open} open, ${merged} merged, no more pull requests: ${b.noMorePulls === true ? "reported" : "not reported"}`;
      return complete ? facts : `${facts} (read incomplete)`;
    }

    /**
     * File or refresh the user's `approve-spec` need for a binding. The plugin
     * files it when the gate waits and the approver is the user (`approval: user`),
     * and when the project steward forwards an `approval` escalation to the user:
     * a forwarded approval is the user's to decide exactly as `approval: user` is.
     * Deduped by (binding, kind, url), so the escalation that asked for it is
     * linked in `data.escalationId` rather than a second item filed.
     */
    function fileApproveSpecNeed(b: Binding, entity: EntitySnapshot, escalationId: string | null): void {
      const specHash = specHashFor(b, entity);
      // BB-251: the request lists the open assumptions it covers. The list is
      // captured when the request is made or updated (the spec changed); a
      // routine refresh of the same spec keeps the list it was shown with, so an
      // assumption recorded after the request was shown stays open.
      const existing = store.openNeeds(b.id).find((n) => n.kind === "approve-spec" && n.url === (b.url ?? ""));
      const carried = existing === undefined || existing.data.specHash !== specHash ? null : z.array(z.string()).safeParse(existing.data.assumptionIds);
      const assumptionIds = carried !== null && carried.success ? carried.data : store.openAssumptions(b.id).map((a) => a.id);
      // The item lists the open assumptions it covers, so the approver sees
      // them before pressing Approve. A corrected one is no longer open and
      // drops off the list; a new one recorded after the request was shown is
      // not in `assumptionIds`, so it stays open.
      const openById = new Map(store.openAssumptions(b.id).map((a) => [a.id, a]));
      const covered = assumptionIds.map((id) => openById.get(id)).filter((a): a is NonNullable<typeof a> => a !== undefined);
      const how =
        "The ready checklist is met and the ticket is substantial. Approve records the approval on the gate; Decline remembers this spec as declined until it changes." +
        (covered.length === 0 ? "" : ` It covers ${covered.length} open assumption${covered.length === 1 ? "" : "s"}: ${covered.map((a) => `${a.id} — ${a.text}`).join("; ")}.`);
      // BB-249: a re-approval after an edit leads with a diff from the text the
      // last approval pinned. A prior approval with no `approvedText` (recorded
      // before the field existed) files the item as a first approval.
      const currentText = specTextFor(b, entity);
      const prior = b.ready.approval;
      const approvedText = prior?.approvedText ?? b.ready.voidedApprovedText;
      const approvedAt = prior?.at ?? b.ready.voidedApprovedAt;
      const reapproval = approvedText !== null && approvedAt !== null ? specDiff(approvedText, currentText) : null;
      const specComment = reapproval === null || approvedAt === null ? null : newestEditComment(entity, b.threadId, isUserThread, approvedAt);
      const what =
        reapproval === null
          ? `Approve ${b.entityKey}'s spec`
          : reapproval.changedLines === 0
            ? "Re-approve: no visible change"
            : `Re-approve: ${reapproval.changedLines} line${reapproval.changedLines === 1 ? "" : "s"} changed`;
      store.fileNeed({
        bindingId: b.id,
        kind: "approve-spec",
        url: b.url ?? "",
        what,
        how,
        data: {
          specHash,
          ...(escalationId === null ? {} : { escalationId }),
          assumptionIds,
          ...(reapproval === null ? {} : { specDiff: reapproval.diff, specChangedLines: reapproval.changedLines, specCommentUrl: specComment?.url ?? null, specFullText: currentText }),
        },
        filedBy: "plugin",
      });
    }

    /**
     * Approve or decline a binding's spec as the user, in one step: record the
     * verdict on the gate and close the `approve-spec` need, which resolves the
     * open `approval` escalations that asked for it (the `steward_update { approve }`
     * path). Returns the closure for the steward's wake and the escalations that
     * were with the user, for the project steward's wake. `where` reads as
     * "on the Stewards page" or "from a thread".
     */
    function recordSpecVerdict(b: Binding, action: "approve" | "decline", entity: EntitySnapshot, text: string | null, where: string): { closure: string; forwarded: Escalation[] } {
      const forwarded = store.openEscalations(b.id).filter((x) => x.kind === "approval" && x.route === "user" && x.resolutionKind !== "approve-decline");
      const hash = specHashFor(b, entity);
      const said = text === null ? "" : `: "${text}"`;
      if (action === "approve") {
        store.approve(b.id, { at: now(), specHash: hash, by: "user", approvedText: specTextFor(b, entity) }, `Approved by the user ${where}${said}`, "user");
        return { closure: `The user approved ${b.entityKey}'s spec ${where}${text === null ? "" : `: ${text}`}.`, forwarded };
      }
      store.decline(b.id, hash, `Declined by the user ${where}${said}`, "user");
      return { closure: `The user declined ${b.entityKey}'s spec ${where}${text === null ? "" : `: ${text}`}.`, forwarded };
    }

    /**
     * The escalation a page close of `need` resolves: the row itself, and the
     * escalation the project steward forwarded it from when it is a question
     * (BB-51). Gathered before the close so the project steward's wake names
     * both.
     */
    function forwardedFor(need: Need): Escalation[] {
      const x = store.escalation(need.id);
      if (x === null) return [];
      const out: Escalation[] = [];
      if (x.forwardedFrom !== null) {
        const parent = store.escalation(x.forwardedFrom);
        if (parent !== null) out.push(parent);
      }
      out.push(x);
      return out;
    }

    /**
     * The project steward forwarded an escalation to the user, so it holds it
     * until the user answers. Tell it when the answer lands on the page or from
     * a thread, naming the closure, so it is not left holding a resolved one.
     * `lessonCandidate` is false when the user closed it without an answer, so
     * the lesson nudge does not read oddly against an empty one.
     */
    async function wakeProjectOnForwardedAnswer(b: Binding, closure: string, forwarded: Escalation[], lessonCandidate = true): Promise<void> {
      if (forwarded.length === 0) return;
      // BB-35 step 4: one after-the-fact follow-up when the user's answer went
      // against the recommendation. Re-read each escalation, since the answer
      // just set the ask on it; `rationaleAsked` keeps it to one.
      const followUps: string[] = [];
      for (const f of forwarded) {
        const fresh = store.escalation(f.id);
        if (fresh === null || fresh.rationaleAsked || fresh.rationaleGiven || fresh.rationaleWanted !== AFTER_THE_FACT_RATIONALE_WHY) continue;
        store.markEscalationRationaleAsked(fresh.id);
        followUps.push(`The user's answer went against your recommendation on ${fresh.id}. Ask them once, in this thread, why — one follow-up — then record their reasoning as a lesson candidate with steward_update { lesson: { text, file, scope } }.`);
      }
      await wakeProject(b.projectId, `${b.entityKey}'s forwarded escalation was answered`, {
        digestDue: false,
        notes: [
          `${closure} ${forwarded.map((x) => `Escalation ${x.id}`).join(", ")} ${forwarded.length === 1 ? "is" : "are"} resolved.`,
          ...(lessonCandidate ? ["If the answer is a general judgement the playbook should carry, record it as a lesson with steward_update { lesson: { text, file, scope } }."] : []),
          ...followUps,
        ],
      });
    }

    /**
     * BB-231: a gate item (approve-spec, approve-pr, merge) filed on a binding
     * that already has an open route-`user` escalation or question may be the
     * same ask. Ask the project steward one yes/no: does the new item cover
     * it? The plugin's item always survives; a yes resolves the escalation as
     * covered (`steward_update { forward, coveredBy }`). Fired only when the
     * item is newly filed, so it is not asked again on every look. The item's
     * own linked escalation (its `data.escalationId`) is never a candidate.
     */
    async function noteGateItemCoverage(b: Binding, item: Need): Promise<void> {
      // A gate item can be closed and refiled with a new id (a `merge` item
      // after a push). If a closed item of the same kind and url was filed
      // after a candidate was created, the pair was already asked, so it is not
      // asked again even though the new item has a new id.
      const history = store.needs(b.id, true);
      const candidates = userItemsFor(b).filter(
        (x) =>
          (x.source === "escalation" || x.source === "question") &&
          !history.some((n) => n.status === "done" && n.kind === item.kind && n.url === item.url && n.createdAt > x.createdAt),
      );
      if (candidates.length === 0) return;
      await wakeProject(b.projectId, `a gate item was filed on ${b.entityKey} with an open escalation`, {
        digestDue: false,
        notes: [
          `${item.id} (${item.kind}) was filed on ${b.entityKey}: ${item.what}`,
          ...candidates.map((c) => `It may cover ${c.id} (${c.source === "question" ? "question" : c.kind}): ${c.text}`),
          `Does the new item cover ${candidates.length === 1 ? "it" : "them"}? If yes, resolve each as covered — for an escalation, steward_update { binding: "${b.entityKey}", resolve: "<the escalation>", coveredBy: "${item.id}" }; for a question, steward_update { binding: "${b.entityKey}", resolve: "<question id>", answer: "Covered by ${item.id}." }. If not, leave it open; the plugin's item always survives.`,
        ],
      });
    }

    /**
     * File, refresh and close the plugin's "needs you" items from a snapshot:
     * `approve-spec` (the user's approval of the ready gate), and, per observed
     * pull request, `approve-pr` and `merge`. The conditions are recomputed on
     * every look, so the page only offers a button while it is true. The
     * `approve-pr` half lives in approvals.ts (BB-153).
     */
    async function syncNeeds(b: Binding, observed: Observed, playbook: Playbook, changes: Change[] = []): Promise<MechanicalEvent[]> {
      // BB-203: an `approve-pr` item this call closes because an approval is
      // present is a mechanical status event. The page and project-steward
      // paths write it at once; this catches an approval observed on GitHub.
      const events: MechanicalEvent[] = [];
      // BB-231: the gate items open before this look, so a newly filed one can
      // ask the project steward whether it covers an open escalation.
      const needsBefore = new Set(store.openNeeds(b.id).map((n) => n.id));
      const mode = playbook.ready?.approval ?? null;
      const current = specHashFor(b, observed.entity);
      const gate = gateState(playbook, b.ready, current);
      // A forwarded approval escalation is with the user, so the page's
      // Approve/Decline answers it; `approval: user` is the same wait, filed by
      // the plugin. Either way the need is the same item, linked to the
      // escalation when one is open.
      const forwarded = store.openEscalations(b.id).find((x) => x.kind === "approval" && x.route === "user" && x.resolutionKind !== "approve-decline") ?? null;
      const wantsSpec = (mode === "user" || forwarded !== null) && approvalWanted(gate) && b.endedAt === null && b.ending === null && b.ready.declinedSpecHash !== current;
      if (wantsSpec) {
        fileApproveSpecNeed(b, observed.entity, forwarded?.id ?? null);
      } else {
        const why = gate.passed ? "The spec is approved." : !gate.checklistMet ? "Withdrawn: the ready checklist is no longer met." : !gate.approvalNeeded ? "Withdrawn: the ticket is not substantial." : "Withdrawn.";
        store.closeNeeds(b.id, "approve-spec", why);
        // The gate no longer waits, so a forwarded request is withdrawn with
        // it rather than left open for the page's raw-escalation prose row.
        if (forwarded !== null) store.resolve(forwarded.id, why);
      }

      let approvalRaised = false;
      const config = await loadConfig(b.projectId);
      const decisions = config?.file.bigDecisions ?? [];
      const ownerLogin = config?.githubLogin ?? null;
      // BB-239: the pull requests a worker of this binding opened or reported.
      // A ticket's other linked pull requests (GitHub cross-references) only
      // mention it and must not file gate items here.
      const ownPulls = b.kind === "ticket" ? await ownPullKeys(b, store.workers(b.id), observed) : null;
      // BB-266: the binding's open own pull requests. A finished worker keeps
      // deferring the plugin merge while more than one is open: a parked
      // worker that still owns another pull request is mid-sequence (a
      // cross-repo ticket lands the consumed repo first), so the plugin must
      // not merge out of order or retire the worker that owns the rest.
      const openOwnPulls = observedPulls(b, observed).filter((p) => (ownPulls === null || pullBelongsToTicket(b, p, ownPulls)) && p.pull?.merged !== true && lc(p.state) !== "closed");
      const parkedWorkerOwnsAnother = openOwnPulls.length > 1 && store.workers(b.id).some((w) => w.status === "finished");
      // BB-264: the steward's own merge holds name open bindings in this
      // project, or a stacked base pull request by its key; the plugin's
      // derived stacked-PR holds are recomputed from the base pull requests on
      // every look. An entry that names neither an open binding nor an open
      // pull request is dropped, so a stale hold lifts itself.
      const userMergeBehind: string[] = [];
      for (const k of b.mergeBehind) {
        const target = store.find(k, b.projectId);
        if (target !== null && target.endedAt === null && target.id !== b.id) {
          userMergeBehind.push(k);
          continue;
        }
        const ref = parsePullRef(k);
        const pull = ref === null ? null : await snapshot("github", `${ref.repo}#${ref.number}`).catch(() => null);
        if (pull !== null && pull.kind === "pull" && lc(pull.state) !== "closed" && pull.pull?.merged !== true) userMergeBehind.push(k);
      }
      const derivedMergeBehind: string[] = [];
      // A hold already on the binding is not news: the "Merge held" wake fires
      // only on the look that first derives it, so an open base that stays open
      // does not wake the steward on every doorbell and sweep.
      const heldBefore = new Set(b.mergeBehind.map((k) => lc(k)));
      // The base pull requests a retarget wake has already been sent for
      // (BB-264), so the retarget wake is once per base pull request.
      const retargetPulls = [...b.retargetPulls];
      const retargetBefore = new Set(retargetPulls.map((k) => lc(k)));
      for (const pull of observedPulls(b, observed)) {
        const url = pull.url ?? pull.key;
        if (ownPulls !== null && !pullBelongsToTicket(b, pull, ownPulls)) {
          // The pull request belongs to another ticket's binding; close any
          // item filed before this rule and leave it in the wake as context.
          store.closeNeedByKey(b.id, "approve-pr", url, "The pull request belongs to another ticket.");
          store.closeNeedByKey(b.id, "merge", url, "The pull request belongs to another ticket.");
          const esc = store.openEscalations(b.id).find((x) => x.kind === "approval" && x.url === url && x.resolutionKind === "approve-decline") ?? null;
          if (esc !== null) store.resolve(esc.id, "The pull request belongs to another ticket.");
          continue;
        }
        const hadApprove = store.openNeeds(b.id).some((n) => n.kind === "approve-pr" && n.url === url);
        const { gate: g, closed, approvalRaised: raised } = await syncPullApproval(approvalsCtx, b, pull, decisions);
        if (raised) approvalRaised = true;
        if (hadApprove && !closed && (g.ownerApproved || g.projectApproved) && !store.openNeeds(b.id).some((n) => n.kind === "approve-pr" && n.url === url)) {
          events.push({ kind: "approved", pull: pull.key });
        }
        if (closed) {
          store.closeNeedByKey(b.id, "merge", url, "The pull request is closed.");
          continue;
        }
        // BB-170: on a teammate's pull request (a review steward), the owner's
        // approval is their last step and the author merges, so the plugin
        // files no Merge item. A review binding is a teammate's pull request by
        // adoption, so this does not depend on reading the login; the owner's
        // own agent PRs and the dependency watch's bot PRs keep the item, and a
        // playbook's `owner-merges: true` opts back in. A steward-filed item (a
        // refused merge) is always left alone.
        const dependencyBot = pull.author !== null && DEPENDENCY_BOTS.has(lc(pull.author));
        const foreignOwner =
          !dependencyBot &&
          !playbook.ownerMerges &&
          (b.kind === "review" || (b.kind === "pr" && pull.author !== null && ownerLogin !== null && lc(pull.author) !== lc(ownerLogin)));
        if (g.gateMet) {
          // A steward's own merge item (a refused merge) is left alone while a
          // worker still runs; the plugin files its own only when none does.
          // BB-256: a standing merge hold is not a stuck loop, so the plugin
          // files no Merge item and closes its own if one is open. A
          // steward-filed item (a refused merge) is always left alone.
          // BB-264: an open base pull request is the same hold, derived from
          // the pull request's base rather than reported.
          const ref = parsePullRef(pull.url ?? pull.key) ?? parsePullRef(url);
          const base = bindingMayMerge(b, playbook) && ref !== null && !foreignOwner ? await pullBaseDisposition(ref, pull) : null;
          const openBase = base !== null && base.kind === "open" ? base : null;
          const mergedBase = base !== null && base.kind === "merged" ? base : null;
          if (openBase !== null) derivedMergeBehind.push(openBase.key);
          const mergeHeld = userMergeBehind.length > 0 || openBase !== null;
          if (foreignOwner) {
            const open = store.openNeeds(b.id).find((n) => n.kind === "merge" && n.url === url && n.filedBy === "plugin");
            if (open !== undefined) store.closeNeed(open.id, "A teammate's pull request: its author merges after the owner's approval.");
          } else if (mergeHeld) {
            const open = store.openNeeds(b.id).find((n) => n.kind === "merge" && n.url === url && n.filedBy === "plugin");
            if (open !== undefined) {
              const keys = mergeHoldKeys(b);
              const held = [...userMergeBehind, ...(openBase === null ? [] : [openBase.key])];
              store.closeNeed(open.id, `held behind ${(keys.length > 0 ? keys : held).join(", ")}`);
            }
            if (openBase !== null && !heldBefore.has(lc(openBase.key))) {
              changes.push({ text: `Merge held: ${pull.key} is stacked on ${openBase.key}, which is still open. The plugin files no Merge item; it merges once the base lands and the pull request is retargeted to the default branch.`, actionable: true });
            }
          } else if (mergedBase !== null) {
            // BB-264: GitHub does not retarget a stacked pull request when its
            // base merges (the branch survives), so the base is the head of a
            // merged pull request. File no Merge item and wake the steward once
            // per base pull request to retarget it; the next look sees the
            // default branch and merges. The rebase and push come first so the
            // plugin never merges an un-rebased head while the checks of the
            // old one are still green.
            const open = store.openNeeds(b.id).find((n) => n.kind === "merge" && n.url === url && n.filedBy === "plugin");
            if (open !== undefined) store.closeNeed(open.id, `The base ${mergedBase.key} has merged; retarget to the default branch.`);
            if (!retargetBefore.has(lc(mergedBase.key))) {
              const prRef = ref === null ? pull.key : `${ref.repo}#${ref.number}`;
              changes.push({ text: `Retarget ${pull.key}: its base ${mergedBase.key} has merged. Rebase it onto the default branch (\`git fetch origin && git rebase --onto origin/<default> <old base head>\`), push, then retarget it (\`gh pr edit ${prRef} --base <default>\`); the plugin merges it once the default branch is its base and the checks on the new head are green.`, actionable: true });
              retargetPulls.push(mergedBase.key);
              retargetBefore.add(lc(mergedBase.key));
            }
          } else if (store.openNeeds(b.id).some((n) => n.kind === "merge" && n.url === url && n.filedBy !== "plugin")) {
            // A steward-filed Merge item is a hand-off to a person (a worker
            // whose permission system refused the merge, or a refused plugin
            // merge): leave it alone and do not merge over it (BB-170/BB-257).
          } else if (runningWorkerReason(store.workers(b.id)) === null && !parkedWorkerOwnsAnother) {
            // Pause stewards is the kill switch: while it is on, the plugin
            // files the item a person can press but never merges (BB-257).
            const paused = (await settings.get()).paused;
            // BB-257: only the repository's default branch is merged by the
            // plugin. A stacked pull request is held above, so it never
            // squash-merges into a base branch that may be dead.
            if (ref !== null && base !== null && base.kind === "default" && !paused) {
              // BB-257: the plugin takes the step the Merge item used to ask a
              // person for. A refusal for this exact gate is recorded on the
              // binding and not retried until the head or a gate input changes.
              if (mergeRefusalFor(b, g) === null) {
                const result = await mergePullRequest(b, ref, pull, "by the plugin");
                if (result.ok) {
                  // The note goes into this look's changes as well as the
                  // binding, so the wake that clears `pending` still carries
                  // it; a merge found by the next look reads the same as a
                  // worker's merge (BB-257).
                  const note = `${pull.key} was merged by the plugin. ${result.summary}`;
                  store.note(b.id, note);
                  changes.push({ text: note, actionable: true });
                  scheduleReconcile(b.id);
                  // BB-266: the approval this merge consumed was what the
                  // binding's parked workers waited on, so retire them the way
                  // a consumed finish is retired; one that asked the steward a
                  // question stays visible. Only when no other own pull
                  // request is still open, so the worker that owns the rest is
                  // not retired mid-sequence.
                  if (openOwnPulls.length <= 1) await archiveParkedWorkers(b);
                } else if (isHeadMovedRefusal(result.message)) {
                  // A push landed between the look and the merge. GitHub
                  // refused it with 409; the next look judges the new head.
                  bb.log.warn(`stewards: plugin merge of ${pull.key} raced a push; waiting for the next look`);
                } else if (result.message.startsWith("GitHub refused the merge:")) {
                  await raiseMergeRefusal(b, pull, g, result.message, changes);
                } else {
                  // The gate or a worker changed between the look and the
                  // merge: file nothing and let the next look decide.
                  bb.log.warn(`stewards: plugin merge of ${pull.key} not attempted: ${result.message}`);
                }
              }
            } else {
              store.fileNeed({
                bindingId: b.id,
                kind: "merge",
                url,
                what: `Merge ${pull.key}`,
                how: `The lane gate is met${g.lane === null ? "" : ` (${g.lane})`}. Merge squash-merges through the server's gh login and posts the merge comment.`,
                data: { sha: g.headSha },
                filedBy: "plugin",
              });
            }
          }
        } else {
          store.closeNeedByKey(b.id, "merge", url, `The gate is not met: ${g.missing ?? "unknown"}.`);
        }
      }
      // BB-264: keep the derived stacked-PR holds in `mergeBehind` so the wake
      // and the sidebar show them like a reported hold, and drop one the look
      // no longer derives (the base landed, closed, or was retargeted).
      const nextMergeBehind = [...new Set([...userMergeBehind, ...derivedMergeBehind])];
      if (nextMergeBehind.length !== b.mergeBehind.length || nextMergeBehind.some((k, i) => k !== b.mergeBehind[i])) {
        b = store.patch(b.id, { mergeBehind: nextMergeBehind });
      }
      const nextRetargetPulls = retargetPulls.slice(-20);
      if (nextRetargetPulls.length !== b.retargetPulls.length || nextRetargetPulls.some((k, i) => k !== b.retargetPulls[i])) {
        b = store.patch(b.id, { retargetPulls: nextRetargetPulls });
      }
      if (approvalRaised) await wakeProject(b.projectId, `an owner-reviewed pull request from ${b.entityKey}`, { digestDue: false });
      // BB-231: a gate item filed this look may cover an open route-`user`
      // escalation or question; ask the project steward once, per new item.
      for (const item of store.openNeeds(b.id)) {
        if (needsBefore.has(item.id) || !(item.kind === "approve-spec" || item.kind === "approve-pr" || item.kind === "merge")) continue;
        await noteGateItemCoverage(b, item);
        // BB-253: the item is newly filed this look, so this is its first and
        // only push; the next look has it in `needsBefore` and stays quiet.
        const text = gatePushText(b, item);
        if (text !== null) await pushNeed(b, { id: item.id, ...text, threadId: b.threadId });
      }
      return events;
    }

    /**
     * The approval sync a steward's report runs, on a fresh read (BB-210). The
     * stored snapshot a turn starts from predates a signed `bb-review` marker
     * the steward posted during the turn, so syncing it would miss the marker
     * (or close the `approve-pr` item the reconcile already filed) until the
     * next doorbell or the half-hourly sweep. Re-read the binding's entity and
     * linked pull requests first, so the marker is seen at once; a read that
     * fails falls back to the stored snapshot. The steward is not woken: only
     * the page's item is filed, refreshed or closed.
     */
    async function syncNeedsFresh(b: Binding, playbook: Playbook): Promise<void> {
      // `freshObserved` re-reads the entity and a ticket's linked pull requests,
      // falling back to the stored snapshot when the read fails (BB-54).
      const fresh = await freshObserved(b);
      const observed = fresh?.observed ?? b.lastSnapshot;
      if (observed !== null) await syncNeeds(b, observed, playbook);
    }

    /**
     * The bound entity changed while one of its escalations is with the user:
     * they may have answered on the entity (rewritten the description,
     * commented, moved it) rather than in the project steward's thread. The
     * steward hears the change as usual, but only the project steward holds
     * the escalation, so it is told too, to resolve it or leave it open.
     */
    async function toldWhileWithUser(b: Binding, fresh: Change[]): Promise<void> {
      const withUser = store.openEscalations(b.id).filter((x) => x.route === "user" && x.kind !== "approval" && !x.isQuestion);
      const news = fresh.filter((c) => c.actionable && c.own !== true);
      if (withUser.length === 0 || news.length === 0 || (await settings.get()).paused) return;
      await wakeProject(b.projectId, `${b.entityKey} changed while the user has its escalation`, {
        digestDue: false,
        notes: [
          `What changed on ${b.entityKey}${b.url === null ? "" : ` (${b.url})`}: ${[...new Set(news.map((c) => c.text))].join("; ")}.`,
          ...withUser.map((x) => `Escalation ${x.id} (${x.kind}) is with the user: ${x.question}${x.recommendation === null ? "" : ` Recommendation: ${x.recommendation}`}`),
          `The user may have answered on the entity instead of here. Read the change (\`bb stewards show ${b.entityKey}\`, or the entity itself). If it answers an escalation, record that with steward_update { binding, guidance, resolve }, which wakes the steward; if it does not, leave the escalation open and do not ask the user again.`,
        ],
      });
    }

    async function raise(b: Binding, kind: EscalationKind, question: string, meanwhile: string): Promise<Escalation> {
      const x = store.escalate({ bindingId: b.id, kind, question, meanwhile, route: nextRoute(b, null), recommendation: null });
      await deliver(b, x);
      return x;
    }

    // ---- thread events ---------------------------------------------------------------------------
    //
    // Workers are started by stewards with `--parent-self
    // --parent-notifications off --lifecycle-owner-thread`, so they are
    // recognized here through their lifecycle owner or their parent (the
    // steward) rather than a tool of their own. A worker an older steward left
    // with only the lifecycle owner is still recognized, and a nested worker
    // is never taken for a reviewer: a reviewer's parent is a worker.

    /**
     * The post-spawn safety net: a worker whose provider, model, reasoning
     * level or environment provider differs from the playbook's worker model
     * and the project's environment was started wrong — by a compacted
     * steward, a hand-run command or an old wake. Stop it, note why on the
     * binding with the command that would have been right, and wake the
     * steward. A worker recognized by lifecycle owner or by parent (the
     * steward) both come through here.
     *
     * The model and reasoning level are read from the worker's own first
     * `client/turn/requested` event, the spawn's request as the server
     * resolved it. A freshly created thread is `pending` until its first turn
     * is admitted (minutes, under the concurrency limit), and has no such
     * event yet; `defaultExecutionOptions` would then fall back to the
     * project's remembered defaults for the provider, the owner's own picker
     * choices, and call a correct spawn wrong. So a worker whose first turn
     * has not been dispatched is checked for provider and environment now and
     * for model and reasoning level when it goes active. That wait is kept on
     * the worker row, so a server restart in between does not lose it.
     */
    async function workerExecution(threadId: string): Promise<{ model: string | null; reasoningLevel: string | null } | null> {
      const [row] = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "asc", limit: "1" });
      if (row === undefined) return null;
      const execution = (row.data as { execution?: { model?: string | null; reasoningLevel?: string | null } }).execution;
      return { model: execution?.model ?? null, reasoningLevel: execution?.reasoningLevel ?? null };
    }
    async function validateWorkerSpawn(thread: { id: string; providerId: string }, owner: Binding): Promise<void> {
      const config = await loadConfig(owner.projectId);
      if (config === null) return;
      const playbook = bindingPlaybook(config, owner);
      if (playbook === null || playbook.kind === "ops") return;
      const expected = workerModel(owner, playbook);
      if (expected === null) return;
      const hostId = await projectHost(owner.projectId);
      const expectedEnv = config.source.kind === "native" || hostId === null ? null : MULTI_REPO_ENVIRONMENT_PROVIDER_ID;
      // undefined means "could not read it": validate what is known, never
      // stop a worker over a fact the plugin could not observe.
      let actualModel: string | null = null;
      let actualReasoning: string | null = null;
      let firstTurnDispatched = true;
      try {
        const execution = await workerExecution(thread.id);
        if (execution === null) firstTurnDispatched = false;
        else {
          actualModel = execution.model;
          actualReasoning = execution.reasoningLevel;
        }
      } catch (error) {
        bb.log.warn(`stewards: could not read the model of worker ${thread.id} (${errorMessage(error)}); not validating it`);
      }
      let actualEnv: string | null | undefined;
      try {
        const info = (await bb.sdk.threads.get({ threadId: thread.id, include: "environment" })) as { environment?: { environmentProviderId?: string | null } | null };
        // No environment attached yet is "unknown", not "none".
        actualEnv = info.environment == null ? undefined : (info.environment.environmentProviderId ?? null);
      } catch (error) {
        bb.log.warn(`stewards: could not read the environment of worker ${thread.id} (${errorMessage(error)}); not validating it`);
      }
      const problems: string[] = [];
      if (thread.providerId !== expected.providerId) problems.push(`provider ${thread.providerId === "" ? "(none)" : thread.providerId} instead of ${expected.providerId}`);
      if (actualModel !== null && expected.model !== null && actualModel !== expected.model) problems.push(`model ${actualModel} instead of ${expected.model}`);
      if (actualReasoning !== null && expected.reasoningLevel !== null && actualReasoning !== expected.reasoningLevel) problems.push(`reasoning level ${actualReasoning} instead of ${expected.reasoningLevel}`);
      if (actualEnv !== undefined && expectedEnv !== null && actualEnv !== expectedEnv) problems.push(`environment provider ${actualEnv ?? "(none)"} instead of ${expectedEnv}`);
      if (problems.length === 0) {
        if (!firstTurnDispatched && (expected.model !== null || expected.reasoningLevel !== null)) store.setWorkerModelCheckPending(thread.id, true);
        return;
      }
      store.setWorkerModelCheckPending(thread.id, false);
      const flags = [environmentFlags(config.source, hostId), workerFlags(expected)].filter((f) => f !== "").join(" ");
      store.setWorker(thread.id, "stopped", `Started with the wrong ${problems.join(", ")}; stopped.`, "misspawn");
      await quietly(`stop mis-spawned worker ${thread.id}`, () => bb.sdk.threads.stop({ threadId: thread.id }));
      bb.log.warn(`stewards: stopped worker ${thread.id}: ${problems.join(", ")}`);
      store.note(
        owner.id,
        `Worker ${thread.id} was started with the wrong ${problems.join(", ")} and was stopped. Start it again with:\n    ${spawnCommand({ projectId: owner.projectId, entityKey: owner.entityKey, workerFlags: flags })}`,
      );
      scheduleReconcile(owner.id);
    }

    bb.events.on("thread.created", store.coalescingTool(async ({ thread }) => {
      // Stewards this plugin spawned (a promoted child under its parent) are not workers.
      if (thread.originPluginId === bb.pluginId) return;
      // A worker (its lifecycle owner or parent is a steward) or a reviewer (a
      // child of a worker) is tagged for thread-briefs here, whichever way the
      // skill that spawned it built the command.
      if (spawnedOwner(thread) !== null) await tagThread(thread.id, THREAD_BRIEFS_OFF);
      // A reviewer is a child of a worker. The newest round supersedes the
      // older ones, so they are archived as it is created (BB-47).
      const reviewerOf = reviewerOwner(thread);
      if (reviewerOf !== null) await supersedeOlderReviewers(reviewerOf.threadId, thread.id);
      const owner = [thread.lifecycleOwnerThreadId, thread.parentThreadId].map((t) => (t === null ? null : store.byThread(t))).find((b) => b !== null && b !== undefined && b.endedAt === null);
      if (owner === undefined || owner === null || store.worker(thread.id) !== null) return;
      const limit = (await settings.get()).workerSpawnsPerHour;
      const runaway = store.spawnsSince(owner.id, now() - 3_600_000) >= limit;
      store.addWorker(thread.id, owner.id, thread.title ?? thread.titleFallback ?? thread.id);
      if (!runaway) {
        await validateWorkerSpawn(thread, owner);
        return;
      }
      // The runaway guard: not a budget, a stop for a looping steward.
      store.setWorker(thread.id, "stopped", null, "runaway");
      await quietly(`stop runaway worker ${thread.id}`, () => bb.sdk.threads.stop({ threadId: thread.id }));
      bb.log.warn(`stewards: ${owner.entityKey} started more than ${limit} workers in an hour; stopped ${thread.id}`);
      store.note(owner.id, `Runaway guard: more than ${limit} workers in the last hour, so worker ${thread.id} was stopped. If something is looping, stop and escalate.`);
      scheduleReconcile(owner.id);
    }));

    bb.events.on("thread.idle", store.coalescingTool(async ({ thread, lastAssistantText }) => {
      const worker = store.worker(thread.id);
      if (worker !== null) {
        if (worker.status === "stopped") return;
        const result = lastAssistantText === null ? null : clip(lastAssistantText, 4000);
        store.setWorker(thread.id, "finished", result);
        // The quiet-finish note is what the visible "worker finished" phrase
        // reads. The whole idle handler is one coalesced turn (BB-95), so the
        // signal that refetches is published after the note lands, never before.
        const finished = store.binding(worker.bindingId);
        // BB-152: a `waitingOn` that names this worker is a hand-off the
        // steward is still waiting on. Its finish is a wake, not a quiet note:
        // the steward checks whether what it waited on (a merge, an apply)
        // happened and does it itself or escalates, never re-waiting on a
        // worker that is over.
        const waitedOn = finished !== null && waitingOnNamesWorker(finished.status?.waitingOn ?? null, worker);
        // BB-52 rule 3: a worker that ends its turn waiting on its reviewer,
        // the owner or a build is a quiet note. Only a question, an error
        // report, a gone thread or a lost hand-off makes the turn due; a
        // failed turn comes through thread.failed and wakes on its own. A
        // binding following through is waiting on this worker's result, so its
        // finish is news.
        const needsSteward = finished !== null && (workerQuestion(result) !== null || workerReportedError(result) || followingThrough(finished) || waitedOn);
        if (finished !== null && finished.endedAt === null) store.note(finished.id, workerFinishNote(worker.title, result, waitedOn), !needsSteward);
        await closeRequesterNeed(thread.id);
        // Its turn is over: the reviewers it read (or started and then waited
        // on) have had their round consumed (BB-47).
        await archiveConsumedReviewers(thread.id);
        const b = store.binding(worker.bindingId);
        if (b === null || b.endedAt !== null) return;
        // A quiet finish is consumed here, not by a wake: archive the worker
        // now (BB-47), keeping one that still has a question, a reviewer, or is
        // parked waiting on something that will wake it (BB-52 rule 3).
        if (!needsSteward && !workerWaiting(result)) await archiveFinishedWorkers(b);
        // BB-83: a worker finish asks the idle rule to look at once, without
        // the grace, since its final message is what the steward needs to read.
        // A message that says it is waiting stays quiet as before; the idle
        // rule still catches it after the grace if nothing else does. The
        // reconcile evaluates the predicate on the fresh snapshot and clears
        // this again when the binding is not idle in an active stage.
        if (!workerWaiting(result)) store.patch(b.id, { idleWakeNow: true });
        scheduleReconcile(b.id);
        return;
      }
      const project = store.projectByThread(thread.id);
      if (project !== null) {
        // The digest is the project steward's reply to the nightly wake.
        if (project.digestPending && lastAssistantText !== null && lastAssistantText.trim() !== "") {
          store.patchProject(project.projectId, { digest: clip(lastAssistantText.trim(), 20_000), digestAt: now(), digestPending: false });
        }
        await compactIfLarge(thread.id);
        return;
      }
      const b = store.byThread(thread.id);
      if (b === null) return;
      if (b.endedAt !== null) {
        // The binding ended while this turn was running: finishEnding left the
        // archive to this idle. Clear the flag only once the archive actually
        // happens, so a thread still busy here (or an archive that fails) is
        // retried on the next idle rather than never archived (BB-60).
        if (b.archiveWhenIdle) {
          const info = await threadInfo(thread.id).catch(() => null);
          if (info !== null && info.deletedAt === null && info.archivedAt === null && !busy(info.status)) {
            try {
              await bb.sdk.threads.archive({ threadId: info.id });
              store.patch(b.id, { archiveWhenIdle: false });
            } catch (error) {
              bb.log.warn(`stewards: could not archive ${b.entityKey}'s ended steward: ${errorMessage(error)}`);
            }
          }
        }
        return;
      }
      if (b.ending !== null) {
        // A steward following through ends when a turn finishes without
        // saying something still remains, or without reporting at all.
        if (followingThrough(b) && !b.awaitingReport) {
          await compactIfLarge(thread.id);
          if (store.binding(b.id)!.pending.some((n) => n.quiet !== true)) scheduleReconcile(b.id);
          return;
        }
        // BB-116: the stop turn of a switched-off project may outlive the
        // switch. If the project is on again by now, reopen the binding
        // rather than end it, so a turn that goes idle after the switch
        // cannot strand it.
        if (b.ending === "disabled" && (await loadConfig(b.projectId))?.enabled === true) {
          await serial(`b:${b.id}`, async () => {
            const fresh = store.binding(b.id);
            if (fresh === null || !switchOffHeld(fresh)) return;
            await reopen(fresh, "the project's stewards were switched back on");
          });
          scheduleReconcile(b.id);
          return;
        }
        await serial(`b:${b.id}`, () => finishEnding(store.binding(b.id)!, b.ending!));
        return;
      }
      if (b.awaitingReport) {
        // BB-255: while the plugin's own wake is being retried, a turn that
        // ends without a report is the provider's failure, not the steward's.
        // The hold lapses on its own (backoff plus one requeue), so a retry
        // lost to a restart resumes today's counting.
        const retry = b.wakeRetries[b.threadId ?? ""] ?? null;
        if (retry !== null && retry.holdUntil > now()) {
          bb.log.debug(`stewards: ${b.entityKey}'s wake is being retried; not counting a missed report`);
        } else {
          const missed = b.missedReports + 1;
          store.patch(b.id, { awaitingReport: false, missedReports: missed });
          if (retry !== null) await clearWakeRetry(thread.id);
          bb.log.warn(`stewards: ${b.entityKey}'s turn ended without steward_report (${missed} in a row)`);
          if (missed >= timing.missedReportsForStuck && !store.openEscalations(b.id).some((x) => x.kind === "stuck")) {
            await raise(b, "stuck", `The steward ended ${missed} turns in a row without a status report. Look at the thread and say how to continue.`, "Waiting.");
          }
        }
      }
      // Compaction makes the thread busy; a wake that finds it so waits as notes for the next idle.
      await compactIfLarge(thread.id);
      const after = store.binding(b.id)!;
      if (after.pending.some((n) => n.quiet !== true)) scheduleReconcile(b.id);
    }));

    /**
     * The questions the binding's workers ended their last turn with. A
     * finished-but-archived worker is brought back so the steward's
     * `bb thread tell` can reach it; one whose thread is gone is reported as
     * gone, needing a fresh worker (BB-14).
     *
     * The plugin cannot catch the tell itself: bb rejects a message to an
     * archived thread (409) before the `message.dispatch` hook runs, so the
     * worker is brought back here, when its question is surfaced, instead. A
     * lookup that fails for any reason but not-found is treated as live:
     * claiming a live worker is gone would tell the steward to spawn a
     * duplicate, while a tell to a really-gone thread just fails.
     *
     * An archived worker is surfaced even though BB-17's `thread.archived`
     * handler has already flipped its record from `finished` to `stopped`:
     * archiving is exactly the case that needs reviving, and reviving restores
     * the record to `finished` so the question stays visible until answered.
     * A worker stopped on purpose, with its thread still there, is not.
     */
    async function collectWorkerQuestions(b: Binding): Promise<WorkerQuestion[]> {
      const out: WorkerQuestion[] = [];
      for (const w of store.workers(b.id)) {
        if (w.status === "running" || w.status === "failed") continue;
        const question = workerQuestion(w.result);
        if (question === null) continue;
        let info: ThreadInfo | null;
        try {
          info = await threadInfo(w.threadId);
        } catch (error) {
          if (w.status !== "finished") continue;
          bb.log.warn(`stewards: could not read worker thread ${w.threadId}; treating it as live: ${errorMessage(error)}`);
          out.push({ threadId: w.threadId, question, state: "live" });
          continue;
        }
        const gone = info === null || info.deletedAt !== null;
        const archived = info !== null && info.deletedAt === null && info.archivedAt !== null;
        // A worker stopped on purpose, with its thread still there, is done.
        if (w.status === "stopped" && !archived && !gone) continue;
        if (archived) {
          await quietly(`unarchive worker ${w.threadId}`, () => bb.sdk.threads.unarchive({ threadId: w.threadId }));
          store.setWorker(w.threadId, "finished", w.result);
          out.push({ threadId: w.threadId, question, state: "revived" });
          continue;
        }
        if (gone) {
          out.push({ threadId: w.threadId, question, state: "gone" });
          continue;
        }
        out.push({ threadId: w.threadId, question, state: "live" });
      }
      return out;
    }

    /**
     * Compact a steward's context once it has grown past the setting, or once
     * a wake about to be sent would push it over (criterion 4), while it is
     * idle. Every wake carries what the steward needs (DESIGN.md §6), so its
     * transcript can go; without this a steward's context only grows, and
     * every later turn reads all of it. A reading already compacted on is not
     * acted on twice, should the provider not report a new one.
     */
    const compactedOn = new Map<string, number>();
    async function compactIfLarge(threadId: string, incomingChars = 0): Promise<boolean> {
      const limit = (await settings.get()).compactAboveTokens;
      if (!(limit > 0)) return false;
      try {
        const [usage] = await bb.sdk.threads.events.list({ threadId, types: ["thread/contextWindowUsage/updated"], order: "desc", limit: "1" });
        const used = (usage?.data as { contextWindowUsage?: { usedTokens?: number | null } } | undefined)?.contextWindowUsage?.usedTokens ?? null;
        if (used === null || !compactDue(used, limit, incomingChars) || compactedOn.get(threadId) === used) return false;
        // A busy thread cannot be compacted; skip it rather than warn on every wake.
        const info = await threadInfo(threadId).catch(() => null);
        if (info === null || info.deletedAt !== null || busy(info.status)) return false;
        compactedOn.set(threadId, used);
        await bb.sdk.threads.compact({ threadId });
        bb.log.info(`stewards: compacted ${threadId} at ${used} context tokens`);
        return true;
      } catch (error) {
        bb.log.warn(`stewards: could not compact ${threadId}: ${errorMessage(error)}`);
        return false;
      }
    }

    /**
     * BB-242: whether a `stopped` worker is one the plugin put down as a
     * consumed finish and may revive when its thread comes back. `archived` is
     * that stop; `stopWorkers`, the runaway guard, a mis-spawn and a deletion
     * carry a reason that keeps it stopped. A record from before the reason
     * existed reads as `null` and is treated like `archived`, so the upgrade
     * also fixes a worker already stopped; the open binding is the other half.
     */
    const revivableWorkerStop = (worker: { stopReason: string | null }): boolean => worker.stopReason === null || worker.stopReason === "archived";

    // A worker that ended its turn to wait (on a watch, a reviewer) is
    // running again when that wakes it; it is working its pull request. A
    // worker the plugin archived after its report was consumed, then
    // unarchived (as the wake text advises), is running again too (BB-242):
    // its next `thread.idle` records the result and wakes the steward, and
    // the sidebar does not read "hand-off lost" while it works.
    bb.events.on("thread.active", store.coalescingTool(async ({ thread }) => {
      // BB-255: the retry's turn started, so its `awaitingReport` hold ends; a
      // later idle counts a missed report as today if the steward still does
      // not report. The retried request id stays recorded for the null-origin
      // failure path.
      const held = bindingForThread(thread.id);
      const pendingRetry = held === null ? null : (held.wakeRetries[thread.id] ?? null);
      if (held !== null && pendingRetry !== null && pendingRetry.holdUntil > 0) setWakeRetry(held, thread.id, { ...pendingRetry, holdUntil: 0 });
      const worker = store.worker(thread.id);
      if (worker === null) return;
      const owner = store.binding(worker.bindingId);
      const openBinding = owner !== null && owner.endedAt === null;
      if (worker.status === "finished") {
        store.setWorker(thread.id, "running", worker.result);
      } else if (worker.status === "stopped" && openBinding && revivableWorkerStop(worker)) {
        store.setWorker(thread.id, "running", worker.result);
        bb.log.info(`stewards: revived worker ${thread.id} (${worker.stopReason ?? "legacy"} stop) on thread.active`);
      }
      // The first turn is dispatched now, so the spawn's model can be read.
      if (worker.modelCheckPending && worker.status !== "stopped") {
        store.setWorkerModelCheckPending(thread.id, false);
        if (owner !== null && owner.endedAt === null) await validateWorkerSpawn(thread, owner);
      }
    }));

    bb.events.on("thread.failed", store.coalescingTool(async ({ thread, error }) => {
      const worker = store.worker(thread.id);
      if (worker === null || !workerInFlight(worker)) return;
      // BB-255: turn.failed is dispatched right after this event and decides
      // whether a plugin-sent spawn message is retried. One macrotask lets it
      // record that decision before the worker is reported failed.
      await new Promise<void>((resolve) => setImmediate(resolve));
      // A retry being decided (the in-flight set) or already recorded (the
      // binding's map) wins over this report; the retry's own failure at the
      // cap marks the worker failed from `giveUpFailedWake`.
      if (wakeRetryInFlight.has(thread.id)) return;
      if (bindingForThread(thread.id)?.wakeRetries[thread.id] !== undefined) return;
      const after = store.worker(thread.id);
      if (after === null || !workerInFlight(after)) return;
      store.setWorker(thread.id, "failed", error);
      await closeRequesterNeed(thread.id);
      store.note(after.bindingId, `Worker "${after.title}" failed: ${error ?? "no detail"}`);
      scheduleReconcile(after.bindingId);
    }));

    /**
     * BB-255: a turn failed. The plugin retries its own failed wake when the
     * provider's failure is one a retry can fix, and surfaces the failure when
     * it cannot. `originPluginId` (bb 0.49) names the sender; a retry's own
     * failure arrives with a null origin, recognised by the request id the
     * plugin recorded when it scheduled that retry.
     */
    bb.events.on("turn.failed", store.coalescingTool(async (event) => {
      const e = event as {
        threadId: string;
        requestId: string;
        errorInfo: ProviderErrorInfo | null;
        rateLimits: ProviderRateLimitState | null;
        attemptNumber: number;
        originPluginId?: string | null;
      };
      const binding = bindingForThread(e.threadId);
      const worker = store.worker(e.threadId);
      const project = store.projectByThread(e.threadId);
      const own = e.originPluginId === bb.pluginId;
      const retry = binding === null ? null : (binding.wakeRetries[e.threadId] ?? null);
      // The chain this failure belongs to: the turn event's `retryOfRequestId`
      // for a retry (whichever plugin queued it), or the request itself for an
      // original. Matching the chain, not one request id, recognises a retry
      // provider-retry won the race to queue.
      const rootRequestId = own ? e.requestId : e.originPluginId === null ? await retryChainRoot(e.threadId, e.requestId) : null;
      const knownRoot = chainRootFor(e.threadId);
      const retried = e.originPluginId === null && rootRequestId !== null && knownRoot !== null && rootRequestId === knownRoot;
      // A foreign or unrecognised null origin is left alone.
      if (!own && !retried) return;
      // At most one pending retry per thread: a repeat of the original failure
      // (or any event but the recorded retry's own) is ignored while one is
      // pending. A newer wake the plugin sent clears the record (see `send`).
      if (!retried && (retry !== null || hasRetriedRequest(e.threadId))) return;
      if (binding === null && project === null) return;
      wakeRetryInFlight.add(e.threadId);
      try {
        const handled = await retryFailedWake({ threadId: e.threadId, requestId: e.requestId, rootRequestId: rootRequestId ?? e.requestId, attemptNumber: e.attemptNumber, errorInfo: e.errorInfo, rateLimits: e.rateLimits, binding, worker });
        if (!handled) await giveUpFailedWake({ threadId: e.threadId, attemptNumber: e.attemptNumber, errorInfo: e.errorInfo, binding, worker });
      } finally {
        wakeRetryInFlight.delete(e.threadId);
      }
    }));

    // An archived steward is still bound: a wake brings it back, whoever
    // archived it. Only a deleted steward thread
    // ends its binding: someone meant it, and the label staying on does not
    // bring it back until it is removed and re-added.
    bb.events.on("thread.archived", ({ thread }) =>
      store.coalescing(() => {
        const worker = store.worker(thread.id);
        // The plugin's own archive of a consumed finish is revivable; an
        // archived running worker is too, so unarchiving brings it back.
        if (worker !== null && workerInFlight(worker)) store.setWorker(thread.id, "stopped", worker.result, "archived");
        if (worker?.modelCheckPending) store.setWorkerModelCheckPending(thread.id, false);
        // An archived requester can no longer import; drop its binding so the
        // page's next Provide spawns a fresh one.
        if (store.secretRequester(thread.id) !== null) store.clearSecretRequester(thread.id);
      }),
    );
    bb.events.on("thread.deleted", ({ thread }) =>
      store.coalescing(() => {
        const worker = store.worker(thread.id);
        if (worker !== null && workerInFlight(worker)) store.setWorker(thread.id, "stopped", worker.result, "deleted");
        if (worker?.modelCheckPending) store.setWorkerModelCheckPending(thread.id, false);
        const b = store.byThread(thread.id);
        if (b === null || b.endedAt !== null) return;
        store.patch(b.id, { threadId: null, endedAt: now(), endReason: "deleted", manualDetach: true, awaitingReport: false, ending: null });
        for (const x of store.openEscalations(b.id)) store.resolve(x.id, "The steward was deleted.");
        bb.log.info(`stewards: ${b.entityKey}'s steward was deleted; detached`);
        pushInterest();
      }),
    );

    // ---- @bb mentions ----------------------------------------------------------------------------------
    //
    // linear hands over a mention bb-gate-hooks routed to this server. It
    // goes to the issue's ticket steward when the issue has an open binding,
    // else to the project steward of the project whose file lists the
    // issue's team; with neither, linear answers the session itself. The
    // steward answers with linear_session_reply.
    //
    // A mention from anyone but the server's owner runs no turn at all: bb
    // core cannot withhold a turn's tools, so the words are parked under a
    // short id and no model sees them. The owner releases exactly one by
    // replying `confirm <id>`; only then is a steward woken, with the
    // request framed as confirmed.

    const PENDING_KEY = "sessions/pending";
    const PENDING_TTL_MS = 7 * 86_400_000;
    /** At most this many requests wait on the owner per session; the oldest go first. */
    const PENDING_MAX = 5;
    const pendingItem = z.object({ id: z.string(), asker: z.string(), text: z.string(), at: z.string() });
    const pendingRecord = z.record(z.string(), z.object({ requests: z.array(pendingItem), savedAt: z.number() }));

    /** A short, easy-to-type id the owner names in a `confirm <id>` reply. */
    function newRequestId(taken: ReadonlySet<string>): string {
      const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
      for (;;) {
        let id = "r-";
        for (const b of randomBytes(4)) id += alphabet[b % alphabet.length];
        if (!taken.has(id)) return id;
      }
    }

    /** The requests waiting on the owner for one session, oldest first. */
    async function pendingRequests(session: string): Promise<PendingRequest[]> {
      const all = pendingRecord.catch({}).parse(await bb.storage.kv.get(PENDING_KEY));
      return all[session]?.requests ?? [];
    }

    /** Serialize the pending list's read-modify-write so two events cannot lose one. */
    let pendingLock: Promise<unknown> = Promise.resolve();
    function withPendingLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = pendingLock.then(fn, fn);
      pendingLock = run.catch(() => undefined);
      return run;
    }

    /** Park a request waiting on the owner, under a fresh short id; returns the stored entry. */
    async function addPending(session: string, request: { asker: string; text: string; at: string }): Promise<PendingRequest> {
      return withPendingLock(async () => {
        const all = pendingRecord.catch({}).parse(await bb.storage.kv.get(PENDING_KEY));
        const before = all[session]?.requests ?? [];
        const item: PendingRequest = { id: newRequestId(new Set(before.map((r) => r.id))), ...request };
        all[session] = { requests: [...before, item].slice(-PENDING_MAX), savedAt: now() };
        for (const [id, p] of Object.entries(all)) if (now() - p.savedAt > PENDING_TTL_MS) delete all[id];
        await bb.storage.kv.set(PENDING_KEY, all);
        return item;
      });
    }

    /** Remove exactly the waiting request with this id; returns it, or null when nothing waits under it. */
    async function takePending(session: string, id: string): Promise<PendingRequest | null> {
      return withPendingLock(async () => {
        const all = pendingRecord.catch({}).parse(await bb.storage.kv.get(PENDING_KEY));
        const before = all[session]?.requests ?? [];
        const found = before.find((r) => r.id === id) ?? null;
        if (found !== null) {
          const rest = before.filter((r) => r.id !== id);
          if (rest.length === 0) delete all[session];
          else all[session] = { requests: rest, savedAt: all[session]!.savedAt };
        }
        for (const [sid, p] of Object.entries(all)) if (now() - p.savedAt > PENDING_TTL_MS) delete all[sid];
        await bb.storage.kv.set(PENDING_KEY, all);
        return found;
      });
    }

    /** Put a claimed request back after a failed delivery; a no-op if it is already waiting. */
    async function restorePending(session: string, item: PendingRequest): Promise<void> {
      return withPendingLock(async () => {
        const all = pendingRecord.catch({}).parse(await bb.storage.kv.get(PENDING_KEY));
        const before = all[session]?.requests ?? [];
        if (before.some((r) => r.id === item.id)) return;
        all[session] = { requests: [...before, item].slice(-PENDING_MAX), savedAt: all[session]?.savedAt ?? now() };
        await bb.storage.kv.set(PENDING_KEY, all);
      });
    }

    /** The id in an owner's `confirm <id>` reply, or null. The whole text, so a vague "sure" names nothing. */
    function parseConfirm(text: string): string | null {
      const m = /^(?:@bb[,\s]+)?confirm[\s:]+(r-[a-z0-9]+)[.!]?$/iu.exec(text.trim());
      return m?.[1]?.toLowerCase() ?? null;
    }

    type SessionRoute = { routed: "ticket" | "project" | "none" | "held"; threadId: string | null; projectId: string | null; requestId: string | null };

    async function onSession(w: SessionWake): Promise<SessionRoute> {
      const trusted = w.fromOwner && !w.comment.untrusted;
      if (!trusted) {
        const held = await addPending(w.session, { asker: w.asker.name, text: w.comment.text, at: w.at });
        bb.log.info(`stewards: held ${w.asker.name}'s @bb mention on ${w.issue.key} as ${held.id}; no turn runs until ${w.owner.name} confirms it`);
        return { routed: "held", threadId: null, projectId: null, requestId: held.id };
      }

      // The owner's own words. A `confirm <id>` releases exactly one waiting
      // request; anything else releases nothing, and while requests wait the
      // plugin re-asks for the id instead of waking a model on a vague word.
      // The request is claimed under the pending lock, so two copies of the
      // same confirmation cannot both wake a steward; it is put back below if
      // no steward can be reached.
      let confirmed: PendingRequest | null = null;
      const named = parseConfirm(w.comment.text);
      if (named !== null) {
        confirmed = await takePending(w.session, named);
        if (confirmed === null) {
          bb.log.info(`stewards: ${w.owner.name} confirmed ${named} on session ${w.session}, but nothing waits under that id`);
          return { routed: "none", threadId: null, projectId: null, requestId: named };
        }
      } else {
        const waiting = await pendingRequests(w.session);
        if (waiting.length > 0) {
          const latest = waiting[waiting.length - 1]!;
          bb.log.info(`stewards: ${w.owner.name} answered session ${w.session} without naming a request; ${waiting.length} still wait, re-asking about ${latest.id}`);
          return { routed: "held", threadId: null, projectId: null, requestId: latest.id };
        }
      }

      try {
        const bound = store.byEntity("linear", w.issue.id);
        const boundConfig = bound === null ? null : await loadConfig(bound.projectId);
        if (bound !== null && bound.endedAt === null && bound.threadId !== null && bound.kind === "ticket" && boundConfig !== null && boundConfig.enabled) {
          const config = boundConfig;
          const sent = { outcome: "failed" as "sent" | "gone" | "failed" | "unavailable" };
          await serial(`b:${bound.id}`, async () => {
            const b = store.binding(bound.id);
            if (b === null || b.endedAt !== null || b.threadId === null) return;
            sent.outcome = await sendTo(
              b.threadId,
              formatSessionWake({ wake: w, role: { kind: "ticket", binding: b }, ...(confirmed === null ? {} : { confirmed }), label: config?.file.label ?? "bb-managed" }),
            );
            // A turn like any wake's: it ends with steward_report, and one
            // waiting on someone else is archived when it is done. Its reason
            // is not a requeue, so a stale one is never counted (BB-154).
            if (sent.outcome === "sent") store.patch(b.id, { awaitingReport: true, wokeAt: now(), lastWakeReason: "changed", archiveWhenIdle: false });
          });
          if (sent.outcome === "sent") {
            bb.log.info(`stewards: an @bb mention on ${w.issue.key} went to its steward${confirmed === null ? "" : ` (confirmed ${confirmed.id})`}`);
            return { routed: "ticket", threadId: bound.threadId, projectId: bound.projectId, requestId: confirmed?.id ?? null };
          }
          // An "unavailable" environment is deliberately left to the
          // binding's next wake: the mention is not lost (the project steward
          // answers it), and the requeue or doorbell respawns the steward
          // through deliverWake (BB-103). Respawning from here would need the
          // binding's config and a fresh wake text anyway.
          bb.log.warn(`stewards: could not reach ${w.issue.key}'s steward with an @bb mention; trying the project steward`);
        }

        const projects = await stewardedProjects();
        const config =
          (bound === null ? undefined : projects.find((p) => p.projectId === bound.projectId && p.file.linear.teams.some((t) => lc(t) === lc(w.issue.teamKey)))) ??
          projects.find((p) => p.file.linear.teams.some((t) => lc(t) === lc(w.issue.teamKey)));
        if (config === undefined) {
          if (confirmed !== null) await restorePending(w.session, confirmed);
          bb.log.info(`stewards: an @bb mention on ${w.issue.key}, but no project lists team ${w.issue.teamKey}`);
          return { routed: "none", threadId: null, projectId: null, requestId: null };
        }
        const threadId = await ensureProjectSteward(config);
        if (threadId === null) throw new Error(`could not start the project steward of ${config.projectId}`);
        const sent = await sendTo(threadId, formatSessionWake({ wake: w, role: { kind: "project" }, ...(confirmed === null ? {} : { confirmed }), label: config.file.label }));
        if (sent !== "sent") throw new Error(`could not message the project steward of ${config.projectId}`);
        bb.log.info(`stewards: an @bb mention on ${w.issue.key} went to the project steward of ${config.projectId}`);
        return { routed: "project", threadId, projectId: config.projectId, requestId: confirmed?.id ?? null };
      } catch (error) {
        if (confirmed !== null) await restorePending(w.session, confirmed);
        throw error;
      }
    }

    // ---- the RPC -------------------------------------------------------------------------------------

    // ---- the lane gate, shared by the page, `bb stewards gate` and `bb stewards merge` (BB-133) ----

    /** One pull request's gate verdict, as `bb stewards gate` prints it. */
    type GateReport = {
      ref: string;
      binding: string;
      headSha: string | null;
      lane: string | null;
      marker: { round: number; sha: string; verdict: string } | null;
      decision: { entry: string | null; decide: "project" | "user"; why: string; listing: string; selfWidening: string[] };
      approval: { kind: "owner-comment" | "owner-review" | "project-marker"; sha: string | null; at: string | null } | null;
      checks: { state: string | null; green: boolean };
      openItems: string[];
      /** Whether the reviewer's marker escalated the pull request to the owner (BB-192). */
      escalated: boolean;
      /** The product reason (BB-207) when the reviewer judged it substantial with no approved spec; null otherwise. */
      reason: "product" | null;
      missing: string | null;
      gateMet: boolean;
    };

    /** The decide-list entry a pull request's changed files match, who decides, and the full listing (BB-133, BB-135). */
    function matchedDecision(files: readonly string[] | null, decisions: readonly BigDecision[]): GateReport["decision"] {
      const explanation = explainDecision(files, decisions);
      return { entry: explanation.winner?.text ?? null, decide: explanation.mark, why: explanation.reason, listing: formatDecisionListing(explanation), selfWidening: explanation.selfWideningFiles };
    }

    /**
     * The approval the lane gate found, with the sha it names: the project
     * steward's `bb-approval` marker (only when its comment id is in the
     * plugin's own records), or the owner's newest unsigned approving review
     * or comment. A comment carries no sha of its own, so it names none.
     */
    function approvalDetail(b: Binding, pull: EntitySnapshot, gate: ReturnType<typeof prGate>): GateReport["approval"] {
      if (gate.projectApproved) {
        const recorded = new Set(projectApprovalsFor(b).filter((r) => r.commentId !== null).map((r) => r.commentId!));
        const marker = latestProjectApprovalMarker(pull.comments, recorded);
        if (marker !== null) return { kind: "project-marker", sha: marker.marker.sha === "" ? null : marker.marker.sha, at: marker.comment.createdAt };
      }
      if (gate.ownerApproved) {
        const at = gate.ownerApprovalAt;
        const review = at === null ? undefined : (pull.pull?.reviews ?? []).find((r) => (r.submittedAt ?? "") === at && r.state.toLowerCase() === "approved");
        if (review !== undefined) return { kind: "owner-review", sha: review.commit, at };
        return { kind: "owner-comment", sha: null, at };
      }
      return null;
    }

    /** The plugin's open items for one pull request: its needs, and the approval escalations on it. */
    function openPullItems(b: Binding, url: string): string[] {
      const items: string[] = [];
      for (const n of store.openNeeds(b.id)) {
        if ((n.kind === "approve-pr" || n.kind === "merge") && (n.url === "" || n.url === url)) items.push(`${n.kind}: ${n.what}`);
      }
      for (const x of store.openEscalations(b.id)) {
        if (x.kind === "approval" && (x.url === null || x.url === url)) items.push(`approval (${x.route}): ${x.question}`);
      }
      return items;
    }

    /**
     * The lane gate's verdict for a pull request, the same computation the
     * page and the wake use, with the pieces the CLI prints: lane, reviewer
     * marker, matched decide-list entry and who decides, the approval found
     * and its sha, checks, and the binding's open items.
     */
    async function gateReport(b: Binding, ref: { repo: string; number: number }, pull: EntitySnapshot): Promise<GateReport> {
      const decisions = (await loadConfig(b.projectId))?.file.bigDecisions ?? [];
      const decision = matchedDecision(await pullChangedFiles(pull), decisions);
      // The verdict is `prGate` with the project's approvals, exactly as the
      // page's Merge item and the wake compute it; the decide-list entry above
      // is what the plugin asks the owner or project steward for (BB-133).
      const gate = prGate(pull, { projectApprovals: projectApprovalsFor(b), ...productGateOptions(b, pull) });
      return {
        ref: `${ref.repo}#${ref.number}`,
        binding: b.entityKey,
        headSha: gate.headSha,
        lane: gate.lane,
        marker: gate.marker === null ? null : { round: gate.marker.round, sha: gate.marker.sha, verdict: gate.marker.verdict },
        decision,
        approval: approvalDetail(b, pull, gate),
        checks: { state: gate.checksState, green: gate.checksGreen },
        openItems: openPullItems(b, pull.url ?? pull.key),
        escalated: gate.escalated,
        reason: gate.reason,
        missing: gate.missing,
        gateMet: gate.gateMet,
      };
    }

    /** The human-readable `bb stewards gate` output; `--json` emits the same fields. */
    function formatGateReport(r: GateReport): string {
      const marker = r.marker === null ? "none" : `round ${r.marker.round} at ${shortSha(r.marker.sha)} (${r.marker.verdict})`;
      const decision = r.decision.entry === null ? `no matching entry (${r.decision.decide}: ${r.decision.why})` : `"${r.decision.entry}" (${r.decision.decide})`;
      const listing = r.decision.listing.split("\n").map((l) => `  ${l}`).join("\n");
      const approval = r.approval === null ? "none" : `${r.approval.kind}${r.approval.sha === null ? "" : ` at ${shortSha(r.approval.sha)}`}${r.approval.at === null ? "" : ` (${r.approval.at})`}`;
      // The reviewer's owner call is printed beside the decide-list winner: the
      // decide list may still name a `project` entry, but the escalation binds
      // the gate to the owner's approval (BB-192).
      const escalation = r.reason === "product" ? "owner — the product reason (a substantial pull request with no approved spec)" : r.escalated ? "owner — the reviewer escalated it" : "none";
      return [
        `${r.ref}${r.binding === "" ? "" : ` — ${r.binding}`}`,
        `head ${shortSha(r.headSha)}; lane ${r.lane ?? "(none)"}`,
        `reviewer: ${marker}`,
        `decide list: ${decision}`,
        `escalation: ${escalation}`,
        listing,
        `approval: ${approval}`,
        `checks: ${r.checks.state ?? "none"}${r.checks.green ? " (green)" : ""}`,
        `open items: ${r.openItems.length === 0 ? "none" : r.openItems.join("; ")}`,
        `gate met: ${r.gateMet ? "yes" : `no — ${r.missing ?? "unknown"}`}`,
      ].join("\n");
    }

    /** The reviewer's approved sha against the lane gate, and the "since then" line when the head moved past it. */
    function mergeSummary(gate: ReturnType<typeof prGate>): string {
      const lane = gate.lane ?? "no-review";
      const approved = gate.marker?.sha ?? gate.headSha;
      const by = gate.projectApproved ? ", approved by the project steward" : gate.ownerApproved ? ", approved by the owner" : "";
      const escalation = gate.reason === "product" ? ", the owner acked the product" : gate.escalated ? ", escalated by the reviewer to the owner" : "";
      return `Merged: ${lane} lane, reviewer approved ${shortSha(approved)}, checks green${by}${escalation}.`;
    }

    function sinceApproval(gate: ReturnType<typeof prGate>): string | null {
      const approved = gate.marker?.sha ?? null;
      if (approved === null || gate.headSha === null || approved === gate.headSha) return null;
      return `since then: the head moved to ${shortSha(gate.headSha)}`;
    }

    const RESTART_NOTE = "Note: merging this moves the pin and stages a restart for every developer's server (Restart now, or in the 03:00–05:00 ET quiet window).";
    /**
     * The restart note for a merge, when the project's guidance says so: one
     * guidance paragraph that names the merged repository, says "restart", and
     * makes an every-merge claim ("any merge … moves the pin"). Requiring all
     * three in one paragraph is what distinguishes `.bb/AGENTS.md`'s "Any merge
     * to `bb-plugins` main … moves the pin … stages a restart" from the
     * paragraphs that merely name the repo (or a sibling repo) and the word
     * "restart" elsewhere in the same section. The note is a fixed sentence the
     * merge comment carries so the worker no longer has to read the guidance
     * itself.
     */
    async function restartNoteFor(projectId: string, repo: string): Promise<string | null> {
      const short = (repo.split("/").at(-1) ?? repo).toLowerCase();
      if (short === "") return null;
      const named = new RegExp(`\\b${short.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u");
      for (const u of await guidanceUnits(projectId)) {
        const text = u.text.toLowerCase();
        if (named.test(text) && /restart/u.test(text) && /\b(?:any|every) merge\b/u.test(text)) return RESTART_NOTE;
      }
      return null;
    }

    /**
     * Dispatch the workflows the project configures for a merged repo
     * (BB-216). Each `.bb/stewards/project.json` `mergeDispatch` entry whose
     * `repo` is the merged one is dispatched through the same GitHub writer
     * the merge used; an entry with no `ref` runs on the workflow repo's
     * default branch. Best-effort: a dispatch that fails is reported and
     * logged, never fails or undoes the merge. With nothing configured for
     * the repo, nothing is dispatched and the merge behaves as before.
     */
    async function mergeDispatches(b: Binding, repo: string): Promise<string[]> {
      const entries = (await loadConfig(b.projectId))?.file.mergeDispatch.filter((d) => lc(d.repo) === lc(repo)) ?? [];
      const lines: string[] = [];
      for (const entry of entries) {
        const workflowRepo = entry.workflowRepo ?? entry.repo;
        const ref = entry.ref ?? (await github.defaultBranch(workflowRepo).catch(() => null)) ?? undefined;
        if (ref === undefined) {
          const line = `dispatch of ${entry.workflow} on ${workflowRepo} failed: could not read its default branch`;
          bb.log.warn(`stewards: ${line}`);
          lines.push(line);
          continue;
        }
        try {
          await github.dispatchWorkflow(workflowRepo, entry.workflow, ref, entry.inputs);
          lines.push(`dispatched ${entry.workflow} on ${workflowRepo}@${ref}`);
        } catch (error) {
          const line = `dispatch of ${entry.workflow} on ${workflowRepo} failed: ${errorMessage(error)}`;
          bb.log.warn(`stewards: ${line}`);
          lines.push(line);
        }
      }
      return lines;
    }

    /**
     * GitHub's refusal when the head moved between the look and the merge
     * (409 "Head branch was modified", BB-257): the next look judges the new
     * head, so it is a wait, not a `stuck` refusal.
     */
    function isHeadMovedRefusal(message: string): boolean {
      // The status after "failed: ", never a bare "409": the pull request's
      // URL path carries its number, so PR #409 would otherwise be read as a
      // head-moved refusal and silently retried on every look (BB-257).
      return /failed: 409\b/u.test(message) || /Head branch was modified/iu.test(message);
    }

    /** Where a pull request's base branch points, for the stacked-PR hold (BB-264). */
    type BaseDisposition =
      | { kind: "default" }
      | { kind: "open"; key: string }
      | { kind: "merged"; key: string }
      | { kind: "other" };

    /**
     * Where a pull request's base branch points (BB-264). The default branch
     * merges through BB-257; the head branch of another open pull request is a
     * merge hold behind that pull request; the head branch of a merged pull
     * request means the stacked pull request must be retargeted to the default
     * branch (GitHub does not retarget it here); a closed or unknown branch is
     * an ordinary pull request. A read of the default branch that fails is not
     * the default (fail closed), so a Merge item is filed.
     */
    async function pullBaseDisposition(ref: { repo: string; number: number }, pull: EntitySnapshot): Promise<BaseDisposition> {
      const base = pull.pull?.base ?? null;
      if (base === null || base === "") return { kind: "other" };
      const def = await github.defaultBranch(ref.repo).catch(() => null);
      if (def !== null && def === base) return { kind: "default" };
      const basePull = await github.pullByHead(ref.repo, base).catch(() => null);
      if (basePull === null) return { kind: "other" };
      if (basePull.merged) return { kind: "merged", key: basePull.key };
      if (lc(basePull.state) === "open") return { kind: "open", key: basePull.key };
      return { kind: "other" };
    }

    /**
     * The key a refused merge is recorded against (BB-257): the head sha and
     * the reviewer marker and lane that made the gate met. A refusal under the
     * same key is not retried, so a conflict or branch protection is one
     * escalation per refusal, not one per look; a push or a new review round
     * changes the key and a fresh attempt follows.
     */
    function mergeAttemptKey(g: ReturnType<typeof prGate>): string {
      return [g.headSha ?? "", markerKey(g.marker) ?? "", g.lane ?? ""].join("|");
    }

    /**
     * The refusal already recorded for this gate, if any: a merge the plugin
     * attempted and GitHub refused, kept as a `stuck` escalation on the
     * binding. Its presence stops a retry loop; the head or a gate input
     * changing makes a new key, so the next look attempts again.
     */
    function mergeRefusalFor(b: Binding, g: ReturnType<typeof prGate>): Escalation | null {
      const key = mergeAttemptKey(g);
      return store.escalations(b.id, 50).find((x) => x.kind === "stuck" && x.data.mergeRefusal === true && x.data.mergeKey === key) ?? null;
    }

    /**
     * Record a merge the plugin attempted and GitHub refused (BB-257): one
     * note on the binding and one `stuck` escalation to the steward, both
     * carrying the head sha and the gate key, so a repeated look does not
     * retry or re-raise.
     */
    async function raiseMergeRefusal(b: Binding, pull: EntitySnapshot, g: ReturnType<typeof prGate>, message: string, changes: Change[]): Promise<void> {
      const key = mergeAttemptKey(g);
      const note = `The plugin could not merge ${pull.key}: ${message}`;
      store.note(b.id, note);
      changes.push({ text: note, actionable: true });
      const x = store.escalate({
        bindingId: b.id,
        kind: "stuck",
        question: `Could not merge ${pull.key}: ${message}`,
        context: `The lane gate was met, so the plugin attempted the merge itself (BB-257), and GitHub refused it. Resolve the conflict or the branch protection and push; the plugin retries when the head sha or a gate input changes, or retry once the cause is fixed with \`bb stewards merge ${pull.key}\`. GitHub said: ${message}`,
        meanwhile: "The plugin does not retry the same gate; the pull request stays open.",
        route: nextRoute(b, null),
        recommendation: null,
        url: pull.url ?? pull.key,
        headSha: g.headSha,
        data: { mergeRefusal: true, mergeKey: key },
        projectId: b.projectId,
      });
      await deliver(b, x);
    }

    /**
     * The one merge path the Stewards page's Merge button and `bb stewards
     * merge` share: recompute the gate with the project's approval records
     * and the pull request's changed files, refuse with the gate's words when
     * it is unmet or a worker's turn is in progress, squash-merge, post the
     * "Merged:" comment, and close the binding's Merge need. The caller reads
     * the pull request fresh and passes it in; `where` names the surface in
     * the need's closure. `exceptThreadId` is the worker that is doing the
     * merging: it is not "another worker running", so a worker may merge its
     * own pull request through the CLI (BB-134). The page passes none, so its
     * Merge item still refuses while any other worker's turn is in progress.
     * A `finished` worker is a pause between turns, not a running one, so it
     * does not block (BB-175).
     */
    async function mergePullRequest(b: Binding, ref: { repo: string; number: number }, pull: EntitySnapshot, where: string, opts: { exceptThreadId?: string } = {}): Promise<{ ok: true; summary: string; mergeSha: string | null } | { ok: false; message: string }> {
      // The same `prGate` with the project's approvals the page's Merge item
      // and the wake use, so the page, `bb stewards gate` and `bb stewards
      // merge` cannot disagree.
      const gate = prGate(pull, { projectApprovals: projectApprovalsFor(b), ...productGateOptions(b, pull) });
      if (!gate.gateMet) return { ok: false, message: `The gate is not met: ${gate.missing ?? "the pull request could not be read"}.` };
      const busy = runningWorkerReason(store.workers(b.id).filter((w) => w.threadId !== opts.exceptThreadId));
      if (busy !== null) return { ok: false, message: `${busy.charAt(0).toUpperCase()}${busy.slice(1)} on this pull request.` };
      const summary = mergeSummary(gate);
      const since = sinceApproval(gate);
      const restart = await restartNoteFor(b.projectId, ref.repo);
      // BB-193: GitHub's own squash subject is "<PR title> (#<n>)" with the PR
      // body as the message; the plugin used to override both with a
      // placeholder and the gate summary. Read them fresh from GitHub and fall
      // back to the old placeholder when the read fails, so a read never blocks
      // a merge whose gate is met. The "Merged:" summary stays in the PR
      // comment, not the commit.
      let commitTitle = `Merge ${pull.key}`;
      let commitBody = summary;
      try {
        const details = await github.pullDetails(ref.repo, ref.number);
        if (details !== null) {
          commitTitle = `${details.title} (#${ref.number})`;
          commitBody = details.body;
        }
      } catch (error) {
        bb.log.warn(`stewards: could not read ${ref.repo}#${ref.number} for the squash merge title: ${errorMessage(error)}`);
      }
      let mergeSha: string | null = null;
      try {
        ({ sha: mergeSha } = await github.squashMerge(ref.repo, ref.number, commitTitle, commitBody, gate.headSha));
      } catch (error) {
        return { ok: false, message: `GitHub refused the merge: ${errorMessage(error)}` };
      }
      // BB-216: after the merge, dispatch the workflows the project configures
      // for this repo. Best-effort: a failed dispatch is reported in the
      // "Merged:" comment and the result, and never fails or undoes the merge.
      const dispatches = await mergeDispatches(b, ref.repo);
      const body = [summary, ...(since === null ? [] : [since]), `merge commit ${mergeSha ?? "?"}`, ...(restart === null ? [] : [restart]), ...dispatches].join("\n");
      await github.comment(ref.repo, ref.number, body).catch(() => undefined);
      store.closeNeedByKey(b.id, "merge", pull.url ?? pull.key, `Merged ${where}.`);
      return { ok: true, summary: [summary, ...dispatches].join("\n"), mergeSha };
    }

    const rawRpcHandlers: ExperimentalPluginRpcHandlersWithContext<typeof rpcContract> = {
      async stewardsRing({ source, id, deployment, workflow_run }, { experimental_caller: caller }) {
        if (caller.kind !== "plugin" || caller.pluginId !== SOURCE_PLUGIN_IDS[source]) throw new Error("only the linear and github-watcher plugins ring stewards, each for its own source");
        if (workflow_run !== undefined) {
          if (source !== "github") throw new Error("only the github-watcher plugin sends workflow_run doorbells");
          // Arrival is the only clock a workflow_run doorbell has (it carries
          // no run start time), so capture it here, before the debounce, and
          // let the handler skip a watch recorded after it (BB-61).
          const at = now();
          debounce(`run:${lc(id)}`, () => serial(`run:${lc(id)}`, () => onWorkflowRunDoorbell(id, workflow_run, at)));
          return { ok: true };
        }
        if (deployment !== undefined) {
          if (source !== "github") throw new Error("only the github-watcher plugin sends deployment doorbells");
          debounce(`deploy:${lc(id)}`, () => serial(`deploy:${lc(id)}`, () => onDeploymentDoorbell(id, deployment)));
          return { ok: true };
        }
        debounce(`ring:${source}:${lc(id)}`, () => serial(`ring:${source}:${lc(id)}`, () => onRing(source, id)));
        return { ok: true };
      },
      async stewardsSession(input, { experimental_caller: caller }) {
        if (caller.kind !== "plugin" || caller.pluginId !== SOURCE_PLUGIN_IDS.linear) throw new Error("only the linear plugin hands stewards an @bb mention");
        return onSession(input);
      },
      async stewardsList({ projectId, all }) {
        const rows = all ? store.all(projectId ?? undefined) : store.open(projectId ?? undefined);
        return {
          bindings: rows.map((b) => ({
            id: b.id,
            projectId: b.projectId,
            key: b.entityKey,
            kind: b.kind,
            phase: b.phase,
            threadId: b.threadId,
            summary: b.status?.summary ?? null,
            nextAction: b.status?.nextAction ?? null,
            actor: b.status?.actor ?? null,
            escalations: store.openEscalations(b.id).length,
            needs: store.openNeeds(b.id).length,
            ended: b.endedAt !== null,
          })),
        };
      },
      async stewardsOverview() {
        const list = await bb.sdk.projects.list();
        const named = new Map(list.map((p) => [p.id, p.name] as const));
        const configsById = new Map((await configuredProjects(false, list)).map((c) => [c.projectId, c] as const));
        // Every project, not only the configured ones: a project with no `.bb`
        // stewards content still gets a row and the Set up stewards action.
        const ids = [...new Set([...list.map((p) => p.id), ...projectIds(configsById.keys())])];
        /** The page's playbook rows: one per source for a ticket playbook, so a project carrying both names GitHub too (BB-234). */
        const overviewPlaybooks = (config: ProjectConfig | null): Array<{ kind: BindingKind; name: string; version: string | null; source: Source | null }> => {
          if (config === null) return [];
          const out: Array<{ kind: BindingKind; name: string; version: string | null; source: Source | null }> = [];
          for (const kind of KINDS.filter((k) => usesKind(config.file, k, config.role))) {
            if (kind !== "ticket") {
              out.push({ kind, name: playbookNameFor(config.file, kind), version: config.playbooks[kind]?.version ?? null, source: null });
              continue;
            }
            const loaded = (["linear", "github"] as const).filter((s) => config.ticketPlaybooks[s] !== undefined);
            if (loaded.length === 0) out.push({ kind, name: playbookNameFor(config.file, kind), version: null, source: null });
            else for (const source of loaded) out.push({ kind, name: config.ticketPlaybooks[source]!.name, version: config.ticketPlaybooks[source]!.version, source });
          }
          return out;
        };
        const projects = ids.map((projectId) => {
          const config = configsById.get(projectId) ?? null;
          const row = store.project(projectId);
          const bindings = store.all(projectId);
          const open = bindings.filter((b) => b.endedAt === null);
          const roleMap = bindingRoles(config?.roles ?? null, config?.githubLogin === null || config?.githubLogin === undefined ? null : lc(config.githubLogin), config?.repos ?? []);
          return {
            projectId,
            name: named.get(projectId) ?? projectId,
            configured: config !== null,
            // A project that still has bindings was stewarded before: restoring
            // its project.json is the fix, not onboarding it again.
            onboard: !hasProjectSteward(config) && bindings.length === 0,
            enabled: config?.enabled ?? false,
            source: config?.source.kind ?? null,
            label: config?.file.label ?? null,
            linearTeams: config?.file.linear.teams ?? [],
            repos: config?.repos ?? [],
            excludedRepos: config?.file.github.exclude ?? [],
            playbooks: overviewPlaybooks(config),
            // A project with no readable config still reports why, from the
            // last failed read, so a refused layout shows for it alone.
            problems: config?.problems ?? (configErrors.has(projectId) ? [`could not read the configuration: ${configErrors.get(projectId)}`] : []),
            nightly: config === null ? null : { at: config.file.nightly.at, timezone: config.file.nightly.timezone },
            lastNight: row.nightlyDate,
            projectStewardThreadId: row.threadId,
            digestAt: row.digestAt,
            endedCount: bindings.length - open.length,
            stewards: open.map((b) => ({
              key: b.entityKey,
              url: b.url,
              title: b.title,
              kind: b.kind,
              phase: b.phase,
              roles: rolesForBinding(roleMap, b),
              threadId: b.threadId,
              summary: b.status?.summary ?? null,
              nextAction: b.status?.nextAction ?? null,
              actor: b.status?.actor ?? null,
              waitingOn: b.status?.waitingOn ?? null,
              noWakeSource: b.noWakeSource,
              wakeFailure: b.wakeFailure,
              priority: b.priority,
              ...presentationHold(b),
              holdStack: b.holdStack,
              needsUser: needsUser(b),
              stuck: store.openEscalations(b.id).some((x) => x.kind === "stuck"),
              deployment: (Object.values(b.deployments).sort((x, y) => y.at - x.at)[0] ?? null)?.state ?? null,
              pending: b.pending,
              requeueAt: b.requeueAt,
              ending: b.ending,
              statusAt: b.statusAt,
              createdAt: b.createdAt,
              workers: store.workers(b.id).filter((w) => w.status === "running").length,
              waitingUntil: b.requeueUntil,
              escalations: store.openEscalations(b.id).map((x) => ({ kind: x.kind, route: x.route, question: x.question })),
            })),
          };
        });
        projects.sort((a, b) => a.name.localeCompare(b.name));
        return { paused: (await settings.get()).paused, lastSweepAt, stats: statsSnapshot(), projects };
      },
      async stewardsCheck({ projectId }) {
        return check(projectId);
      },
      async stewardsNavigationRestore() {
        return { value: store.serverSetting(NAVIGATION_RESTORE_KEY) };
      },
      async stewardsSetNavigationRestore({ value }) {
        store.setServerSetting(NAVIGATION_RESTORE_KEY, value);
        return { ok: true };
      },
      async stewardsSetProjectEnabled({ projectId, enabled }) {
        return setProjectEnabledForUser(projectId, enabled);
      },
      async stewardsOnboard({ projectId }, { experimental_caller: caller }) {
        if (caller.kind !== "client") throw new Error("Set up stewards is started from the Stewards page");
        try {
          return await onboardProject(projectId);
        } catch (error) {
          return { ok: false, threadId: null, message: errorMessage(error) };
        }
      },
      async stewardsBoard({ projectId: wanted }) {
        const named = new Map((await bb.sdk.projects.list()).map((p) => [p.id, p.name] as const));
        const configs = await configuredProjects();
        const enabledByProject = new Map(configs.map((c) => [c.projectId, c.enabled] as const));
        const projects = projectIds(configs.map((c) => c.projectId))
          .map((projectId) => ({ projectId, name: named.get(projectId) ?? projectId, enabled: enabledByProject.get(projectId) ?? false }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const picked = projects.find((p) => p.projectId === wanted) ?? (wanted === null ? projects[0] : undefined);
        if (picked === undefined) return { projects, board: null };
        const { projectId } = picked;
        const row = store.project(projectId);
        const all = store.all(projectId);
        const open = all.filter((b) => b.endedAt === null);
        const { questions, withUser, needs } = needsYou(projectId);
        const stuck = open.flatMap((b) => [
          ...store.openEscalations(b.id).filter((x) => x.kind === "stuck").map((x) => ({ b, why: `Stuck, with ${x.route === "user" ? "you" : x.route === "parent" ? "the parent steward" : "the project steward"}: ${x.question}`, since: x.createdAt })),
          ...(b.hold === null ? [] : [{ b, why: `On hold: ${b.hold}`, since: null }]),
        ]);
        const ended = all.filter((b) => b.endedAt !== null && b.endedAt >= now() - ENDED_ON_BOARD_MS).sort((a, b) => b.endedAt! - a.endedAt!).slice(0, 30);
        const boardConfig = configs.find((c) => c.projectId === projectId) ?? null;
        const roleMap = bindingRoles(boardConfig?.roles ?? null, boardConfig?.githubLogin === null || boardConfig?.githubLogin === undefined ? null : lc(boardConfig.githubLogin), boardConfig?.repos ?? []);
        return {
          projects,
          board: {
            projectId,
            name: picked.name,
            enabled: picked.enabled,
            paused: (await settings.get()).paused,
            projectStewardThreadId: row.threadId,
            roleNames: boardConfig?.roleNames ?? [],
            stages: [...STAGES],
            digest: row.digest === null ? null : { text: row.digest, at: row.digestAt ?? 0 },
            questions,
            withUser,
            needs,
            lessons: store.allLessons(projectId).map((l) => {
              const b = l.bindingId === null ? null : store.binding(l.bindingId);
              return { id: l.id, bindingId: l.bindingId, key: b?.entityKey ?? null, file: l.file, text: l.text, scope: l.scope, status: l.status, tier: l.tier, hits: l.hits, corrections: l.corrections, lastCitedAt: l.lastCitedAt, branch: l.branch, mergeSha: l.mergeSha, note: l.note, escalationId: l.escalationId, createdAt: l.createdAt };
            }),
            lessonCounts: (() => {
              const counts = { candidate: 0, trial: 0, promoted: 0, retired: 0 };
              for (const l of store.allLessons(projectId)) counts[l.tier] += 1;
              return counts;
            })(),
            stewards: open.map((b) => ({
              key: b.entityKey,
              url: b.url,
              title: b.title,
              kind: b.kind,
              phase: b.phase,
              // Ops bindings have no stage of their own; the page groups them as watching.
              stage: b.kind === "ops" ? "watch" : b.stage,
              roles: rolesForBinding(roleMap, b),
              threadId: b.threadId,
              summary: b.status?.summary ?? null,
              nextAction: b.status?.nextAction ?? null,
              actor: b.status?.actor ?? null,
              waitingOn: b.status?.waitingOn ?? null,
              noWakeSource: b.noWakeSource,
              wakeFailure: b.wakeFailure,
              priority: b.priority,
              ...presentationHold(b),
              holdStack: b.holdStack,
              needsUser: needsUser(b),
              stuck: store.openEscalations(b.id).some((x) => x.kind === "stuck"),
              // The newest deployment watch, whatever its state; `merged` reads as deploying.
              deployment: (Object.values(b.deployments).sort((x, y) => y.at - x.at)[0] ?? null)?.state ?? null,
              pending: b.pending,
              requeueAt: b.requeueAt,
              ending: b.ending,
              statusAt: b.statusAt,
              createdAt: b.createdAt,
              wokeAt: b.wokeAt,
              advancedAt: b.advancedAt,
              waitingUntil: b.requeueUntil,
              workers: store.workers(b.id).filter((w) => w.status === "running").map((w) => ({ threadId: w.threadId, title: w.title })),
              assumptions: store.openAssumptions(b.id).map((a) => ({ id: a.id, text: a.text, context: a.context, recordedAt: a.recordedAt, recordedBy: a.recordedBy })),
            })),
            stuck: stuck.map(({ b, why, since }) => ({ key: b.entityKey, url: b.url, threadId: b.threadId, why, since })),
            ended: ended.map((b) => ({ key: b.entityKey, url: b.url, title: b.title, kind: b.kind, endReason: b.endReason, endedAt: b.endedAt!, threadId: b.threadId })),
          },
        };
      },
      // The sidebar's one call: one project's bindings and "needs you" items,
      // plus the picker's per-project needs count. The project is the input, or
      // the first by name when null. There is no per-worker `threads.list`: the
      // client derives reviewers from the live thread tree (BB-100).
      async stewardsSidebar({ projectId: wanted }) {
        const started = now();
        // One project list for both the names and the configurations (BB-95),
        // instead of `bb.sdk.projects.list()` twice.
        const projectList = await bb.sdk.projects.list();
        const named = new Map(projectList.map((p) => [p.id, p.name] as const));
        const configs = await configuredProjects(false, projectList);
        const projects = projectIds(configs.map((c) => c.projectId))
          .map((projectId) => ({ projectId, name: named.get(projectId) ?? projectId }))
          .sort((a, b) => a.name.localeCompare(b.name));
        // The threads each project's stewards and workers own, so the picker's
        // unread sum does not count them as one-off roots when this call carries
        // another project's bindings (BB-160). The store already holds them: the
        // project steward, each binding's steward thread, and every worker. One
        // pass over all bindings, so a project whose bindings this call does not
        // carry still gets its set.
        const claimed = new Map<string, Set<string>>();
        const claim = (projectId: string, threadId: string | null): void => {
          if (threadId === null) return;
          const set = claimed.get(projectId) ?? new Set<string>();
          set.add(threadId);
          claimed.set(projectId, set);
        };
        for (const p of store.projects()) claim(p.projectId, p.threadId);
        for (const b of store.all()) {
          claim(b.projectId, b.threadId);
          for (const w of store.workers(b.id)) claim(b.projectId, w.threadId);
        }
        // The picker's count is the server's own: every open binding with an
        // open need, question or route-`user` escalation. It is broader than
        // `needsUser` since BB-237 (a need the server cannot act on yet is not
        // a yellow row), so the pill can exceed the yellow rows (BB-100).
        const picker = projects.map((p) => ({
          ...p,
          // One SQL count per project, so the picker never parses every binding
          // and runs three more queries each (BB-104).
          needsCount: store.countNeedsUser(p.projectId),
          // The threads this project's stewards and workers own, for every
          // project, so the picker's unread sum does not count them as one-off
          // roots when this call carries another project's bindings (BB-160).
          claimedThreadIds: [...(claimed.get(p.projectId) ?? [])],
        }));
        const picked = projects.find((p) => p.projectId === wanted) ?? (wanted === null ? projects[0] : undefined);
        if (picked === undefined) {
          return { projects: picker, projectId: null, projectStewardThreadId: null, roleProblem: null, needs: { count: 0, items: [] }, bindings: [], ended: [] };
        }
        const { projectId } = picked;
        const roleProblem = configs.find((c) => c.projectId === projectId)?.problems.find((p) => p.startsWith("No role for ")) ?? null;
        const all = store.all(projectId);
        const ended = all
          .filter((b) => b.endedAt !== null && b.endedAt >= started - ENDED_ON_BOARD_MS)
          .sort((a, b) => b.endedAt! - a.endedAt!)
          .slice(0, 30);
        const { questions, withUser, needs } = needsYou(projectId, { actionableOnly: true });
        // Only the workers the row can show: running or finished, plus any
        // other worker that ended within the last hour (BB-100).
        const liveSince = started - 3_600_000;
        const bindings = all
          .filter((b) => b.endedAt === null)
          .map((b) => {
            const workers = store
              .workers(b.id)
              .filter((w) => w.status === "running" || w.status === "finished" || (w.endedAt !== null && w.endedAt >= liveSince))
              .map((w) => ({ threadId: w.threadId, title: w.title, status: w.status }));
            // The newest deployment watch, whatever its state (BB-76); the row shows `merged` as deploying too.
            const newestDeployment = Object.values(b.deployments).sort((x, y) => y.at - x.at)[0] ?? null;
            return {
              key: b.entityKey,
              kind: b.kind,
              stage: b.stage,
              phase: b.phase,
              threadId: b.threadId,
              // BB-245: the parent binding's key, so the sidebar nests the
              // effort under its parent; null when it has none. A parent in
              // another project, or an ended one, names no effort and the
              // child stays top-level (the client decides from the tab's own
              // list).
              parentKey: b.parentBindingId === null ? null : (store.binding(b.parentBindingId)?.entityKey ?? null),
              ...presentationHold(b),
              holdStack: b.holdStack,
              waitingOn: b.status?.waitingOn ?? null,
              noWakeSource: b.noWakeSource,
              wakeFailure: b.wakeFailure,
              needsUser: needsUser(b),
              stuck: store.openEscalations(b.id).some((x) => x.kind === "stuck"),
              status: b.status === null ? null : { actor: b.status.actor, nextAction: b.status.nextAction, at: b.status.at },
              deployment: newestDeployment === null ? null : newestDeployment.state,
              pending: b.pending,
              requeueAt: b.requeueAt,
              advancedAt: b.advancedAt,
              waitingUntil: b.requeueUntil,
              workers,
            };
          });
        const result = {
          projects: picker,
          projectId,
          projectStewardThreadId: store.project(projectId).threadId,
          roleProblem,
          needs: {
            count: questions.length + withUser.length + needs.length,
            items: [
              ...questions.map((q) => ({ type: "question" as const, ...q, bindingKey: q.key })),
              ...withUser.map((w) => ({ type: "withUser" as const, ...w, bindingKey: w.key })),
              ...needs.map((n) => ({ type: "need" as const, ...n, bindingKey: n.key })),
            ],
          },
          bindings,
          ended: ended.map((b) => ({ key: b.entityKey, kind: b.kind, threadId: b.threadId, title: b.title, phase: b.phase, endReason: b.endReason, endedAt: b.endedAt! })),
        };
        // One debug line per call, with its duration and binding/worker counts,
        // so the next slowdown has numbers (BB-95).
        const workerCount = bindings.reduce((n, b) => n + b.workers.length, 0);
        bb.log.debug(`stewards: stewardsSidebar took ${now() - started}ms (${projectId}: ${bindings.length} bindings, ${workerCount} workers)`);
        return result;
      },
      async stewardsAnswerQuestion({ questionId, answer, choice, rationale }, { experimental_caller: caller }) {
        if (caller.kind !== "client") throw new Error("questions are closed by the user, from the stewards page");
        const q = store.question(questionId);
        if (q === null || q.status !== "open") return { ok: false, message: "That question is already closed." };
        const text = answer === undefined || answer === null || answer === "" ? null : answer;
        const x = q.escalationId === null ? null : store.escalation(q.escalationId);
        const b = x === null ? null : store.binding(x.bindingId);
        // BB-35 step 4: the rationale the page collected, if any. Empty is
        // always accepted; the box was shown, so the cluster is not asked
        // again. The reasoning rides with the closure so the project steward
        // records it as the lesson candidate's text.
        const rationaleText = rationale === undefined || rationale === null || rationale.trim() === "" ? null : rationale.trim();
        const withRationale = (closure: string): string => {
          if (q.rationaleWanted === null) return closure;
          // The box was shown. A supplied rationale settles the cluster for
          // good; an empty one leaves it open for a later repeat. The forwarded
          // escalation keeps its own flags for the after-the-fact follow-up.
          store.markEscalationRationaleAsked(q.id);
          if (rationaleText === null) return closure;
          store.markEscalationRationaleGiven(q.id);
          if (x !== null) store.markEscalationRationaleGiven(x.id);
          return `${closure} Their reasoning: ${JSON.stringify(rationaleText)}.`;
        };
        // A plain question has no forwarded escalation to carry the rationale,
        // so wake the project steward with it directly, once.
        const wakePlainRationale = async (): Promise<void> => {
          if (x !== null || rationaleText === null || q.rationaleWanted === null) return;
          store.markEscalationRationaleGiven(q.id);
          await wakeProject(q.projectId, "a rationale on a repeat question", {
            digestDue: false,
            notes: [`The user answered question ${q.id} with a rationale: ${JSON.stringify(rationaleText)}. If it is a general judgement the playbook should carry, record it as a lesson with steward_update { lesson: { text, file, scope } }.`],
          });
        };
        // A fixed choice: the label is the answer, saved as guidance, and a
        // forwarded escalation resolves with that guidance, exactly as
        // steward_update { guidance, resolve } records it (BB-20).
        const chosen = choice === undefined || choice === null || choice === "" ? null : choice;
        if (chosen !== null) {
          if (q.choices.length === 0) return { ok: false, message: "That question has no choices; answer it in the text box." };
          if (!q.choices.includes(chosen)) return { ok: false, message: `"${chosen}" is not one of the choices: ${q.choices.join(", ")}.` };
          const guidance = text === null ? chosen : `${chosen} — ${text}`;
          store.answer(q.id, `Chose: ${chosen}${text === null ? "" : ` — ${text}`}`, "user", guidance);
          if (x !== null && b !== null && b.endedAt === null) {
            const closure = withRationale(`The user chose ${chosen} for ${b.entityKey}'s forwarded escalation on the Stewards page${text === null ? "" : `: ${text}`}.`);
            store.addGuidance(b.id, guidance, "user");
            countCorrections(x, guidance);
            store.note(b.id, `The user chose ${chosen} for ${q.question}${text === null ? "" : `: ${text}`}.`);
            scheduleReconcile(b.id);
            await wakeProjectOnForwardedAnswer(b, closure, [x]);
            return { ok: true, message: `Recorded; ${b.entityKey}'s steward has been told.` };
          }
          await wakePlainRationale();
          return { ok: true, message: "Closed." };
        }
        // A free-text answer must carry text: the page disables Answer while
        // the box is empty, and the sidebar opens the detail view instead of
        // closing the question empty (BB-268).
        if (text === null) return { ok: false, message: "Type an answer first." };
        // Criterion 1: an approval request answered on the page approves or
        // declines the current spec and closes the request in one
        // transaction. Ambiguous words are not a decline: the project steward
        // decides, so the request goes back to it with the answer.
        if (x !== null && b !== null && b.endedAt === null && x.kind === "approval") {
          const entity = (b.source === "ops" ? null : await snapshot(b.source, b.entityId).catch(() => null)) ?? b.lastSnapshot?.entity ?? null;
          const verdict = classifyApproval(text);
          if (verdict === "approve" && entity !== null) {
            store.approve(b.id, { at: now(), specHash: specHashFor(b, entity), by: "user", approvedText: specTextFor(b, entity) }, `Approved by the user on the stewards page: "${text}"`, "user");
            store.addGuidance(b.id, text, "user");
            store.note(b.id, `Approval ${x.id} was answered by the user on the stewards page: ${text}`);
            scheduleReconcile(b.id);
            return { ok: true, message: `Approved; ${b.entityKey}'s steward has been told.` };
          }
          if (verdict === "decline" && entity !== null) {
            store.decline(b.id, specHashFor(b, entity), `Declined by the user on the stewards page: "${text}"`, "user");
            store.addGuidance(b.id, text, "user");
            store.note(b.id, `Approval ${x.id} was declined by the user on the stewards page: ${text}`);
            scheduleReconcile(b.id);
            return { ok: true, message: `Declined; ${b.entityKey}'s steward has been told.` };
          }
          // Ambiguous: close the question, keep the escalation, and send it
          // back to the project steward to interpret.
          store.answerQuestionOnly(q.id, text, "user");
          store.addGuidance(b.id, text, "user");
          store.reroute(x.id, "project", x.recommendation);
          store.note(b.id, `The user answered approval ${x.id} on the stewards page, but not clearly enough to approve or decline: ${text}`);
          scheduleReconcile(b.id);
          await wakeProject(b.projectId, `ambiguous approval answer for ${b.entityKey}`, {
            digestDue: false,
            notes: [`The user answered ${b.entityKey}'s approval request on the Stewards page: ${JSON.stringify(text)}. It is not clearly an approval or a decline, so interpret it: approve with steward_update { binding, approve: true }, or decline with explicit words.`, `The escalation ${x.id} is open with you again.`],
          });
          return { ok: true, message: `Closed; the project steward will interpret the answer.` };
        }
        // Closes the escalation it was forwarded for, too. The project
        // steward forwarded it, so it is told too: the user's answer is a
        // lesson candidate for its next wake (BB-35 step 1).
        store.answer(q.id, text, "user");
        if (x !== null && b !== null && b.endedAt === null) {
          const closure = withRationale(`The user answered ${b.entityKey}'s forwarded escalation on the Stewards page: ${JSON.stringify(text)}.`);
          store.addGuidance(b.id, text, "user");
          countCorrections(x, text);
          store.note(b.id, `Escalation ${x.id} decided by the user: ${text}`);
          scheduleReconcile(b.id);
          await wakeProjectOnForwardedAnswer(b, closure, [x]);
          return { ok: true, message: `Closed; ${b.entityKey}'s steward has been told.` };
        }
        await wakePlainRationale();
        return { ok: true, message: "Closed." };
      },

      // The page's buttons. Each action runs on the server as the connected user
      // and unsigned, so it counts as a human action; each closes its item and
      // wakes the binding's steward with the closure under "What changed".
      async stewardsNeedAction({ needId, action, note, choice }, { experimental_caller: caller }) {
        if (caller.kind !== "client") throw new Error("needs are actioned by the user, from the stewards page");
        const need = store.need(needId);
        if (need === null || need.status !== "open") return { ok: false, message: "That item is already closed." };
        const b = store.binding(need.bindingId);
        if (b === null) return { ok: false, message: "That binding is gone." };
        // The escalation this item resolves, and the escalation it was forwarded
        // from: gathered before the close so the project steward's wake names
        // both (BB-51).
        const forwarded = forwardedFor(need);
        if (action === "choose" && need.kind !== "decide") return { ok: false, message: `Choices are for a decide item; this is ${need.kind}.` };
        const text = note === undefined || note === null || note.trim() === "" ? null : note.trim();
        /** Close the item and wake the steward with what happened. */
        const after = (closure: string): void => {
          store.note(b.id, closure);
          if (text !== null) store.addGuidance(b.id, text, "user");
          scheduleReconcile(b.id);
        };
        const freshPull = async (): Promise<EntitySnapshot | null> => {
          const entity = (b.source === "ops" ? null : await snapshot(b.source, b.entityId).catch(() => null)) ?? b.lastSnapshot?.entity ?? null;
          if (entity === null) return null;
          const pulls = b.kind === "ticket" ? await linkedPulls(entity) : [];
          return [entity, ...pulls].find((e) => (e.url ?? e.key) === need.url || e.key === need.url) ?? (entity.pull === null ? null : entity);
        };

        if (need.kind === "approve-spec") {
          if (action !== "approve" && action !== "decline") return { ok: false, message: "Approve or decline the spec." };
          const entity = (b.source === "ops" ? null : await snapshot(b.source, b.entityId).catch(() => null)) ?? b.lastSnapshot?.entity ?? null;
          if (entity === null) return { ok: false, message: "The ticket could not be read; try again." };
          // The same path `steward_update { approve }` uses: the verdict is
          // recorded on the gate, the need closes, and the open `approval`
          // escalations (the forwarded request) are resolved in one step.
          const { closure, forwarded } = recordSpecVerdict(b, action, entity, text, "on the Stewards page");
          after(closure);
          await wakeProjectOnForwardedAnswer(b, closure, forwarded);
          return { ok: true, message: `${action === "approve" ? "Approved" : "Declined"}; ${b.entityKey}'s steward has been told.` };
        }

        if (need.kind === "approve-pr") {
          if (action !== "approve" && action !== "decline") return { ok: false, message: "Approve or decline the pull request." };
          // The page's approve/decline actions live in approvals.ts (BB-153).
          return approvePrPageAction(approvalsCtx, b, need, action, text);
        }

        if (need.kind === "merge") {
          const ref = parsePullRef(need.url);
          if (ref === null) return { ok: false, message: `I cannot tell which pull request ${need.url} is.` };
          const pull = await freshPull();
          if (pull === null) return { ok: false, message: "The pull request could not be read; try again." };
          // The same shared path `bb stewards merge` takes (BB-133): one gate
          // check, one squash merge, one "Merged:" comment.
          const result = await mergePullRequest(b, ref, pull, "from the Stewards page");
          if (!result.ok) return { ok: false, message: result.message };
          after(`${pull.key} was merged from the Stewards page. ${result.summary}`);
          return { ok: true, message: `Merged; ${b.entityKey}'s steward has been told.` };
        }

        if (need.kind === "configure") {
          if (action !== "done") return { ok: false, message: "Press Done once the step is finished." };
          const closure = `The user did ${need.what}${text === null ? "" : `: ${text}`}.`;
          store.closeNeed(need.id, text === null ? "Done on the Stewards page." : `Done on the Stewards page: ${text}`, "user");
          after(closure);
          await wakeProjectOnForwardedAnswer(b, closure, forwarded);
          return { ok: true, message: `Marked done; ${b.entityKey}'s steward has been told.` };
        }

        if (need.kind === "provide-secret") {
          if (action !== "provide" && action !== "done") return { ok: false, message: "Provide the secret, or mark it done." };
          const named = typeof need.data.variable === "string" && need.data.variable.trim() !== "" ? need.data.variable.trim() : need.what;
          // Done is the manual escape hatch: the value was entered another way.
          if (action === "done") {
            const closure = `The user marked ${named} done on the Stewards page${text === null ? "" : `: ${text}`}; the value was entered another way.`;
            store.closeNeed(need.id, text === null ? "Marked done on the Stewards page." : `Marked done on the Stewards page: ${text}`, "user");
            after(closure);
            await wakeProjectOnForwardedAnswer(b, closure, forwarded);
            return { ok: true, message: `Recorded; ${b.entityKey}'s steward has been told.`, threadId: null };
          }
          // Provide opens bb's secure form in a requester thread the plugin
          // spawns, so the user never has to prompt one. The need stays open
          // until the requester finishes, so `bb stewards secret import`
          // (case B) is accepted while it runs.
          const existing = store.secretRequesterForNeed(need.id);
          if (existing !== null) {
            const info = await threadInfo(existing.threadId).catch(() => null);
            if (info !== null && info.deletedAt === null && info.archivedAt === null) return { ok: true, message: `The form is already open for ${named}.`, threadId: existing.threadId };
            store.clearSecretRequester(existing.threadId);
          }
          let requesterId: string;
          try {
            requesterId = await spawnRequester(b, need);
          } catch (error) {
            return { ok: false, message: `Could not start the requester thread: ${errorMessage(error)}` };
          }
          store.note(b.id, `Started a requester thread for ${named}; the user is entering it there.`);
          return { ok: true, message: `Opening the secure form for ${named} in a new thread.`, threadId: requesterId };
        }

        // A lesson's validation item (BB-35 steps 3/5, BB-108). A boundary one
        // is Review PR/Drop: the pull request lands it and Drop closes it. A
        // mixed-evidence one is Keep/Retire: Keep records that the user
        // confirmed it, Retire removes it. Neither is a free-text answer.
        if (need.kind === "decide" && action === "choose" && typeof need.data.lessonId === "string") {
          const lesson = store.lesson(need.data.lessonId);
          const label = choice === undefined || choice === null || choice === "" ? null : choice;
          // A retire item is about a retired lesson whose text is still in the
          // file (status merged, a retire PR open); every other lesson item is
          // about a pending lesson. Anything else is already resolved.
          const isRetire = lesson !== null && lesson.retirePr !== null && lesson.status === "merged";
          if (lesson === null || lesson.status === "dropped" || (lesson.tier === "retired" && !isRetire)) {
            store.closeNeedByKey(b.id, "decide", need.url, "The lesson is already resolved.");
            return { ok: false, message: "That lesson is already resolved." };
          }
          if (need.data.validation === "mixed-evidence") {
            if (label === "Keep") {
              store.markLessonValidated(lesson.id);
              store.closeNeedByKey(b.id, "decide", need.url, "Kept on the Stewards page.");
              after(`The user kept lesson ${lesson.id} (${lesson.file}) on the Stewards page.`);
              return { ok: true, message: `Kept; ${b.entityKey}'s steward has been told.` };
            }
            if (label !== "Retire") return { ok: false, message: `"${label ?? ""}" is not one of the choices: Keep, Retire.` };
            const removed = await retireLesson(lesson);
            // A refused removal still retires the row, so the project steward
            // gets the anchored text out through `## Lessons to retire`.
            if (removed.startsWith("retire refused")) retireLessonByRule(store.lesson(lesson.id) ?? lesson, "retired by the user");
            store.closeNeedByKey(b.id, "decide", need.url, "Retired on the Stewards page.");
            after(`The user retired lesson ${lesson.id} (${lesson.file}) on the Stewards page: ${removed}.`);
            return { ok: true, message: `Retired; ${b.entityKey}'s steward has been told.` };
          }
          if (!isRetire && lesson.status !== "pending") {
            store.closeNeedByKey(b.id, "decide", need.url, "The lesson is already resolved.");
            return { ok: false, message: "That lesson is already resolved." };
          }
          if (label === "Drop") {
            await closeLessonPr(lesson, isRetire ? lesson.retirePr : lesson.pr);
            store.markLessonDropped(lesson.id, isRetire ? "Retire dropped by the user on the Stewards page." : "Dropped by the user on the Stewards page.");
            store.closeNeedByKey(b.id, "decide", need.url, "Dropped on the Stewards page.");
            after(`The user dropped lesson ${lesson.id} on the Stewards page.`);
            return { ok: true, message: `Dropped; ${b.entityKey}'s steward has been told.` };
          }
          if (label !== "Review PR") return { ok: false, message: `"${label ?? ""}" is not one of the choices: Review PR, Drop.` };
          const prUrl = typeof need.data.prUrl === "string" ? need.data.prUrl : (lesson.retirePr ?? lesson.pr);
          return { ok: true, message: prUrl === null ? "The pull request is not open yet; the project steward has not landed it." : `Review ${prUrl}; the lesson is marked ${isRetire ? "dropped" : "merged"} when it merges.` };
        }

        if (need.kind === "decide" && action === "choose") {
          const choices = needChoices(need);
          const label = choice === undefined || choice === null || choice === "" ? null : choice;
          if (label === null) return { ok: false, message: "Pick one of the choices." };
          if (choices.length === 0) return { ok: false, message: "That item has no choices; answer it in the text box." };
          if (!choices.includes(label)) return { ok: false, message: `"${label}" is not one of the choices: ${choices.join(", ")}.` };
          const guidance = text === null ? label : `${label} — ${text}`;
          // A decide item the project steward forwarded is the escalation
          // itself, so resolving it delivers the answer to the originator.
          const ownEscalation = store.escalation(need.id);
          if (ownEscalation !== null && ownEscalation.status === "open") {
            store.addGuidance(b.id, guidance, "user");
            store.answerEscalation(need.id, `Chose: ${label}${text === null ? "" : ` — ${text}`}`, "user");
            countCorrections(ownEscalation, guidance);
          } else {
            store.closeNeedByKey(b.id, "decide", need.url, `Chose: ${label}${text === null ? "" : ` — ${text}`}`);
            store.addGuidance(b.id, guidance, "user");
            const escalationId = typeof need.data.escalationId === "string" ? need.data.escalationId : null;
            if (escalationId !== null) {
              const escalation = store.escalation(escalationId);
              if (escalation !== null && escalation.status === "open") {
                store.answerEscalation(escalationId, guidance, "user");
                countCorrections(escalation, guidance);
              }
            }
          }
          store.note(b.id, `The user chose ${label} for ${need.what}${text === null ? "" : `: ${text}`}.`);
          scheduleReconcile(b.id);
          await wakeProjectOnForwardedAnswer(b, `The user chose ${label} for ${need.what}${text === null ? "" : `: ${text}`}.`, forwarded);
          return { ok: true, message: `Recorded; ${b.entityKey}'s steward has been told.` };
        }

        // A `decide` item's free-text Answer must carry text, or the item
        // stays open: the sidebar opens the detail view instead of calling
        // this with an empty answer (BB-268). An auto-filed item (BB-213) is a
        // plain Done item with no text box, so its Done still closes it.
        if (need.kind === "decide" && action === "done" && need.data.autoFiled !== true && needChoices(need).length === 0 && text === null) {
          return { ok: false, message: "Type an answer first." };
        }
        // `decide` is the question mechanism; a raw item of that kind just closes.
        const closure = `${need.kind} item ${need.id} was closed on the Stewards page${text === null ? "" : `: ${text}`}.`;
        store.closeNeed(need.id, text === null ? "Closed on the Stewards page." : `Closed on the Stewards page: ${text}`, "user");
        after(closure);
        await wakeProjectOnForwardedAnswer(b, closure, forwarded);
        return { ok: true, message: `Closed; ${b.entityKey}'s steward has been told.` };
      },
    };
    bb.rpc.register(rpcContract, measuredHandlers("rpc", rawRpcHandlers));
    bb.rpc.register(retryConsentContract, { [RETRY_CONSENT_METHOD]: (input) => answerRetryConsent(input) }, { experimental_discoverable: true, experimental_description: "Declines provider retries of stewards' own wakes, which the plugin re-runs itself." });

    /** Stewarded projects, and those whose configuration went away but still have stewards. */
    function projectIds(configured: Iterable<string>): string[] {
      return [...new Set([...configured, ...store.all().map((b) => b.projectId)])];
    }

    // ---- the agent surface ---------------------------------------------------------------------------
    //
    // Two tools. steward_report ends a steward's turn with its status record
    // and, when it must, an escalation. steward_update is how one thread
    // steers a binding: the steward saving the user's instructions, a parent
    // or the project steward deciding an escalation, setting priority, holds
    // and models, or approving a spec. Everything else a steward does, it does
    // with the tools every thread has: linear_*, gh, and `bb thread` for
    // workers.

    type Role = { kind: "steward"; binding: Binding } | { kind: "project"; projectId: string } | null;
    function roleOf(threadId: string): Role {
      const b = store.byThread(threadId);
      if (b !== null && b.endedAt === null) return { kind: "steward", binding: b };
      const p = store.projectByThread(threadId);
      if (p !== null) return { kind: "project", projectId: p.projectId };
      return null;
    }

    bb.agents.configure((context) => {
      // The onboarding thread is an ordinary thread, not a steward; the skill
      // carries the whole procedure. It is identified by the metadata this
      // plugin set at spawn, before any binding lookup.
      if (context.pluginMetadata.role === "onboarding") return { tools: [], skills: ["onboarding"], instructions: ONBOARDING_INTRO };
      const role = roleOf(context.thread.id);
      if (role === null) return { tools: [], skills: ["stewards"] };
      if (role.kind === "project") {
        return {
          tools: ["steward_update"],
          skills: ["stewards"],
          instructions:
            "You are this project's steward. Decide escalations from the project's own guidance (AGENTS.md, architecture and design docs); only the project's big decisions go to the user. Read status with `bb stewards list` and `bb stewards show <key>`; steer with steward_update. Do not do a binding's work yourself: when an ended binding left work undone, reopen its entity so its steward resumes. Read the stewards skill for the protocol.",
        };
      }
      const b = role.binding;
      if (b.kind === "ops") {
        const sentry = parseOpsTargetKey(b.entityId)?.kind === "sentry-project";
        return {
          tools: ["steward_report", "steward_update"],
          skills: ["stewards"],
          instructions:
            `You are the ops steward watching ${JSON.stringify(b.entityKey)} (binding ${b.id}, playbook ${JSON.stringify(b.playbook)}), and your thread id is ${context.thread.id}. ` +
            (sentry
              ? "The plugin reads this Sentry project for you with its own token and every wake carries the issues that are new, regressed or rung, with their stack traces; you never change production and start no workers. Your thread holds no Sentry token, so diagnose from the wake and the code in your workspace. "
              : "The plugin looks at the target for you and every wake carries what it found; you never change production and start no workers. To dig further, run kubectl on the target yourself, but only get, describe, logs and auth can-i: it acts as the user, whose rights are broad. ") +
            "File and comment on Linear tickets with the linear_ tools, which sign for you; escalate each ticket you file to the project steward with steward_report, as the playbook says. " +
            "End every turn you were woken for with steward_report, listing in opsTickets every ticket you filed, commented on or reopened. Read the stewards skill for the protocol.",
        };
      }
      return {
        tools: ["steward_report", "steward_update"],
        skills: ["stewards"],
        instructions:
          `You are the steward of ${JSON.stringify(b.entityKey)} (binding ${b.id}, a ${b.kind} binding under playbook ${JSON.stringify(b.playbook)}), and your thread id is ${context.thread.id}. ` +
          "You act on it as the user, by the playbook. Decide what the project's guidance settles; escalate the rest with steward_report. " +
          "When the user tells you something about how to handle it, save it with steward_update. Every wake message is self-contained; act on it, then end the turn with steward_report. " +
          "Delegate code to workers (`bb thread spawn`, as each wake shows). Sign what you write on GitHub: with gh, end it with " +
          `${JSON.stringify(signatureLine(context.thread.id))}. The linear_ tools sign for you, so add no signature to what you pass them. Read the stewards skill for the protocol.`,
      };
    });

    /**
     * The invariants on every turn, not only in a wake. The SDK's per-thread
     * system context (`contributeInstructions`) is resolved at thread.start and
     * turn.submit, so a steward whose transcript was compacted — or which a
     * plain message, a `bb thread tell` or a child notice wakes — still gets
     * its thread id, allowed actions, the spawn command, the standing rules
     * and the pointer at `bb stewards brief`. The role's own instructions stay
     * in `configure`; this carries the live binding state, which is why the
     * brief is built here and not in the skill.
     */
    /** The project steward's invariants, injected per turn and printed by `bb stewards brief` in its thread. */
    const projectStewardInvariants = (threadId: string): string =>
      [
        "Your context may have been compacted. You are the project steward; the record, not memory, is what you decide from.",
        `Your thread id is ${threadId}. Read status with \`bb stewards list\` and \`bb stewards show <key>\`; steer with steward_update. End the nightly wake with the morning digest.`,
      ].join("\n");

    bb.agents.contributeInstructions(({ threadId }) => {
      const project = store.projectByThread(threadId);
      if (project !== null) return projectStewardInvariants(threadId);
      const b = store.byThread(threadId);
      if (b === null || b.endedAt !== null) return null;
      const config = configs.get(b.projectId)?.value ?? null;
      const playbook = config === null ? null : bindingPlaybook(config, b);
      if (playbook === null) {
        return [
          `Your context may have been compacted. Your thread id is ${threadId}, and you steward ${b.entityKey} (binding ${b.id}).`,
          "The project's playbook could not be read; run `bb stewards brief` and `bb stewards check` before acting.",
        ].join("\n");
      }
      const hostId = cachedProjectHost(b.projectId);
      const flags = hostId === undefined ? null : [environmentFlags(config?.source ?? null, hostId), workerFlags(workerModel(b, playbook))].filter((f) => f !== "").join(" ");
      return formatBrief(
        { binding: b, playbook, gate: briefGate(b, playbook), workerFlags: flags, escalations: store.openEscalations(b.id), conflicts: conflictsOf(b, store.open(b.projectId)) },
        BRIEF_MAX_CHARS,
      );
    });

    const toolError = (error: unknown) => ({ content: [{ type: "text" as const, text: errorMessage(error) }], isError: true });

    /**
     * Move a pull-request binding to the pull request that replaces it (a
     * Dependabot bump redone on a branch of its own, say). The binding keeps
     * its id, thread, playbook, guidance, escalations and workers; its entity,
     * snapshot and phase become the replacement's, and an ending begun by the
     * replaced pull request's close is undone, so the steward is not archived
     * out from under the open replacement. Items filed for the old pull
     * request are withdrawn; the next reconcile files the replacement's.
     */
    async function replaceBinding(b: Binding, ref: string): Promise<{ binding: Binding } | { error: string }> {
      if (b.kind !== "pr" || b.source !== "github") return { error: "replacedBy is for a pull-request steward: this binding is not one." };
      const next = parsePullRef(ref);
      if (next === null) return { error: `replacedBy must name a pull request as owner/repo#N or its URL; ${JSON.stringify(ref)} does not.` };
      const own = parsePullRef(b.url ?? b.entityKey);
      if (own === null) return { error: `replacedBy is for a pull request whose key reads as owner/repo#N; ${JSON.stringify(b.entityKey)} does not.` };
      if (lc(own.repo) !== lc(next.repo)) return { error: `A replacement is in the same repository: ${b.entityKey} is in ${own.repo}, not ${next.repo}.` };
      const key = `${next.repo}#${next.number}`;
      if (own.number === next.number) return { error: `${key} is this pull request, not a replacement.` };
      const entity = await snapshot("github", key).catch(() => null);
      if (entity === null || entity.pull === null) return { error: `${key} could not be read as a pull request.` };
      if (entity.pull.merged || entity.state === "merged" || entity.state === "closed") return { error: `${entity.key} is ${entity.state}; a replacement must be open.` };
      const taken = store.byEntity("github", entity.id);
      if (taken !== null && taken.id !== b.id) return { error: `${entity.key} already has a steward (${taken.endedAt === null ? "open" : "ended"}); it cannot replace ${b.entityKey}.` };
      const config = await loadConfig(b.projectId);
      const playbook = config === null ? null : bindingPlaybook(config, b);
      const { phase, stage } = playbook === null ? { phase: entity.state, stage: null } : phaseAndStage(playbook, entity.state, entity.labels);
      const oldKey = b.entityKey;
      const oldUrl = b.url ?? b.entityKey;
      const why = `Replaced by ${entity.key}.`;
      for (const kind of ["approve-pr", "merge"] as const) store.closeNeedByKey(b.id, kind, oldUrl, why);
      for (const x of store.openEscalations(b.id)) if (x.kind === "approval" && x.url === oldUrl) store.resolve(x.id, why);
      const moved = store.patch(b.id, {
        entityId: entity.id,
        entityKey: entity.key,
        url: entity.url,
        title: entity.title,
        phase,
        stage,
        lastSnapshot: { entity, pulls: [] },
        ending: null,
        endingAt: null,
        followThrough: null,
        followThroughUntil: null,
      });
      store.note(moved.id, `${entity.key} replaces ${oldKey}; this steward follows ${entity.key} now.`, true);
      bb.log.info(`stewards: ${oldKey} is replaced by ${entity.key}; the binding follows it`);
      if (moved.threadId !== null) await quietly(`retitle ${entity.key}'s steward`, () => bb.sdk.threads.update({ threadId: moved.threadId!, title: `${entity.key}: ${entity.title}` }));
      await sendInterest().catch((error) => bb.log.warn(`stewards: could not refresh leases after ${oldKey} moved to ${entity.key}: ${errorMessage(error)}`));
      scheduleReconcile(moved.id);
      return { binding: moved };
    }

    function ownBinding(threadId: string): Binding {
      const b = store.byThread(threadId);
      if (b === null || b.endedAt !== null) throw new Error("This thread is not the steward of an open binding.");
      return b;
    }

    const isProjectSteward = (threadId: string, b: Binding) => store.project(b.projectId).threadId === threadId;

    /** Whether `threadId` may steer `target`: its own steward, a steward above it, or its project steward. */
    function mayDirect(threadId: string, target: Binding): boolean {
      if (target.threadId === threadId || isProjectSteward(threadId, target)) return true;
      let up = target.parentBindingId === null ? null : store.binding(target.parentBindingId);
      for (let depth = 0; up !== null && depth < 10; depth++) {
        if (up.threadId === threadId) return true;
        up = up.parentBindingId === null ? null : store.binding(up.parentBindingId);
      }
      return false;
    }

    /** Tell another binding's steward something changed; a binding's own steward already knows. */
    function tell(threadId: string, target: Binding, note: string): void {
      if (target.threadId === threadId) return;
      store.note(target.id, note);
      scheduleReconcile(target.id);
    }

    /**
     * BB-251: the recorded-assumption path of `steward_update`, kept separate so
     * recording files no need, escalation or question. `assume` records,
     * `confirm` confirms an open one, and `resolve: "<asm_…>"` corrects one.
     * Returns the tool reply, or null when the call carries none of the three.
     */
    async function handleAssumptionUpdate(
      input: { assume?: { text: string; context?: string; binding?: string }; confirm?: string; resolve?: string; answer?: string; binding?: string },
      threadId: string,
      projectOf: string | null,
    ): Promise<string | ReturnType<typeof toolError> | null> {
      const resolveId = input.resolve !== undefined && input.resolve.startsWith("asm_") ? input.resolve : undefined;
      const hasAssume = input.assume !== undefined;
      const hasConfirm = input.confirm !== undefined;
      const hasAsmResolve = resolveId !== undefined;
      if (!hasAssume && !hasConfirm && !hasAsmResolve) return null;
      // BB-251 review: an assumption call is its own call. Exactly one of
      // `assume`, `confirm` and an assumption `resolve` is allowed, and no
      // other field may ride along, or the early return would silently drop it.
      // `answer` corrects an assumption, so it goes only with that resolve.
      if ([hasAssume, hasConfirm, hasAsmResolve].filter(Boolean).length > 1) return toolError(new Error("assume, confirm and an assumption resolve are separate calls; give exactly one."));
      const allowed = hasAssume ? ["assume", "binding"] : hasConfirm ? ["confirm", "binding"] : ["resolve", "answer", "binding"];
      const extra = Object.keys(input).filter((k) => !allowed.includes(k) && (input as Record<string, unknown>)[k] !== undefined);
      if (extra.length > 0) return toolError(new Error(`assume, confirm and an assumption resolve are their own call; give one of them alone, not with ${extra.join(", ")}.`));
      if (input.answer !== undefined && !hasAsmResolve) return toolError(new Error("answer corrects an assumption: give it with resolve: \"<assumption id>\"."));

      if (input.assume !== undefined) {
        const bindingRef = input.assume.binding ?? input.binding;
        let target: Binding | null = null;
        if (bindingRef !== undefined) {
          target = store.find(bindingRef, projectOf ?? undefined);
          if (target === null) return toolError(new Error(`No binding for ${bindingRef}.`));
        } else if (projectOf === null) {
          try {
            target = ownBinding(threadId);
          } catch {
            return toolError(new Error("Name the binding (binding: ENG-12) to record an assumption."));
          }
        }
        if (target !== null) {
          if (!mayDirect(threadId, target)) return toolError(new Error(`This thread does not steer ${target.entityKey}.`));
          const config = await loadConfig(target.projectId);
          const playbook = config === null ? null : bindingPlaybook(config, target);
          const cap = playbook?.maxAssumptions ?? 5;
          if (store.countOpenAssumptions(target.id) >= cap) {
            return toolError(new Error(`${target.entityKey} already has ${cap} open assumption${cap === 1 ? "" : "s"}, the playbook's max-assumptions. Ask instead: raise the question as an escalation rather than assuming.`));
          }
        } else if (projectOf === null) {
          return toolError(new Error("Name the binding (binding: ENG-12) to record an assumption."));
        }
        const a = store.addAssumption({ projectId: target?.projectId ?? projectOf!, bindingId: target?.id ?? null, text: input.assume.text, context: input.assume.context ?? null, recordedBy: threadId });
        return `${a.id} recorded${target === null ? " on the project" : ` on ${target.entityKey}`}: ${a.text}. It is not an item for the user; it appears in your wake, the card, \`bb stewards show\` and the project steward's digest. Confirm it with steward_update { confirm: "${a.id}" } once evidence arrives, or correct it with steward_update { resolve: "${a.id}", answer }.`;
      }

      const id = input.confirm ?? resolveId!;
      const a = store.assumption(id);
      if (a === null) return toolError(new Error(`No assumption ${id}.`));
      if (a.state !== "open") return toolError(new Error(`Assumption ${a.id} is already ${a.state}.`));
      let owner: Binding | null = null;
      if (a.bindingId !== null) {
        owner = store.binding(a.bindingId);
        if (owner === null) return toolError(new Error(`Assumption ${a.id}'s binding is gone.`));
        if (!mayDirect(threadId, owner)) return toolError(new Error(`This thread does not steer ${owner.entityKey}.`));
      } else if (projectOf === null || a.projectId !== projectOf) {
        return toolError(new Error(`Only the project steward resolves a project-level assumption (${a.id}).`));
      }
      if (input.confirm !== undefined) {
        store.resolveAssumption(a.id, "confirmed", null, threadId);
        return `Assumption ${a.id} confirmed.`;
      }
      if (input.answer === undefined) return toolError(new Error("Correcting an assumption needs the answer it was wrong about: resolve with `answer`."));
      store.resolveAssumption(a.id, "corrected", input.answer, threadId);
      // A correction wakes the steward with the answer, so a steward that made
      // the wrong call learns it; its own correction needs no wake.
      if (owner !== null && owner.threadId !== null && owner.threadId !== threadId) tell(threadId, owner, `Assumption ${a.id} was corrected: ${input.answer}`);
      await offerAssumptionLesson(a.projectId, a, input.answer);
      return `Assumption ${a.id} corrected: ${input.answer}.${owner !== null && owner.threadId !== null && owner.threadId !== threadId ? " Its steward has been woken with the answer." : ""}`;
    }

    /**
     * BB-251: a corrected assumption is a lesson candidate for the project
     * steward, by the same path and caps as a forwarded escalation's reasoning:
     * a note in its next wake, which it may turn into a lesson itself.
     */
    async function offerAssumptionLesson(projectId: string, a: Assumption, answer: string): Promise<void> {
      const where = a.bindingId === null ? "the project" : (store.binding(a.bindingId)?.entityKey ?? a.bindingId);
      await wakeProject(projectId, "an assumption was corrected", {
        digestDue: false,
        notes: [`Assumption ${a.id} on ${where} was corrected: ${answer}. If the correction is a general judgement the playbook should carry, record it as a lesson with steward_update { lesson: { text, file, scope } }.`],
      });
    }

    /** Whether the user said these words in this thread lately, in their own turn rather than the plugin's own wake (BB-178). */
    async function userSaid(threadId: string, quote: string): Promise<boolean> {
      const want = normalizeText(quote);
      const rows = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: "30" });
      for (const row of rows) {
        if (now() - row.createdAt > timing.approvalLookbackMs) break;
        // A turn from before this plugin started recording its sends cannot be
        // told from the plugin's own wakes, so it is never the owner's (BB-178).
        if (row.createdAt < sentSince) continue;
        const data = row.data as { initiator?: string; input?: unknown };
        if (data.initiator !== "user") continue;
        const text = turnText(data.input);
        if (text === null) continue;
        if (!normalizeText(text).includes(want)) continue;
        // A wake the plugin sent is recorded under its text's hash; it quotes
        // the entity verbatim and must never count as the owner's approval.
        if ((await bb.storage.kv.get(`sent/${sentHash(text)}`)) !== undefined) continue;
        return true;
      }
      return false;
    }

    /**
     * Whether the connected user approved in an unsigned comment on the
     * entity, after the latest spec comment (criterion 3). `quote` is matched
     * against the comment's text, so the steward can quote it back.
     */
    function userApprovedOnEntity(entity: EntitySnapshot | null, stewardThreadId: string | null, quote: string): boolean {
      if (entity === null || entity.viewer === null) return false;
      const viewer = entity.viewer.toLowerCase();
      const latestSpec = entity.comments.filter((c) => isSpecComment(c, stewardThreadId, isUserThread)).reduce((max, c) => (c.createdAt > max ? c.createdAt : max), "");
      const want = quote.replace(/\s+/gu, " ").trim().toLowerCase();
      return entity.comments.some(
        (c) =>
          c.signedBy === null &&
          c.author.toLowerCase() === viewer &&
          c.createdAt > latestSpec &&
          classifyApproval(c.body) === "approve" &&
          c.body.replace(/\s+/gu, " ").toLowerCase().includes(want),
      );
    }

    bb.agents.registerTool({
      name: "steward_report",
      description:
        "End a steward's turn with its status record: where the entity is, what happens next and who does it, what it waits on, and when to wake it if nothing else does. Also records the ready-gate checklist, cites the lessons and hand-written guidance units the turn acted on, voids an approval when the spec changed materially, raises an escalation when something is not yours to decide, and, after a terminal state, keeps the binding open while work remains. Required at the end of every turn you were woken for.",
      presentation: { label: { pending: "Reporting status", completed: "Reported status" } },
      parameters: z.object({
        phase: z.string().trim().min(1).max(100).describe("The entity's phase as you understand it, usually its state."),
        summary: z.string().trim().min(1).max(600).describe("Where the entity is, in a sentence."),
        nextAction: z.string().trim().min(1).max(600).describe("What happens next."),
        actor: z.enum([...ACTORS, "me"]).describe("Who does the next action. `user` means the server's owner has to act — a decision, a credential, a step outside the repos — and leaves the row needing them (unread and ringing). `steward` is you: your own next step, including re-checking on the next deployment wake, is `steward`, not `user`. On BB-95 a steward filed \"On the next deployment wake, re-run the carries check and report deployed or not-yet\" as `me` and the row wrongly read \"needs you\"; that next step is `steward`. `other` is someone else."),
        waitingOn: z.string().trim().max(300).optional().describe("The party or artifact the next action waits on: checks, a review, a deployment, another team. It never marks the effort blocked — a hold, an open `stuck` escalation or a needs item does."),
        blockedOn: z.string().trim().max(300).optional().describe("Deprecated alias for `waitingOn`, accepted for one release; `waitingOn` wins when both are given."),
        requeueAfter: durationSchema.optional().describe('When to wake you if nothing else does, such as "4h" or "2d". The playbook\'s default when left out.'),
        until: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe('A dated wait: when the thing you wait on has a known end. A date ("2026-12-01", read as 00:00 UTC) or an ISO datetime. It requeues you then instead of requeueAfter, no stall is counted while it is ahead, and it needs waitingOn. A date in the past is ignored with a note. Beyond the playbook\'s `max-wait` (default 90d) it is accepted and noted once to the project steward.'),
        conditions: z.array(z.string().trim().min(1).max(200)).max(10).optional().describe("Anything else a reader of the status should know at a glance."),
        ready: z
          .object({
            checklist: z
              .array(
                z.object({
                  item: z.union([z.number().int().min(1).max(30), z.string().trim().min(1).max(300)]).describe("The item's number in the wake's ready gate (1 is the first)."),
                  met: z.boolean(),
                  note: z.string().trim().max(300).optional(),
                }),
              )
              .max(30)
              .optional(),
            substantial: z.boolean().optional(),
            why: z.string().trim().max(600).optional(),
          })
          .optional()
          .describe("The ready gate as you judge it now: every checklist item from the wake, by its number, met or not, and whether the ticket is substantial. On a review binding there is no checklist; report `substantial` and `why` alone, the reviewer's judgment of the diff."),
        voidApproval: z.boolean().optional().describe("The spec changed materially since approval: void it and ask again."),
        touches: z
          .array(z.string().trim().min(1).max(200))
          .max(40)
          .optional()
          .describe('The repo-relative files this work changes, repo directory first ("bb-plugins/plugins/stewards/wake.ts", "bb-gate/docker/bb-server/Dockerfile"); the whole set, replacing what was reported before. A directory is accepted and counts as every file under it. The project steward schedules tickets whose files overlap one after another, and stacks a ticket on a pull request still being built. Report it once the spec names the affected repos; refine it as pull requests open.'),
        cites: z
          .array(z.string().trim().min(1).max(100))
          .max(20)
          .optional()
          .describe("The lesson ids (lsn_…) and hand-written guidance unit ids (gu_…) this turn acted on. A lesson's hits count once per distinct binding, so a repeat from the same binding adds none, and they feed the promotion and retirement thresholds exactly as a resolve's cites do. Unknown ids are ignored and named in the reply; the report never fails because of them. A citation never counts as a correction: corrections stay a project-steward act."),
        noMorePulls: z
          .boolean()
          .optional()
          .describe('Ticket stewards: true once no more pull requests are coming for this ticket, so its work is finished when its linked pull requests have merged and its hold can lift silently. Set it again as more pull requests open: reporting false (more are coming), or a new linked pull request, clears it.'),
        replacedBy: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .optional()
          .describe('Pull-request stewards: the open pull request that replaces this one (owner/repo#N or its URL), opened on its own branch when this one could not merge as is. The binding moves to it: the gate, the Merge item and every later wake are about the replacement, and this pull request is closed by whoever opened the replacement. Report it once, as soon as the replacement is open.'),
        mergeBehind: z
          .array(z.string().trim().min(1).max(100))
          .max(20)
          .optional()
          .describe('A merge hold: entity keys of open bindings in this project whose work must finish before this binding\'s pull request is merged, like steward_update\'s behind. While it stands the plugin files no Merge item (so the page does not read as "needs you"), the binding shows as held, and it is a live wake source. Report it when a spec says "do not merge before X is Done"; the hold lifts itself, and you are woken, once every named binding has merged its pull requests or ended. Each report replaces the set; `mergeBehind: []` clears it.'),
        needs: z
          .array(
            z.object({
              kind: z.enum(NEEDS_KINDS).describe("approve-spec, approve-pr, merge, decide, provide-secret, or configure."),
              url: z.string().trim().max(500).optional().describe("The link: the entity, the pull request, the external page, or the worker thread."),
              what: z.string().trim().min(1).max(300).describe("One line saying what the user must do."),
              how: z.string().trim().max(4000).optional().describe("The steps, in Markdown."),
              variable: z.string().trim().max(200).optional().describe("provide-secret: the variable name."),
              purpose: z.string().trim().max(500).optional().describe("provide-secret: what the value is for."),
              worker: z.string().trim().max(200).optional().describe("provide-secret: the worker thread that will request it; its link is used when url is left out."),
              writeEnv: z.string().trim().max(500).optional().describe("provide-secret: the dotenv path the requester writes (case A); defaults to the named worker's thread storage."),
              setting: z.string().trim().max(200).optional().describe("provide-secret: the stewards plugin secret setting the value goes to (case B); only a declared secret setting is accepted."),
              page: z.string().trim().max(500).optional().describe("configure: the external page where the step happens."),
              choices: choicesSchema.optional().describe('decide only: 2-6 short labels the user picks between (["Merge", "Close", "Verify first"]); the page shows one button each, so do not write "reply with your choice" in prose.'),
            }),
          )
          .max(20)
          .optional()
          .describe("Things only the user can do. They appear on the Stewards page with their buttons, and are deduplicated by (binding, kind, url), so re-reporting updates the wording."),
        escalate: z
          .object({
            kind: z.enum(ESCALATION_KINDS).describe("blocked, decision, scope (the scope must change), conflict (the entity's state contradicts the playbook), or stuck."),
            question: z
              .string()
              .trim()
              .min(1)
              .max(240, "The question is the one line the sidebar row shows; keep it to 240 characters and put the evidence and reasoning in `context`.")
              .describe("The one-line ask, as the sidebar row shows it. Put the why in context."),
            context: z.string().trim().max(3000).optional().describe("What the reader needs to decide: the evidence and the reasoning. Not shown in the sidebar row."),
            meanwhile: z.string().trim().min(1).max(600).describe("What you do meanwhile: wait, continue the unblocked part, or proceed with a stated default."),
            choices: choicesSchema.optional().describe("decision only: 2-6 short labels the user picks between, so the page (or the question forwarding it) shows one button each instead of asking in prose."),
            distinctFrom: z
              .array(z.string().trim().min(1).max(100))
              .max(20)
              .optional()
              .describe("When the binding has open items for the user (a plugin need, a route-user escalation, an open question), each of their ids (need_…, esc_…, qst_…) this escalation is distinct from. Required, and must name every one, when any is open; leave it out when none is. It is a pairwise judgement, never a subject label."),
          })
          .optional()
          .describe("Something the project's guidance does not let you decide. It goes to your parent steward, then the project steward; the answer comes back as guidance and wakes you."),
        followThrough: z
          .string()
          .trim()
          .min(1)
          .max(600)
          .optional()
          .describe("Only after a terminal state (a wrap-up or follow-through turn): what remains to finish, such as a worker watching the deploy and verifying it. The binding stays open, its workers keep running, and you are woken as usual. Leave it out once the work is done, and the binding ends after this turn."),
        deployment: deploymentReportSchema
          .optional()
          .describe("After a deployment doorbell (BB-53): whether the deployment carries this merge. Use the playbook's rule to decide: `deployed` when it carries it, `not-yet` when it does not, `failed` when it failed. Name the pull request with `key` when the binding watches more than one."),
        opsTickets: z
          .array(
            z.object({
              fingerprint: z.string().trim().min(1).max(400).describe("The problem's fingerprint, as the wake gives it."),
              ticket: z.string().trim().regex(/^(?:[A-Za-z][A-Za-z0-9]*-\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)$/u, "a Linear key such as OPS-12 or a GitHub issue key such as acme/web#12").describe("The Linear ticket or GitHub issue."),
              did: z.enum(["filed", "commented", "reopened"]),
            }),
          )
          .max(20)
          .optional()
          .describe("Ops stewards only: every ticket you filed, commented on or reopened this turn, by fingerprint. The next look then treats the problem as filed under that ticket, so a recurrence is a comment there and nothing new."),
      }),
      execute: store.coalescingTool(async (input, { threadId }) => {
        try {
          // BB-97: `me` is the old name for `user`. Accept it for one release
          // so a steward whose prompt predates the rename is not wedged: it is
          // normalised here and the stored value is always `user`.
          const actor: (typeof ACTORS)[number] = input.actor === "me" ? "user" : input.actor;
          if (input.actor === "me") bb.log.info(`stewards: steward_report actor "me" is renamed to "user"; recording this report as user (thread ${threadId}).`);
          let b = ownBinding(threadId);
          // Validate the input that does not depend on which pull request the
          // binding is on before a replacement moves it: a wrap-up report that
          // carries `replacedBy` and `followThrough` (the natural combination
          // in the turn the old pull request closed) must not move the binding
          // and then refuse the rest of itself.
          const opsTickets = input.opsTickets ?? [];
          if (opsTickets.length > 0) {
            if (b.kind !== "ops") return toolError(new Error("opsTickets is for an ops steward's report. Report without it."));
            const unknown = opsTickets.filter((t) => store.fingerprint(b.projectId, t.fingerprint) === null).map((t) => JSON.stringify(t.fingerprint));
            if (unknown.length > 0) {
              const known = [...(b.opsLook?.findings ?? []), ...(b.sentryLook?.findings ?? []), ...(b.depsLook?.alerts ?? [])].map((f) => `- ${f.fingerprint}`).join("\n");
              return toolError(new Error(`Nothing was recorded: ${unknown.join(", ")} ${unknown.length === 1 ? "is not a fingerprint" : "are not fingerprints"} this project has seen. Use them as the wake gives them${known === "" ? "." : `:\n${known}`}`));
            }
          }
          // `followThrough` is judged against the ending the report found: a
          // replacement undoes a terminal ending, so the wrap-up report that
          // moves the binding may still carry it.
          const endingBefore = b.ending;
          if (input.followThrough !== undefined && endingBefore !== "terminal") {
            return toolError(new Error(`followThrough is only for after a terminal state, and ${b.entityKey} is not in one now. Report without it.`));
          }
          // Fixed choices are for a decision, as a `decide` need is: they are
          // what a forwarded escalation turns into a question with buttons.
          if (input.escalate !== undefined && input.escalate.choices !== undefined && input.escalate.kind !== "decision") {
            return toolError(new Error("choices are for a decision escalation: escalate a decision with choices."));
          }
          // A replacement pull request moves the binding before the gate is
          // judged: the terminal state of the one it replaces no longer ends
          // it, and the gate below reads the replacement.
          let replacedNote = "";
          if (input.replacedBy !== undefined) {
            const moved = await replaceBinding(b, input.replacedBy);
            if ("error" in moved) return toolError(new Error(moved.error));
            replacedNote = ` ${moved.binding.entityKey} replaces ${b.entityKey}: the gate, the Merge item and your wakes now follow it.`;
            b = moved.binding;
          }
          // BB-256: a merge hold names open bindings in this project, validated
          // the way steward_update's `behind` is: an unknown or ended key, or
          // the binding itself, is refused whole. BB-264 also accepts the base
          // pull request of a stack by its key (`owner/repo#N`), which may not
          // be an adopted binding, when it is an open pull request. Each report
          // replaces the set, and `mergeBehind: []` clears it.
          let mergeBehind: string[] | undefined;
          if (input.mergeBehind !== undefined) {
            const missing: string[] = [];
            const named: Binding[] = [];
            const prKeys: string[] = [];
            for (const k of input.mergeBehind) {
              const other = store.find(k, b.projectId);
              if (other !== null && other.endedAt === null && other.id !== b.id) {
                if (!named.some((x) => x.id === other.id)) named.push(other);
                continue;
              }
              const ref = parsePullRef(k);
              const pull = ref === null ? null : await snapshot("github", `${ref.repo}#${ref.number}`).catch(() => null);
              if (pull !== null && pull.kind === "pull" && lc(pull.state) !== "closed" && pull.pull?.merged !== true) {
                const key = `${ref!.repo}#${ref!.number}`;
                if (!prKeys.some((x) => lc(x) === lc(key))) prKeys.push(key);
                continue;
              }
              missing.push(k);
            }
            if (missing.length > 0) return toolError(new Error(`Not an open binding or pull request in this project to hold the merge behind: ${missing.join(", ")}.`));
            mergeBehind = [...named.map((x) => x.entityKey), ...prKeys];
          }
          // BB-231: a free-form escalation must say how it differs from every
          // open user-facing item on the binding, or it can duplicate the
          // plugin's gate item. The pairwise judgement is forced here; no
          // subject is ever inferred from the escalation's text.
          if (input.escalate !== undefined) {
            const openItems = userItemsFor(b);
            if (openItems.length > 0) {
              const named = new Set(input.escalate.distinctFrom ?? []);
              const unnamed = openItems.filter((item) => !named.has(item.id));
              if (unnamed.length > 0) {
                return toolError(
                  new Error(
                    `Nothing was recorded: ${b.entityKey} has open items for the user, and a new escalation must say how it differs from each (escalate.distinctFrom). Name ${openItems.length === 1 ? "it" : "them"}:\n` +
                      openItems.map((item) => `- ${item.id} (${item.kind}): ${item.text}`).join("\n"),
                  ),
                );
              }
            }
          }
          // The gate as it stood before this report, so the reply can tell a
          // report that just passed it from one that finds it already passed.
          const priorReady = b.ready;
          const priorSnapshot = b.lastSnapshot;
          const config = await loadConfig(b.projectId);
          const playbook = config === null ? null : bindingPlaybook(config, b);
          const priorGate = playbook !== null && playbook.ready !== null ? gateState(playbook, priorReady, priorSnapshot === null ? (priorReady.approval?.specHash ?? "") : specHashFor(b, priorSnapshot.entity)) : null;
          // A terminal binding that raises an escalation, or already has one
          // open, keeps the binding open on that question: the report must not
          // reset its follow-through to null, or the plugin ends the binding,
          // auto-resolves the escalation and leaves the user's question
          // unanswered (BB-60).
          const openBeforeReport = b.ending === "terminal" ? store.openEscalations(b.id) : [];
          const escalationFollowThrough = b.ending !== "terminal" ? null : (input.escalate?.question ?? openBeforeReport[0]?.question ?? null);
          const followThrough = input.followThrough ?? escalationFollowThrough;
          // Follow-through has one deadline from when it was first declared; a
          // requeue past it is a requeue at it.
          const followThroughUntil = b.ending !== "terminal" ? null : (b.followThroughUntil ?? (followThrough === null ? null : now() + (playbook?.followThroughMs ?? DEFAULT_FOLLOW_THROUGH_MS)));
          let ready = b.ready;
          if (input.ready !== undefined) {
            // Stored in the playbook's own words, so the gate matches what was meant.
            const items = playbook?.ready?.checklist ?? null;
            const checklist = new Map<string, ReadyState["checklist"][number]>();
            const unknown: string[] = [];
            for (const c of input.ready.checklist ?? []) {
              const item = items === null ? String(c.item) : resolveChecklistItem(items, c.item);
              if (item === null) unknown.push(JSON.stringify(c.item));
              else checklist.set(item, { item, met: c.met, note: c.note ?? null });
            }
            if (unknown.length > 0) {
              const numbered = items!.map((item, i) => `${i + 1}. ${item}`).join("\n");
              throw new Error(`Nothing was recorded: ${unknown.join(", ")} ${unknown.length === 1 ? "is not a ready checklist item" : "are not ready checklist items"}. Report each item by its number:\n${numbered}`);
            }
            ready = {
              ...ready,
              ...(input.ready.checklist === undefined ? {} : { checklist: [...checklist.values()] }),
              substantial: input.ready.substantial ?? ready.substantial,
              why: input.ready.why ?? ready.why,
            };
          }
          if (input.voidApproval === true && ready.approval !== null) ready = { ...ready, approval: null, voidedAt: now(), voidedApprovedText: ready.approval.approvedText, voidedApprovedAt: ready.approval.at };
          // BB-109: `blockedOn` is the old name for `waitingOn`. Accept it for
          // one release so a steward whose prompt predates the rename still
          // reports cleanly; `waitingOn` wins when both are given, and only the
          // new name is stored. An empty string is no wait, so it stores null
          // rather than rendering a bare "Waiting on ".
          const rawWaitingOn = input.waitingOn ?? input.blockedOn ?? null;
          const waitingOn = rawWaitingOn === "" ? null : rawWaitingOn;
          if (input.blockedOn !== undefined && input.waitingOn === undefined) bb.log.info(`stewards: steward_report blockedOn is renamed to waitingOn; recording this report's wait (thread ${threadId}).`);
          // BB-247: a dated wait. Parse it before anything is written, so an
          // invalid value or an `until` with no `waitingOn` is refused whole.
          // A date in the past is ignored with a note, and a future date parks
          // the binding there: it is the requeue, and no stall is counted while
          // it is ahead. Each report replaces the date (a report without one
          // clears it), so an old date can never suppress counting or delay a
          // requeue.
          let untilAt: number | null = null;
          let untilNote = "";
          if (input.until !== undefined) {
            if (waitingOn === null || waitingOn.trim() === "") {
              return toolError(new Error("until needs waitingOn: report the wait it is for, or leave until out."));
            }
            const parsed = parseUntil(input.until);
            if (parsed === null) {
              return toolError(new Error(`until must be a date (YYYY-MM-DD) or an ISO datetime; ${JSON.stringify(input.until)} is not.`));
            }
            if (parsed <= now()) {
              untilNote = ` The until date ${iso(parsed)} is in the past, so it was ignored; the wait requeues on the playbook default.`;
            } else {
              untilAt = parsed;
            }
          }
          // `until` wins over an explicit `requeueAfter` in the same report. The
          // deployment-deadline min below is untouched; a dated wait is not
          // capped by `requeue-default`.
          const requeueMs = untilAt !== null ? untilAt - now() : Math.min(input.requeueAfter ?? playbook?.requeueDefaultMs ?? 2 * 86_400_000, followThroughUntil === null ? Infinity : Math.max(60_000, followThroughUntil - now()));
          const requeuePhrase = untilAt !== null ? `at ${iso(untilAt)}` : `in ${formatDuration(requeueMs)}`;
          // A status that waits on the user, the owner or a human has to say so
          // with an item, not only in prose: the item is what reaches the page.
          // An auto-filed need does not satisfy this: it is filed from prose,
          // not the item the user acts on, so a wait naming the user still
          // needs a real item or escalation (BB-213).
          if (waitingOn !== null && namesUserAsBlocker(waitingOn) && store.openNeeds(b.id).filter((n) => !isAutoFiledNeed(n)).length === 0 && (input.needs ?? []).length === 0) {
            return toolError(
              new Error(
                `waitingOn names the user, the owner or a human, but nothing is filed for them. File it as a needs item (steward_report { needs: [{ kind, url, what, how }] }) — or, for a credential, a step outside the repos or a decision, raise it with steward_report { escalate: { kind, question, meanwhile } } — and it appears on the Stewards page; waitingOn stays for third parties.`,
              ),
            );
          }
          for (const t of opsTickets) store.recordTicket(b.projectId, t.fingerprint, t.ticket, t.did, threadId);
          if (opsTickets.length > 0) {
            // A dependency ticket filed for a severity deps.autoAdopt does not
            // name gets its adoption decision now, not at the next look, so
            // `bb stewards needs` shows it the moment the ticket exists.
            if (config !== null && parseOpsTargetKey(b.entityId)?.kind === "dependabot") {
              const filed = new Map<string, Fingerprint[]>();
              for (const t of opsTickets.filter((x) => x.did === "filed" || x.did === "reopened")) {
                const row = store.fingerprint(b.projectId, t.fingerprint);
                if (row === null || row.ticketKey === null) continue;
                filed.set(row.ticketKey, [...(filed.get(row.ticketKey) ?? []), row]);
              }
              for (const [ticketKey, rows] of filed) {
                if (rows.every((r) => autoAdopted(r.severity, config))) continue;
                const alerts = (b.depsLook?.alerts ?? []).filter((a) => rows.some((r) => r.fingerprint === a.fingerprint));
                const ticket = await ticketStates(filingTargetFor(config), [ticketKey]).then((m) => m.get(ticketKey) ?? null).catch(() => null);
                if (ticket !== null && (ticketResolved(ticket) || (ticket.labels ?? []).some((l) => lc(l) === lc(config.file.label)))) continue;
                // The deadline is the earliest the look computed for the
                // ticket's alerts (alert created_at + SLA), the same date the
                // wake showed the steward when it filed.
                const dueAt = alerts.length > 0 ? Math.min(...alerts.map((a) => a.dueAt)) : deadlineAt((rows[0]!.severity ?? "medium") as DependabotSeverity, config.file.deps.sla, now());
                raiseAdoption(b, config, ticketKey, rows, alerts, ticket, dueAt);
              }
            }
          }
          // BB-53: a deployment verdict the steward reached from the playbook's
          // rule. `deployed` settles the watch; `not-yet` puts it back to
          // awaiting; `failed` marks it failed. Once every watch is deployed
          // the plugin notes it, so the next reconcile wakes the steward for
          // the one closing comment.
          let deployments = b.deployments;
          let deploymentNote = "";
          if (input.deployment !== undefined) {
            const targets = playbook?.deployments ?? [];
            if (targets.length === 0) return toolError(new Error(`${b.entityKey}'s playbook names no deployment target, so there is no deployment to report.`));
            const watch = pickWatch(b.deployments, input.deployment);
            if (watch === null) return toolError(new Error(`No deployment is awaiting a verdict for ${b.entityKey}${input.deployment.key === undefined ? "" : ` (${input.deployment.key})`}. A deployment doorbell must arrive first.`));
            const target = targets.find((t) => (watch.target === "" ? matchesTarget(t, watch.repo, watch.environment) : targetKeyOf(t) === watch.target)) ?? targets[0]!;
            const result = reportDeployment(b.deployments, input.deployment, now(), target.timeout);
            if (result.changed === null) return toolError(new Error(`No deployment is awaiting a verdict for ${b.entityKey}${input.deployment.key === undefined ? "" : ` (${input.deployment.key})`}. A deployment doorbell must arrive first.`));
            deployments = result.deployments;
            deploymentNote = ` ${result.changed.key} is ${result.changed.state}.`;
            if (allDeployed(deployments)) {
              const where = targets.map((t) => `${t.repo} ${t.environment}`).join(", ");
              store.note(b.id, `Every pull request is merged and deployed (${where})`, false);
              scheduleReconcile(b.id);
            }
          }
          // A Sentry issue with a ticket is leased by itself, so its next event rings even outside the project lease.
          if (opsTickets.length > 0 && parseOpsTargetKey(b.entityId)?.kind === "sentry-project") {
            sentryHooks.added("issue", ...opsTickets.map((t) => t.fingerprint)).catch((error: unknown) => bb.log.warn(`stewards: could not lease a Sentry issue right away: ${errorMessage(error)}`));
          }
          // Delivered after the status is written, together with any approval
          // request this report makes due, so the project steward reads the
          // new status and is woken once.
          const raised = input.escalate === undefined ? null : store.escalate({ bindingId: b.id, kind: input.escalate.kind, question: input.escalate.question, context: input.escalate.context ?? null, meanwhile: input.escalate.meanwhile, route: nextRoute(b, null), recommendation: null, projectId: b.projectId, origin: { threadId, bindingId: b.id, chain: [] }, ...(input.escalate.choices === undefined ? {} : { choices: input.escalate.choices }) });
          const open = store.openEscalations(b.id);
          const status = {
            phase: input.phase,
            summary: input.summary,
            nextAction: input.nextAction,
            actor,
            waitingOn,
            requeueAfterMs: requeueMs,
            conditions: [...(input.conditions ?? []), ...open.map((x) => `${x.kind} escalation with ${x.route}`)],
            resources: {
              workers: store.workers(b.id).filter((w) => w.status === "running").map((w) => w.title),
              pullRequests: (b.lastSnapshot?.pulls ?? []).map((p) => p.key).concat(b.lastSnapshot?.entity.pull !== null && b.lastSnapshot !== null ? [b.lastSnapshot.entity.key] : []),
              children: store.children(b.id).map((c) => c.entityKey),
            },
            at: now(),
          };
          const moved = advanced(b.status, status);
          // BB-154: consume the wake reason here; the mark and the
          // requeue-only run are decided after this report's own needs are
          // filed, so an item the turn files counts as a source.
          const wakeReason = b.lastWakeReason;
          // BB-247: a wait beyond the playbook's `max-wait` is accepted but the
          // project steward is told once for that date. The flag is the date
          // already noted, so re-reporting the same date adds nothing; a
          // different date is a new note.
          const maxWaitMs = playbook?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
          const noteBeyondMaxWait = untilAt !== null && untilAt - now() > maxWaitMs && b.requeueUntilNoted !== untilAt;
          if (noteBeyondMaxWait) untilNote += ` The date is beyond the playbook's max-wait (${formatDuration(maxWaitMs)}); the project steward is told once.`;
          b = store.patch(b.id, {
            status,
            statusAt: now(),
            lastWakeReason: null,
            ...(moved ? { advancedAt: now() } : {}),
            requeueAt: (() => {
              const at = now() + requeueMs;
              const deadline = deploymentDeadline(deployments);
              return deadline === null ? at : Math.min(at, deadline);
            })(),
            requeueUntil: untilAt,
            ...(noteBeyondMaxWait ? { requeueUntilNoted: untilAt } : {}),
            awaitingReport: false,
            missedReports: 0,
            // BB-255: a report ends any wake failure and drops the steward's
            // pending retry; a newer wake supersedes it too (see `send`).
            wakeFailure: null,
            ready,
            deployments,
            // A deployment verdict changes a watch: the idle clock starts a new
            // period, so a binding that goes idle again is looked at (BB-83).
            ...(input.deployment === undefined ? {} : { idleSince: now(), idleWokenAt: null }),
            ...(input.touches === undefined ? {} : { touches: normalizeTouches(input.touches) }),
            ...(input.noMorePulls === undefined ? {} : { noMorePulls: input.noMorePulls ? true : null }),
            ...(input.noMorePulls === false && b.noMorePulls === true && b.scheduleAsked.length > 0 ? { scheduleAsked: [] } : {}),
            ...(mergeBehind === undefined ? {} : { mergeBehind }),
            ...(b.ending === "terminal" ? { followThrough, followThroughUntil } : {}),
          });
          // BB-255: the report supersedes any retry the plugin had pending,
          // deleting its queued row too.
          if (b.threadId !== null) await clearWakeRetry(b.threadId);
          if (noteBeyondMaxWait) {
            store.noteProject(b.projectId, `${b.entityKey} reported a dated wait beyond the playbook's max-wait (${formatDuration(maxWaitMs)}): waiting on ${JSON.stringify(waitingOn ?? "")} until ${iso(untilAt!)}.`);
          }
          const requested = playbook === null ? null : await syncApprovalRequest(b, playbook);
          const scheduling = playbook === null ? null : await syncScheduleRequest(b, playbook);
          // An `approve-pr` or `merge` item is filed only when the lane gate
          // can hold it: the page's Approve and Merge buttons are already
          // guarded this way, and filing one the gate cannot hold would be
          // closed again by syncNeeds in this same call, silently.
          const refused: string[] = [];
          let mergeFiled = false;
          // BB-253: the gate items this report files itself (`approve-spec`,
          // `approve-pr`, `merge`) are filed before `syncNeedsFresh` runs, so
          // `syncNeeds`' own `needsBefore` already holds them and would never
          // push them. Capture the open ids here and push the new ones right
          // after the loop, before `syncNeedsFresh` (which pushes the items it
          // files itself, so nothing is pushed twice).
          const needsBeforeReport = new Set(store.openNeeds(b.id).map((n) => n.id));
          for (const n of input.needs ?? []) {
            // The plugin files the gate items (approve-spec, approve-pr, merge);
            // a credential, a step outside the repos or a decision is an
            // escalation now (BB-30), so it is refused here and pointed at
            // steward_report { escalate }. The list is one constant, so the
            // refusal cannot drift from the standing rules (BB-51).
            if ((ESCALATED_NEED_KINDS as readonly string[]).includes(n.kind)) {
              refused.push(`${n.kind} for ${n.what} not filed: that is an escalation now. Raise it with steward_report { escalate: { kind, question, meanwhile } } and the project steward forwards it, or answers it itself.`);
              continue;
            }
            if (n.kind === "approve-pr" || n.kind === "merge") {
              const url = n.url ?? n.worker ?? b.url ?? "";
              const wanted = lc(url);
              const pull = b.lastSnapshot === null ? undefined : observedPulls(b, b.lastSnapshot).find((p) => [p.url, p.key, p.id].some((v) => v !== null && lc(v) === wanted));
              // The decide list places the pull request, so a steward cannot
              // file the user's item for the project steward's lane (BB-51).
              const decision = pull === undefined ? "user" : decideForPull(await pullChangedFiles(pull), config?.file.bigDecisions ?? []);
              const gate = pull === undefined ? null : prGate(pull, { decision, projectApprovals: projectApprovalsFor(b), ...productGateOptions(b, pull) });
              const holdable = gate !== null && (n.kind === "approve-pr" ? gate.needsOwnerApproval : gate.gateMet);
              if (!holdable) {
                refused.push(`${n.kind} for ${url === "" ? "the pull request" : url} not filed: ${gate?.missing ?? "the pull request has not been observed yet"}. The owner is asked only once the reviewer's marker says approved; the worker must run the build-tickets review loop first.`);
                continue;
              }
            }
            if (n.choices !== undefined) {
              refused.push(`${n.kind} for ${n.url ?? "the item"} not filed: choices are for a decide item, which is an escalation now.`);
              continue;
            }
            store.fileNeed({
              bindingId: b.id,
              kind: n.kind,
              url: n.url ?? n.worker ?? b.url ?? "",
              what: n.what,
              how: n.how ?? null,
              data: {},
              filedBy: "steward",
            });
            if (n.kind === "merge") mergeFiled = true;
          }
          await pushNewGateNeeds(b, needsBeforeReport);
          // BB-175: filing a merge item hands the merge to a person, so the
          // binding's workers are done. Stop them now, keeping each result, so
          // a `finished` record cannot deadlock the item it was filed to
          // resolve. A steward that wants a worker to keep going wakes it
          // instead of filing the item.
          if (mergeFiled) await stopWorkers(b);
          const refusalNote = refused.length === 0 ? "" : ` ${refused.join(" ")}`;
          if (playbook !== null && b.lastSnapshot !== null) await syncNeedsFresh(b, playbook);
          // BB-213: a report whose actor is `user` but that filed nothing for
          // them gets one `decide` item from its `nextAction`, so the badge and
          // the effort page's "Needs you" section agree. A re-report updates
          // the same item; a later report with another actor, or one that files
          // its own item, closes it. A report whose own item was refused does
          // not get one: the refusal says the user is not the actor yet.
          const autoFiled = reconcileAutoNeed(b, actor, refused.length > 0);
          const autoNote =
            autoFiled === null
              ? ""
              : ` Nothing else was filed for the user, so ${autoFiled.id} (${autoFiled.kind}) is on the Stewards page from your nextAction, with Done as its only button. If the real ask is a specific item (approve-pr) or an escalation, file that next time.`;
          const filingNote = `${refusalNote}${autoNote}`;
          // BB-154: the mark and the requeue-only run, over the report's final
          // set of sources (an escalation this turn raised, a need it filed, a
          // gate item syncNeeds filed, a worker it started).
          const current = store.binding(b.id) ?? b;
          const liveSource = liveWakeSourceFor(current);
          // BB-247: a dated wait is the plugin's own wake source while the date
          // is ahead, so it is not marked waiting with no source (and is listed
          // as a dated wait in the digest instead).
          const datedFuture = current.requeueUntil !== null && current.requeueUntil > now();
          const noWakeSource = waitingOn !== null && waitingOn.trim() !== "" && !liveSource && !datedFuture;
          const stall = advanceStall(
            { count: current.requeueWakeCount, waitText: current.requeueWaitText, firstAt: current.requeueFirstAt },
            { reason: wakeReason, waitingOn, liveSource, now: now(), until: current.requeueUntil },
          );
          b = store.patch(b.id, { noWakeSource, requeueWakeCount: stall.state.count, requeueWaitText: stall.state.waitText, requeueFirstAt: stall.state.firstAt });
          const requests = [requested === null ? null : "approval", scheduling === null ? null : "scheduling"].filter((r) => r !== null);
          // BB-154: at the threshold, raise one `stall` to the project steward.
          // An open `stall` is itself a live source, so the next report resets
          // the run; the explicit check keeps a second one from being filed.
          let stallEscalation: Escalation | null = null;
          if (stall.escalate && !store.openEscalations(b.id).some((x) => x.kind === "stall")) {
            const count = stall.state.count;
            const waitText = stall.state.waitText ?? "";
            const firstAt = stall.state.firstAt ?? now();
            stallEscalation = store.escalate({
              bindingId: b.id,
              kind: "stall",
              question: `${b.entityKey} has woken by requeue ${count} time${count === 1 ? "" : "s"} with the same wait (${JSON.stringify(waitText)}), first reported ${iso(firstAt)}, and nothing the plugin tracks will deliver it.`,
              context: `The steward's waitingOn is free text and no structured source is live on the binding: no open holdBehind, no merge hold, no deployment watch in merged/deploying, no running worker, no open escalation or need, no pull-request watch. It will keep waking by requeue alone.`,
              meanwhile: "Waiting: the steward keeps reporting the same wait and is woken only by another requeue.",
              route: "project",
              recommendation: null,
              projectId: b.projectId,
              origin: { threadId, bindingId: b.id, chain: [] },
            });
            bb.log.info(`stewards: ${b.entityKey} has requeued ${count} times with the same wait; escalated a stall (${stallEscalation.id})`);
          }
          if (raised !== null && !(raised.route === "project" && requests.length > 0)) await deliver(b, raised);
          if (requests.length > 0) await wakeProject(b.projectId, raised !== null && raised.route === "project" ? `escalation and ${requests.join(" and ")} request from ${b.entityKey}` : `${requests.join(" and ")} requested for ${b.entityKey}`, { digestDue: false });
          if (stallEscalation !== null && requests.length === 0 && !(raised !== null && raised.route === "project")) await deliver(b, stallEscalation);
          // The unread dot means "needs you": a turn that ends with nothing for
          // the user is marked read, so a "nothing to do yet" look does not
          // flag the sidebar like a question does. A turn that does need the
          // user is left unread. A terminal ending archives the thread, so
          // there is no read state to set.
          if (b.ending !== "terminal" && !needsUser(b)) {
            await quietly(`mark ${b.entityKey}'s steward read`, () => bb.sdk.threads.markRead({ threadId }));
          }
          if (moved && b.parentBindingId !== null) {
            const parent = store.binding(b.parentBindingId);
            if (parent !== null && parent.endedAt === null) tell(threadId, parent, `Child ${b.entityKey}: ${status.summary} Next: ${status.nextAction} (${status.actor})`);
          }
          const escalated = `${raised === null ? "" : ` Escalation ${raised.id} is with ${raised.route === "parent" ? "your parent steward" : "the project steward"}; do what you said meanwhile.`}${stallEscalation === null ? "" : ` Stall escalation ${stallEscalation.id} is with the project steward: nothing the plugin tracks will deliver your wait (${JSON.stringify(stall.state.waitText ?? "")}); name what will, or re-examine it.`}`;
          // Where the gate stands after this report, so a miss shows now and not at the next wake.
          let gateNote = "";
          let gateJustPassed = false;
          if (input.ready !== undefined && playbook !== null && playbook.ready !== null) {
            const gate = gateState(playbook, ready, b.lastSnapshot === null ? "" : specHashFor(b, b.lastSnapshot.entity));
            gateJustPassed = gate.passed && priorGate !== null && !priorGate.passed;
            const unmet = gate.unmet.map((item) => playbook.ready!.checklist.indexOf(item) + 1);
            const why = !gate.checklistMet ? `unmet: ${unmet.join(", ")}` : gate.approvalStale ? "the approval is stale" : "approval is needed";
            gateNote = gate.passed ? " Ready gate: passed." : ` Ready gate: not passed (${why}).`;
          }
          const approvalEscalations = store.openEscalations(b.id).filter((x) => x.kind === "approval");
          const specEscalation = approvalEscalations.find((x) => x.resolutionKind !== "approve-decline");
          const specNeed = store.openNeeds(b.id).find((n) => n.kind === "approve-spec");
          const approvePrNeeds = store.openNeeds(b.id).filter((n) => n.kind === "approve-pr");
          const holder = (route: Escalation["route"]): string => (route === "user" ? "the user" : route === "project" ? "the project steward" : route === "parent" ? "your parent steward" : "you");
          // BB-231: the gate note is read from the record, so a PR approval is
          // never called a spec approval. `resolutionKind` says which it is
          // (`approve-decline` is the pull request's page item); the route says
          // who holds it; the item id is named whenever the plugin filed one.
          const approvalNotes: string[] = [];
          if (specNeed !== undefined) {
            approvalNotes.push(`Approval of the spec is requested from the user, on the Stewards page (${specNeed.id}): they press Approve or Decline there.`);
          } else if (specEscalation !== undefined) {
            approvalNotes.push(`Approval of the spec is requested from ${holder(specEscalation.route)} (${specEscalation.id}); wait for it, and do not escalate for it.`);
          }
          for (const need of approvePrNeeds) {
            approvalNotes.push(`Approval of ${need.what.replace(/^Approve\s+/u, "").replace(/\s+on GitHub$/u, "")} is requested from the user, on the Stewards page (${need.id}): they approve on GitHub.`);
          }
          for (const esc of approvalEscalations.filter((x) => x.resolutionKind === "approve-decline")) {
            if (approvePrNeeds.some((n) => n.data.escalationId === esc.id)) continue;
            approvalNotes.push(`Approval of ${esc.question.replace(/^Approve\s+/u, "")} is requested from ${holder(esc.route)} (${esc.id}); wait for it, and do not escalate for it.`);
          }
          if (approvalNotes.length > 0) {
            gateNote += ` ${approvalNotes.join(" ")}`;
            gateNote += " Do not ask the user again; it is listed on the Stewards page.";
            if (asksForOpenApproval(status, store.openEscalations(b.id), store.openNeeds(b.id)) !== null) gateNote += " This report asks for an approval that is already open: a playbook violation, shown by bb stewards show.";
          }
          const schedule = store.openEscalations(b.id).find((x) => x.kind === "schedule");
          const askedAbout = store.binding(b.id)?.scheduleAsked ?? b.scheduleAsked;
          if (schedule !== undefined) gateNote += ` Scheduling is with the project steward (${schedule.id}): ${b.entityKey} touches what ${askedAbout.join(", ")} ${askedAbout.length === 1 ? "is" : "are"} already changing. Start no workers and do not move the ticket into a build state until it decides; wait for its guidance or hold.`;
          // BB-55: the gate just passed and nothing else is deciding, so the
          // turn must not end here. The backstop wake fires only when the
          // ticket is still in its spec stage with no worker running: a hold
          // or an open approval/schedule request means someone else decides,
          // and no wake is due. The wake is scheduled at once (a loud note on
          // the next reconcile), not left to the playbook's requeue.
          b = store.binding(b.id) ?? b;
          const nothingPending = specEscalation === undefined && specNeed === undefined && schedule === undefined && b.hold === null;
          const startDue =
            gateJustPassed &&
            b.kind === "ticket" &&
            b.endedAt === null &&
            b.ending === null &&
            b.stage === "spec" &&
            !store.workers(b.id).some((w) => w.status === "running") &&
            nothingPending;
          if (startDue) {
            store.note(b.id, START_WORKER_WAKE, false);
            scheduleReconcile(b.id);
          }
          // BB-35 step 2: a report may cite the lessons and hand-written
          // guidance units the turn acted on, so a lesson a ticket steward
          // applies directly still earns its hits. Counts only, and never a
          // correction: an unknown id is ignored and named, never a failure.
          const citesNote = input.cites === undefined ? "" : ` ${citationLines(await countCitations(b.projectId, b.id, input.cites)).join("; ")}.`;
          if (b.ending === "terminal") {
            if (b.followThrough === null) return `Reported.${untilNote}${replacedNote}${filingNote}${escalated}${deploymentNote}${citesNote} The binding ends when this turn does: running workers are stopped and the thread is archived. End the turn now.`;
            return `Reported.${untilNote}${replacedNote}${filingNote}${escalated}${deploymentNote}${citesNote} The binding stays open to follow through until ${iso(followThroughUntil!)}; running workers keep going. You will be woken when a worker finishes or something actionable changes, or ${requeuePhrase}. End the turn now.`;
          }
          const recorded = opsTickets.length === 0 ? "" : ` Recorded ${opsTickets.map((t) => `${t.ticket} (${t.did})`).join(", ")} against ${opsTickets.length === 1 ? "its fingerprint" : "their fingerprints"}.`;
          if (gateJustPassed && nothingPending) {
            return `Reported.${untilNote}${replacedNote}${recorded}${filingNote}${escalated}${citesNote} Ready gate: passed and nothing schedules you. Move the ticket to In Progress and start the worker now, in this turn, with the task in the In Progress instructions; do not end the turn first.`;
          }
          return `Reported.${untilNote}${replacedNote}${recorded}${filingNote}${gateNote}${escalated}${citesNote} You will be woken when something actionable changes, or ${requeuePhrase}. End the turn now.`;
        } catch (error) {
          return toolError(error);
        }
      }),
    });

    bb.agents.registerTool({
      name: "steward_update",
      description:
        "Steer a binding. Save standing guidance (re-sent on every wake); decide an escalation (guidance + resolve) or pass it up (forward + recommendation); set priority or a hold; override the steward or worker model; approve a ticket's spec for the ready gate. A steward updates its own binding with the user's instructions, and may put it on hold but not lift the hold; a parent steward or the project steward may update the bindings below it, which wakes them. " +
        "A steward may also record an assumption it proceeds under (assume), confirm one once evidence arrives (confirm), or correct one (resolve with the assumption id and answer); recording files nothing for the user. " +
        "The project steward also records each question it puts to the user (ask, with or without a binding) and closes it when they answer (resolve with the question id, and answer).",
      presentation: { label: { pending: "Updating a binding", completed: "Updated a binding" } },
      parameters: z.object({
        binding: z.string().trim().min(1).max(300).optional().describe("The entity key (ENG-12, owner/repo#3) or binding id. Leave out for this thread's own binding, or, from the project steward, for a question about no one binding."),
        guidance: z.string().trim().min(1).max(4000).optional().describe("Standing guidance, in the user's or your own terms. With resolve, the answer to the escalation."),
        resolve: z.string().trim().min(1).max(100).optional().describe("An open escalation on that binding that the guidance answers; or, from the project steward, an open question (qst_…) the user answered, with answer."),
        cites: z
          .array(z.string().trim().min(1).max(100))
          .max(20)
          .optional()
          .describe("With resolve (or forward): the lesson ids (lsn_…) and hand-written guidance unit ids (gu_…, from AGENTS.md or a playbook at .bb HEAD) this decision rested on. A lesson's hits count once per distinct binding, and a later reversal of the decision counts a correction. A guidance unit's citations are counted the same way for the efficacy view. Counts only — nothing is promoted, retired or written here."),
        answer: z.string().trim().min(1).max(4000).optional().describe("With resolve and a question id: the user's answer, kept on the question. With resolve and an assumption id: the answer it was corrected with."),
        assume: z
          .object({
            text: z.string().trim().min(1).max(1500).describe("The assumption, as one sentence: what you are proceeding under."),
            context: z.string().trim().max(3000).optional().describe("What makes it an assumption rather than a settled fact, and what you would do if it were wrong."),
            binding: z.string().trim().min(1).max(300).optional().describe("The binding it is about (ENG-12, owner/repo#3); defaults to the target binding, or to the project when the project steward records one about no single binding."),
          })
          .optional()
          .describe("Record an assumption: a question the guidance does not settle that you proceed under, instead of asking (which blocks) or deciding silently (which is invisible). It files no need, escalation or question and never counts as Blocked; it appears in your wake, the card, `bb stewards show` and the project steward's digest. Past the playbook's `max-assumptions` (default 5 open per binding) you must ask instead."),
        confirm: z.string().trim().min(1).max(100).optional().describe("Confirm an open assumption (asm_…) once evidence arrives, so it is no longer open. An assumption corrected instead is resolved with `resolve: \"<assumption id>\", answer`, the same string-id form as an escalation or question; a correction wakes the steward with the answer."),
        ask: z
          .object({
            question: z.string().trim().min(1).max(1500).describe("The question, as you put it to the user."),
            context: z.string().trim().max(3000).optional().describe("What the user needs to answer it."),
            resolution: z.enum(RESOLUTION_KINDS).describe("How the page asks: choice (with choices), text, approve-decline, secret (with variable and destination), or done."),
            choices: choicesSchema.optional().describe('For resolution "choice": 2-6 short labels the user picks between, so the page shows one button each.'),
            url: z.string().trim().max(500).optional().describe("The link the page shows, when there is one."),
            variable: z.string().trim().max(200).optional().describe("For resolution \"secret\": the variable name."),
            purpose: z.string().trim().max(500).optional().describe("For resolution \"secret\": what the value is for."),
            setting: z.string().trim().max(200).optional().describe("For resolution \"secret\": the stewards plugin secret setting the value goes to."),
            writeEnv: z.string().trim().max(500).optional().describe("For resolution \"secret\": the dotenv path the requester writes."),
            worker: z.string().trim().max(200).optional().describe("For resolution \"secret\": the worker thread that will request it."),
          })
          .optional()
          .describe("Project steward only: originate an escalation you are putting to the user (route user), so it is kept until answered. `resolution` says how the page asks; `choice` needs `choices`, `secret` needs the variable and destination."),
        forward: z.string().trim().min(1).max(100).optional().describe("An escalation that reached you and that you should not decide: pass it up. From the project steward it goes to the user — an approval becomes an Approve/Decline item on the Stewards page, so do not ask in prose; anything else asks them in your reply. With a forward to the user, `resolution` says how the page asks."),
        distinctFrom: z
          .array(z.string().trim().min(1).max(100))
          .max(20)
          .optional()
          .describe("With forward: when the binding has open items for the user (a plugin need, a route-user escalation, an open question), each of their ids (need_…, esc_…, qst_…) this escalation is distinct from. Required, and must name every one, when any is open; leave it out when none is. Use `coveredBy` instead when the escalation is the same ask as an open item."),
        coveredBy: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe("With forward or resolve: an open user-facing item on the binding (need_… or esc_… id) that already covers the escalation, so it is resolved as covered by that item instead of forwarded or decided. The ticket steward is woken with the item id. Give this or `distinctFrom`, never both."),
        resolution: z.enum(RESOLUTION_KINDS).optional().describe("With forward: how the page asks the user (choice, text, approve-decline, secret, done); required when forwarding to the user."),
        url: z.string().trim().max(500).optional().describe("With forward: the link the page shows, when there is one."),
        variable: z.string().trim().max(200).optional().describe('With forward and resolution "secret": the variable name.'),
        purpose: z.string().trim().max(500).optional().describe('With forward and resolution "secret": what the value is for.'),
        setting: z.string().trim().max(200).optional().describe('With forward and resolution "secret": the stewards plugin secret setting the value goes to.'),
        writeEnv: z.string().trim().max(500).optional().describe('With forward and resolution "secret": the dotenv path the requester writes.'),
        worker: z.string().trim().max(200).optional().describe('With forward and resolution "secret": the worker thread that will request it.'),
        entry: z.string().trim().min(1).max(300).optional().describe("With approve on an owner-reviewed pull request: the decide-list entry from the project file that you classified it under. A missing, unknown or `user` entry, or a change to the decide list or the code that enforces it, is the user's, and the approval is refused. With forward to the user: the decide-list entry you matched, when the escalation is one of those big decisions; leave it out for a routine escalation the guidance did not settle, and the page asks the user why (BB-35 step 4)."),
        recommendation: z.string().trim().max(1500).optional().describe("Your recommendation, when forwarding."),
        priority: z.enum(["urgent", "high", "normal", "low"]).optional(),
        hold: z.string().trim().max(300).optional().describe('Why it is held; "" lifts the hold. A held steward takes no new actions and starts no workers.'),
        behind: z
          .array(z.string().trim().min(1).max(100))
          .max(10)
          .optional()
          .describe("With hold: the open bindings (entity keys) this hold waits behind. The hold lifts itself, and the steward is woken, once every one has merged its pull requests or ended. Use it to schedule a ticket after the work it overlaps."),
        stack: z
          .array(z.string().trim().min(1).max(100))
          .max(10)
          .optional()
          .describe("With hold: the open bindings (entity keys) whose open pull request this stack-wait waits for. It lifts itself, and the steward is woken with that pull request's head branch, as soon as every one has opened a pull request; use it to start a ticket stacked on work still being built."),
        stewardModel: modelSpecSchema.optional().describe("The steward thread's model, provider/model/level."),
        workerModel: modelSpecSchema.optional().describe("The model for workers it starts from now."),
        reviewerModel: modelSpecSchema.optional().describe("The model for reviewers its workers start from now."),
        approve: z.boolean().optional().describe("Approve the ticket's current spec for the ready gate, or, with `entry`, an owner-reviewed pull request the project steward may decide."),
        quote: z.string().trim().min(2).max(500).optional().describe("When approving for the user: their words of approval, quoted exactly from a message they sent in this thread."),
        lesson: z
          .object({
            text: z.string().trim().min(1).max(4000).describe("The rule as it should read in the file."),
            file: z
              .string()
              .trim()
              .min(1)
              .max(300)
              .refine(
                (f) => !f.startsWith("/") && !f.includes("\\") && !f.includes("\0") && f.split("/").every((s) => s !== ".." && s !== "." && s.length > 0),
                "a .bb-relative path with no leading /, backslash, NUL, or empty/./.. segment",
              )
              .refine((f) => f !== PROJECT_FILE && f !== ROLES_FILE, "a guidance file (AGENTS.md or a playbook), never the project file or roles.json: a lesson must not be able to move a big decision to the project, loosen the pull-request gate, relax an approval or change who is a steward")
              .describe("The .bb file it belongs in, repo-relative, such as AGENTS.md or stewards/linear-tickets.md."),
            scope: z.enum(["procedure", "boundary"]).describe("procedure: playbook wording, sequencing, conventions the steward may already decide, which it self-merges. boundary: credentials and reach, who may direct a server, irreversible production steps — the user decides."),
            supersedes: z.string().trim().min(1).max(100).optional().describe("An existing lesson id in the same file that this one replaces; the nightly pass retires the older one."),
          })
          .optional()
          .describe("Project steward only: record a general rule drawn from an escalation or your own judgement, so it is made permanent in `.bb` instead of being lost with the ticket. With `binding` and `resolve`, it keeps the binding and escalation it came from. Apply and publish it, then complete it with lessonAction."),
        lessonAction: z
          .object({
            id: z.string().trim().min(1).max(100).describe("The lesson id (lsn_…) from the nightly prompt or `bb stewards lessons`."),
            action: z.enum(["complete", "drop", "retire"]).describe("complete: open the lesson's pull request and merge it for a procedure lesson, or file the owner's Review PR/Drop item for a boundary one. retire: open a pull request removing a retired lesson's anchored text. drop: close the pull request and discard it."),
          })
          .optional()
          .describe("Project steward only: finish a pending lesson after applying and publishing it, retire a retired one, or drop it."),
      }),
      execute: store.coalescingTool(async (input, { threadId }) => {
        try {
          const done: string[] = [];
          const notes: string[] = [];
          /** Close the question and record the one asked, once every check has passed. */
          const questionWrites = (closing: { question: Question; answer: string; guidanceDropped: boolean } | null, target: Binding | null): string[] => {
            const out: string[] = [];
            if (closing !== null) {
              const closed = store.answer(closing.question.id, closing.answer, threadId);
              // A question the page boxed was asked; closing it from a thread
              // marks it shown, so a later repeat is not a second box at once.
              if (closing.question.rationaleWanted !== null) store.markEscalationRationaleAsked(closing.question.id);
              const dropped = closing.guidanceDropped ? " (guidance not saved: it is kept per binding, so name one with binding to give it)" : "";
              out.push(`${closed ? `closed ${closing.question.id}` : `${closing.question.id} already closed with this answer`}${dropped}`);
            }
            if (input.ask !== undefined) {
              const askResolution = input.ask.resolution;
              if (askResolution === "choice" && (input.ask.choices === undefined || input.ask.choices.length < 2)) {
                throw new Error("A choice question needs 2-6 choices for the page's buttons.");
              }
              if (askResolution === "secret" && input.ask.variable === undefined && input.ask.setting === undefined) {
                throw new Error("A secret question needs the variable name (variable), or a stewards secret setting (setting).");
              }
              const q = store.ask({
                projectId: projectOf!,
                bindingId: target?.id ?? null,
                escalationId: null,
                question: input.ask.question,
                context: input.ask.context ?? null,
                resolutionKind: askResolution,
                choices: input.ask.choices,
                url: input.ask.url ?? null,
                data: {
                  ...(input.ask.variable === undefined ? {} : { variable: input.ask.variable }),
                  ...(input.ask.purpose === undefined ? {} : { purpose: input.ask.purpose }),
                  ...(input.ask.setting === undefined ? {} : { setting: input.ask.setting }),
                  ...(input.ask.writeEnv === undefined ? {} : { writeEnv: input.ask.writeEnv }),
                  ...(input.ask.worker === undefined ? {} : { workerThreadId: input.ask.worker }),
                },
              });
              out.push(`question ${q.id} recorded${target === null ? "" : ` about ${target.entityKey}`}: ask the user in your reply, and close it with steward_update { resolve: "${q.id}", answer } once they answer`);
            }
            return out;
          };
          let resolve = input.resolve;
          let guidance = input.guidance;
          let bindingRef = input.binding;

          // Every check comes before the first write, so a call that fails
          // changes nothing and a model can retry it as it was.

          // Questions to the user are the project steward's, and kept until answered.
          const projectOf = store.projectByThread(threadId)?.projectId ?? null;
          // BB-251: assume / confirm / resolve an assumption id is its own path,
          // so it files nothing for the user and is not read as an escalation or
          // a question. It runs before the answer/question checks below.
          const assumptionReply = await handleAssumptionUpdate(input, threadId, projectOf);
          if (assumptionReply !== null) return assumptionReply;
          let closing: { question: Question; answer: string; guidanceDropped: boolean } | null = null;
          if (input.answer !== undefined && resolve?.startsWith("qst_") !== true) return toolError(new Error('answer closes a question: give it with resolve: "<question id>".'));
          if (projectOf === null && (input.ask !== undefined || resolve?.startsWith("qst_") === true)) {
            return toolError(new Error("Only the project steward keeps questions to the user; a steward escalates with steward_report."));
          }
          if (projectOf === null && (input.lesson !== undefined || input.lessonAction !== undefined)) {
            return toolError(new Error("Only the project steward records and completes lessons; a steward escalates with steward_report."));
          }
          if (input.lesson?.supersedes !== undefined) {
            const older = store.lesson(input.lesson.supersedes);
            if (older === null || older.projectId !== projectOf) return toolError(new Error(`No lesson ${input.lesson.supersedes} in this project to supersede.`));
            if (older.file !== input.lesson.file) return toolError(new Error(`Lesson ${older.id} is in ${older.file}, not ${input.lesson.file}; a lesson only supersedes one in the same file.`));
            if (older.tier === "retired") return toolError(new Error(`Lesson ${older.id} is already retired.`));
          }
          if (input.lessonAction !== undefined) {
            const lesson = store.lesson(input.lessonAction.id);
            if (lesson === null || lesson.projectId !== projectOf) return toolError(new Error(`No lesson ${input.lessonAction.id} in this project.`));
            if (input.lessonAction.action === "retire") {
              if (lesson.tier !== "retired") return toolError(new Error(`Lesson ${lesson.id} is not retired (tier ${lesson.tier}); the nightly pass retires one that aged out or was corrected.`));
              const outcome = await retireLesson(lesson);
              return `${lesson.id}: ${outcome}.`;
            }
            if (lesson.status !== "pending") return toolError(new Error(`Lesson ${lesson.id} is already ${lesson.status}.`));
            if (lesson.tier === "retired") return toolError(new Error(`Lesson ${lesson.id} is retired; a retired lesson is never landed, only removed with action "retire".`));
            const outcome = await completeLesson(lesson, input.lessonAction.action);
            return `${lesson.id}: ${outcome}.`;
          }
          /** Record the lesson this call carries, with the binding and escalation it came from. */
          const recordLesson = (bindingId: string | null, escalationId: string | null): string => {
            const projectThread = store.project(projectOf!).threadId;
            const branch = projectThread === null ? null : lessonBranchFor(projectThread);
            // BB-35 step 6: link the lesson to the cluster it answers and settle
            // it, so the after-the-fact thread follow-up counts as the cluster's
            // why even for a much-later page box.
            const cluster = lessonClusterFor(bindingId, escalationId);
            const lesson = store.addLesson({ projectId: projectOf!, bindingId, escalationId, file: input.lesson!.file, text: input.lesson!.text, scope: input.lesson!.scope, branch, ...(cluster === null ? {} : { clusterKey: cluster }), ...(input.lesson!.supersedes === undefined ? {} : { supersedes: input.lesson!.supersedes }) });
            if (cluster !== null) store.settleClusterRationale(projectOf!, cluster);
            return `lesson ${lesson.id} recorded (${lesson.scope}, ${lesson.tier}); it is injected into wakes and the nightly pass promotes it when it earns it. To land it now, add \`${withLessonAnchor(lesson.text, lesson.id)}\` to ${lesson.file}, commit, publish it with workspace_publish_guidance on a multi-repo project (on a native project, commit and open the pull request yourself), then complete it with steward_update { lessonAction: { id: "${lesson.id}", action: "complete" } }`;
          };
          if (projectOf !== null && resolve?.startsWith("qst_") === true) {
            const q = store.question(resolve);
            if (q === null || q.projectId !== projectOf) return toolError(new Error(`No question ${resolve} in this project.`));
            const answer = input.answer ?? guidance;
            if (answer === undefined) return toolError(new Error("Give the user's answer (answer) when closing a question."));
            const x = q.escalationId === null ? null : store.escalation(q.escalationId);
            if (x !== null) {
              // A forwarded escalation: decided as one, which closes the question with it.
              // Closed already (the binding ended, a retry) is answered the same way.
              resolve = x.id;
              guidance ??= answer;
              bindingRef ??= x.bindingId;
            } else {
              // A retry of the close that already happened changes nothing.
              if (q.status !== "open" && q.answer !== answer) return toolError(new Error(`Question ${q.id} is already closed.`));
              closing = { question: q, answer, guidanceDropped: false };
              resolve = undefined;
              if (input.guidance !== undefined && (input.answer !== undefined || q.bindingId !== null)) bindingRef ??= q.bindingId ?? undefined;
              else guidance = undefined;
              if (guidance !== undefined && bindingRef === undefined) {
                // A question about the project as a whole: closed all the same; guidance belongs to a binding.
                guidance = undefined;
                closing.guidanceDropped = true;
              }
            }
          }

          if (input.cites !== undefined && resolve === undefined && input.forward === undefined) {
            return toolError(new Error("cites goes with resolve (the decision it rested on) or forward (the recommendation it rested on)."));
          }

          const target = bindingRef === undefined ? (projectOf !== null ? null : ownBinding(threadId)) : store.find(bindingRef);
          if (bindingRef !== undefined && target === null) return toolError(new Error(`No binding for ${bindingRef}.`));
          if (target === null) {
            const forBinding = [guidance, resolve, input.forward, input.recommendation, input.priority, input.hold, input.behind, input.stack, input.stewardModel, input.workerModel, input.reviewerModel, input.approve, input.quote];
            if (forBinding.some((v) => v !== undefined)) return toolError(new Error("Name the binding (binding: ENG-12 or owner/repo#3) for that."));
            if (closing === null && input.ask === undefined && input.lesson === undefined) return toolError(new Error("Nothing to update: name a binding, ask a question, record a lesson, or close one."));
            const written = questionWrites(closing, null);
            if (input.lesson !== undefined) {
              if (input.lesson.scope === "boundary") return toolError(new Error("A boundary lesson must name the binding it came from: pass binding (and resolve) so the owner's Review PR/Drop item has somewhere to live."));
              written.push(recordLesson(null, closing?.question.escalationId ?? null));
            }
            return `${written.join("; ")}.`;
          }
          if (input.ask !== undefined && target.projectId !== projectOf) return toolError(new Error(`${target.entityKey} is not in this project.`));
          const self = target.threadId === threadId;

          const forwarding = input.forward === undefined ? null : store.escalation(input.forward);
          if (input.forward !== undefined) {
            if (forwarding === null || forwarding.status !== "open" || forwarding.bindingId !== target.id) return toolError(new Error(`No open escalation ${input.forward} on ${target.entityKey}.`));
            const holder = forwarding.route === "parent" ? store.binding(target.parentBindingId ?? "")?.threadId : forwarding.route === "project" ? store.project(target.projectId).threadId : forwarding.route === "steward" ? target.threadId : null;
            if (holder !== threadId) return toolError(new Error(`Escalation ${forwarding.id} is not with this thread, so it cannot forward it.`));
          }
          // BB-231: a forward must say how the escalation differs from every
          // open user-facing item on the binding (`distinctFrom`), or name the
          // item that already covers it (`coveredBy`), which resolves it as
          // covered instead of forwarding. `coveredBy` works with `forward` (an
          // escalation the project steward holds) or with `resolve` (one
          // already with the user). The pairwise judgement is forced here; no
          // subject is inferred from the text. `approve-decline` is the page's
          // approval shape and is refused on anything but an approval
          // escalation.
          if (input.coveredBy !== undefined && input.forward === undefined && (input.resolve === undefined || input.resolve.startsWith("qst_"))) {
            return toolError(new Error("coveredBy resolves an escalation named by forward or resolve; give one of them (a question is closed with answer instead)."));
          }
          if (input.distinctFrom !== undefined && input.forward === undefined) {
            return toolError(new Error("distinctFrom goes with forward: name the open items the escalation is distinct from, or use coveredBy when one covers it."));
          }
          if (input.coveredBy !== undefined && input.distinctFrom !== undefined) {
            return toolError(new Error("coveredBy and distinctFrom are alternatives: name the item that covers the escalation, or the open items it is distinct from, not both."));
          }
          if (input.coveredBy !== undefined) {
            const covering = userItemsFor(target).find((item) => item.id === input.coveredBy);
            if (covering === undefined) return toolError(new Error(`coveredBy must name an open item on ${target.entityKey}; ${input.coveredBy} is not one.`));
          }
          if (forwarding !== null) {
            if (input.resolution === "approve-decline" && forwarding.kind !== "approval") {
              return toolError(new Error(`resolution "approve-decline" is only for an approval escalation; ${forwarding.id} is a ${forwarding.kind} escalation.`));
            }
            if (input.coveredBy === undefined) {
              const openItems = userItemsFor(target);
              if (openItems.length > 0) {
                const named = new Set(input.distinctFrom ?? []);
                const unnamed = openItems.filter((item) => !named.has(item.id));
                if (unnamed.length > 0) {
                  return toolError(
                    new Error(
                      `Nothing was recorded: ${target.entityKey} has open items for the user, and a forward must say how it differs from each (distinctFrom) or name the item that covers it (coveredBy). Open items:\n` +
                        openItems.map((item) => `- ${item.id} (${item.kind}): ${item.text}`).join("\n"),
                    ),
                  );
                }
              }
            }
          }

          const directs = mayDirect(threadId, target);
          if (!directs && forwarding === null) return toolError(new Error(`This thread does not steer ${target.entityKey}: only its own steward, a steward above it, or the project steward does.`));
          let approval: { entity: EntitySnapshot; byUser: boolean } | null = null;
          let resolving: Escalation | null = null;
          /** True when a `coveredBy` resolution answers the escalation (BB-231). */
          let covered = false;
          if (directs) {
            // A steward may put itself on hold (the owner said "halt work on
            // this" in a Linear mention), but only its parent or the project
            // steward lifts a hold.
            if (self && (input.priority !== undefined || input.hold === "" || input.stewardModel !== undefined)) {
              return toolError(new Error(input.hold === "" ? "A steward does not lift its own hold; its parent or the project steward does. Escalate with steward_report to ask." : "A steward does not set its own priority or model; its parent or the project steward does."));
            }
            // An owner-reviewed pull request is the project steward's to decide
            // from the decide list. `approve: true` records a project-steward
            // approval bound to the head sha, or is refused when the entry is
            // missing, unknown, `user`, or the change widens the list itself.
            const prApproval = store.openEscalations(target.id).find((x) => x.kind === "approval" && x.resolutionKind === "approve-decline") ?? null;
            if (input.approve === true && prApproval !== null && input.entry !== undefined) {
              if (!isProjectSteward(threadId, target)) return toolError(new Error("An owner-reviewed pull request is the project steward's to approve; a steward escalates it and waits."));
              const config = await loadConfig(target.projectId);
              if (config === null) return toolError(new Error("The project file could not be read, so no project-steward approval can be recorded."));
              const observed = target.lastSnapshot;
              const pull = observed === null ? null : [observed.entity, ...observed.pulls].find((e) => (e.url ?? e.key) === prApproval.url) ?? null;
              // A reviewer's owner call in the marker is binding: the project
              // steward does not decide it, whatever entry the decide list
              // matched, and never posts a `bb-approval` on it (BB-192). The
              // product reason (BB-207) binds it the same way.
              const approvalGate = pull === null ? null : prGate(pull, { projectApprovals: projectApprovalsFor(target), ...productGateOptions(target, pull) });
              if (approvalGate !== null && approvalGate.escalated) {
                return toolError(new Error(approvalGate.reason === "product" ? PRODUCT_APPROVAL_REFUSAL : ESCALATED_APPROVAL_REFUSAL));
              }
              const files = pull === null ? null : await pullChangedFiles(pull);
              const decision = decideFor(files, input.entry ?? null, config.file.bigDecisions);
              if (decision !== "project") {
                const why = decideForRefusal(files, input.entry ?? null, config.file.bigDecisions) ?? "the change is not the project steward's to approve";
                return toolError(new Error(`That pull request is the user's to approve: ${why}. Forward it with steward_update { binding: "${target.entityKey}", forward: "${prApproval.id}", resolution: "approve-decline", recommendation } instead.`));
              }
              const answer = guidance ?? `Approved as ${JSON.stringify(input.entry)}.`;
              if (pull === null) return toolError(new Error("The pull request could not be read, so the approval marker cannot be posted."));
              try {
                await recordProjectDecision(approvalsCtx, target, pull, threadId, { headSha: prApproval.headSha ?? "", entry: input.entry ?? null, verdict: "approved", reasoning: answer });
              } catch (error) {
                return toolError(error);
              }
              store.addGuidance(target.id, answer, threadId);
              store.answerEscalation(prApproval.id, answer, threadId);
              const reached = await deliverProjectApproval(approvalsCtx, target, pull, { verdict: "approved", sha: prApproval.headSha ?? "", entry: input.entry ?? null, reasoning: answer });
              done.push(`posted the project steward's approval marker on ${prApproval.url} at ${shortSha(prApproval.headSha)} and ${reached === "worker" ? "told its worker" : "woke the steward"}`);
              return `${target.entityKey}: ${done.join("; ")}.`;
            }
            if (input.approve === true) {
              const config = await loadConfig(target.projectId);
              const playbook = config === null ? null : bindingPlaybook(config, target);
              const mode = playbook?.ready?.approval ?? null;
              if (mode === null) return toolError(new Error(`${target.entityKey}'s playbook has no ready gate to approve.`));
              if (typeof mode === "object") return toolError(new Error(`${target.entityKey} is approved by moving it to ${mode.state} in ${target.source === "github" ? "GitHub" : "Linear"}.`));
              if (target.lastSnapshot === null) return toolError(new Error("Nothing has been observed for this binding yet."));
              const entity = (target.source === "ops" ? null : await snapshot(target.source, target.entityId).catch(() => null)) ?? target.lastSnapshot.entity;
              const byProject = mode === "project" && isProjectSteward(threadId, target);
              // Criterion 3: the user's words may be an unsigned comment on the entity itself, not only a message in this thread.
              const byUser = input.quote !== undefined && ((await userSaid(threadId, input.quote)) || userApprovedOnEntity(entity, target.threadId, input.quote));
              if (!byProject && !byUser) {
                return toolError(
                  new Error(
                    mode === "user"
                      ? "This spec is approved by the user: quote their words from a message in this thread, or from their unsigned approving comment on the entity."
                      : "This spec is approved by the project steward (or by the user, quoting their words from this thread). Escalate a decision instead.",
                  ),
                );
              }
              // Pinned to the spec as it is now, not as last observed: a spec
              // comment posted since the last ring is part of what was read.
              approval = { entity, byUser };
            }
            if (resolve !== undefined) {
              // BB-231: `coveredBy` with `resolve` answers an escalation the
              // user already holds as covered by an open item; the synthesized
              // guidance names the item and wakes the ticket steward.
              if (input.coveredBy !== undefined) {
                const covering = userItemsFor(target).find((item) => item.id === input.coveredBy)!;
                guidance = `Covered by ${covering.id} (${covering.kind}): ${covering.text}`;
                covered = true;
              }
              if (guidance === undefined) return toolError(new Error("Give the answer as guidance when resolving."));
              resolving = store.escalation(resolve);
              if (resolving === null || resolving.bindingId !== target.id) return toolError(new Error(`No escalation ${resolve} on ${target.entityKey}.`));
              // Criterion 2: the project steward's approving words are the
              // approval; approve: true is no longer needed as well. Only the
              // approver the gate names may do it, as with approve: true: the
              // project steward for mode project, and never a steward's own
              // words for mode me (there the user's quote is required).
              if (!covered && approval === null && resolving.kind === "approval" && resolving.resolutionKind !== "approve-decline" && resolving.status === "open" && target.lastSnapshot !== null && classifyApproval(guidance) === "approve") {
                const config = await loadConfig(target.projectId);
                const playbook = config === null ? null : bindingPlaybook(config, target);
                if (playbook?.ready?.approval === "project" && isProjectSteward(threadId, target)) approval = { entity: (target.source === "ops" ? null : await snapshot(target.source, target.entityId).catch(() => null)) ?? target.lastSnapshot.entity, byUser: false };
              }
            }
            if (input.stewardModel !== undefined && target.threadId !== null) {
              const info = await threadInfo(target.threadId);
              if (info !== null && info.providerId !== "" && info.providerId !== input.stewardModel.providerId) return toolError(new Error(`${target.entityKey}'s steward runs on ${info.providerId}; a model can be changed, the provider cannot.`));
            }
            const asked = [guidance, resolve, input.forward, input.priority, input.hold, input.behind, input.stack, input.stewardModel, input.workerModel, input.reviewerModel, input.approve === true ? true : undefined, input.ask, input.lesson, closing ?? undefined];
            if (asked.every((v) => v === undefined)) return toolError(new Error("Nothing to update: give guidance, resolve, forward, priority, hold, a model, approve, ask, or record a lesson."));
          }
          const behind: Binding[] = [];
          const stack: Binding[] = [];
          if (input.behind !== undefined && input.stack !== undefined) return toolError(new Error("behind and stack are different holds: name the work to wait to merge behind, or the work whose open pull request to stack on, not both."));
          if (input.behind !== undefined) {
            if (input.hold === undefined || input.hold === "") return toolError(new Error("behind goes with a hold: say why it is held, and name the bindings it waits behind."));
            const missing: string[] = [];
            for (const k of input.behind) {
              const other = store.find(k, target.projectId);
              if (other === null || other.endedAt !== null || other.id === target.id) missing.push(k);
              else if (!behind.some((x) => x.id === other.id)) behind.push(other);
            }
            if (missing.length > 0) return toolError(new Error(`Not an open binding in this project to wait behind: ${missing.join(", ")}.`));
          }
          if (input.stack !== undefined) {
            if (input.hold === undefined || input.hold === "") return toolError(new Error("stack goes with a hold: say why it is held, and name the bindings whose pull request it waits for."));
            const missing: string[] = [];
            for (const k of input.stack) {
              const other = store.find(k, target.projectId);
              if (other === null || other.endedAt !== null || other.id === target.id) missing.push(k);
              else if (!stack.some((x) => x.id === other.id)) stack.push(other);
            }
            if (missing.length > 0) return toolError(new Error(`Not an open binding in this project to stack on: ${missing.join(", ")}.`));
          }
          if (behind.length > 0 || stack.length > 0) {
            // No cycles: a hold that, through its own holds, waits behind this
            // binding would never lift. A stack-wait deadlocks the same way:
            // neither pull request opens if each waits for the other's.
            const waitsOn = (from: Binding, seen = new Set<string>()): string | null => {
              for (const k of [...from.holdBehind, ...from.holdStack]) {
                const next = store.find(k, from.projectId);
                if (next === null || next.endedAt !== null || seen.has(next.id)) continue;
                if (next.id === target.id) return from.entityKey;
                seen.add(next.id);
                const via = waitsOn(next, seen);
                if (via !== null) return via;
              }
              return null;
            };
            for (const other of [...behind, ...stack]) {
              const via = other.id === target.id ? null : waitsOn(other);
              if (via !== null) return toolError(new Error(`${target.entityKey} cannot wait behind ${other.entityKey}: ${via} already waits behind ${target.entityKey}, so neither hold would ever lift.`));
            }
          }

          done.push(...questionWrites(closing, target));
          if (input.lesson !== undefined) done.push(recordLesson(target.id, resolving?.id ?? closing?.question.escalationId ?? null));
          if (input.cites !== undefined) {
            // BB-35 steps 2 and 6: count the citation, and keep the lessons on
            // the escalation so a later reversal can be attributed. A cite may
            // name a lesson (`lsn_…`) or a hand-written guidance unit (`gu_…`),
            // resolved against `.bb` HEAD. Counts only: nothing is promoted,
            // retired or written to `.bb` here.
            const result = await countCitations(target.projectId, target.id, input.cites);
            const citeTarget = resolving ?? forwarding;
            if (citeTarget !== null) store.setEscalationCitations(citeTarget.id, result.cited.map((l) => l.id));
            done.push(...citationLines(result));
          }
          if (forwarding !== null && input.coveredBy !== undefined) {
            // BB-231: the escalation is the same ask as an open item, so it is
            // resolved as covered rather than forwarded. The resolve wakes the
            // originating ticket steward with the covering item's id.
            const covering = userItemsFor(target).find((item) => item.id === input.coveredBy)!;
            store.resolve(forwarding.id, `Covered by ${covering.id} (${covering.kind}): ${covering.text}`, threadId);
            done.push(`resolved ${forwarding.id} as covered by ${covering.id} (${covering.kind}); the ticket steward is woken with it`);
          } else if (forwarding !== null) {
            const route = nextRoute(target, forwarding.route);
            const recommendation = input.recommendation ?? forwarding.recommendation;
            const resolutionKind = input.resolution ?? (forwarding.choices.length > 0 ? "choice" : "text");
            // A forwarded approval is the user's to decide exactly as
            // `approval: user` is: file the page's `approve-spec` need and keep
            // the escalation open, linked to it, instead of a free-text
            // question. A forwarded decision stays a question. Computed here,
            // before the await below, so the escalation cannot be resolved in
            // between and leave the need or question open, and before the
            // credential refusal so an approval is not mistaken for a
            // credential ask just because its question names one.
            const prToUser = route === "user" && forwarding.kind === "approval" && forwarding.resolutionKind === "approve-decline";
            const approvalToUser = route === "user" && forwarding.kind === "approval" && !prToUser;
            // BB-176: a credential always reaches the user through bb's secure
            // form. A forward that names a credential variable is never a
            // `done`/`text` item, whatever the ticket or spec says. The error
            // names the resolution and its fields and never repeats the
            // question or context, so no secret is echoed. Refused before any
            // state changes, so a refused forward is not half-applied.
            if (route === "user" && !approvalToUser && !prToUser && (resolutionKind === "done" || resolutionKind === "text") && namesCredential(forwarding)) {
              return toolError(
                new Error(
                  'A credential must be forwarded with resolution: "secret", naming `variable` and `purpose` and either `writeEnv`/`worker` or `setting`, so bb\'s secure form takes the value. `done` and `text` are refused for it; a decision that only mentions a credential variable can be forwarded with `choices` instead.',
                ),
              );
            }
            // Keep the chain: each forwarding hop, with the forwarder's
            // rewording, so the bindings between get their quiet note and the
            // originator can be answered directly (BB-30).
            store.addHop(forwarding.id, { threadId, bindingId: target.id, rewording: recommendation });
            store.reroute(forwarding.id, route, recommendation);
            if (route === "user" && !approvalToUser && !prToUser && input.resolution === undefined) {
              return toolError(new Error("Forwarding to the user needs a resolution: choice (with choices), text, approve-decline, secret or done. It is what the page's ask looks like; the plugin assigns the route, but the human boundary is yours to describe."));
            }
            if (resolutionKind === "choice" && forwarding.choices.length < 2) {
              return toolError(new Error("A choice question needs 2-6 choices for the page's buttons; escalate a decision with choices, or forward as text."));
            }
            if (resolutionKind === "secret" && input.variable === undefined && input.setting === undefined) {
              return toolError(new Error("A secret question needs the variable name (variable), or a stewards secret setting (setting)."));
            }
            const q =
              approvalToUser || prToUser || route !== "user"
                ? null
                : store.ask({
                    projectId: target.projectId,
                    bindingId: target.id,
                    escalationId: forwarding.id,
                    question: forwarding.question,
                    context: [forwarding.context, `A ${forwarding.kind} escalation from ${target.entityKey}${target.title === null ? "" : ` (${target.title})`}.`, `Meanwhile: ${forwarding.meanwhile}`, recommendation === null ? null : `Recommendation: ${recommendation}`].filter((c) => c !== null).join(" "),
                    ...(forwarding.choices.length === 0 ? {} : { choices: forwarding.choices }),
                    resolutionKind,
                    ...(input.url === undefined ? {} : { url: input.url }),
                    data: {
                      ...(input.variable === undefined ? {} : { variable: input.variable }),
                      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
                      ...(input.setting === undefined ? {} : { setting: input.setting }),
                      ...(input.writeEnv === undefined ? {} : { writeEnv: input.writeEnv }),
                      ...(input.worker === undefined ? {} : { workerThreadId: input.worker }),
                    },
                  });
            // BB-35 step 4: a routine decision the guidance did not settle asks
            // why, so the answer can become a lesson. A named decide-list entry
            // is a big decision, and the gate items and a credential never ask.
            // One cluster is never asked twice.
            if (q !== null) {
              const key = clusterKey(target.playbook, forwarding.question);
              store.setEscalationCluster(q.id, key);
              const cluster = store.escalationsByCluster(target.projectId, key);
              // A rationale supplied anywhere in the cluster settles it for good;
              // an open box (or a shown one) means one is already being asked. A
              // lesson recorded from the after-the-fact follow-up settles it too,
              // so a much-later page box is not asked for a why already given.
              const settled = cluster.some((x) => x.rationaleGiven) || store.lessonsByCluster(target.projectId, key).length > 0;
              const pending = cluster.some((x) => x.status === "open" && (x.rationaleWanted !== null || x.rationaleAsked));
              if (routineRationaleWanted({ kind: forwarding.kind, resolutionKind, entry: input.entry ?? null }) && !settled && !pending) {
                store.setEscalationRationale(q.id, ROUTINE_RATIONALE_WHY);
              }
            }
            // BB-253: the forwarded decision, configuration or secret is the
            // only live signal once the project steward's thread is muted, so
            // push it once, with the question as the body and the project
            // steward's thread (which holds it) as the tap target.
            if (q !== null) {
              const heading = resolutionKind === "secret" ? "needs a secret" : resolutionKind === "done" ? "needs configuration" : "needs a decision";
              await pushNeed(target, { id: q.id, title: `${target.entityKey} ${heading}`, body: forwarding.question, threadId: store.project(target.projectId).threadId });
            }
            if (approvalToUser && target.lastSnapshot !== null) {
              const before = new Set(store.openNeeds(target.id).map((n) => n.id));
              fileApproveSpecNeed(target, target.lastSnapshot.entity, forwarding.id);
              await pushNewGateNeeds(target, before);
            }
            if (prToUser) {
              // The user's page item carries the same decide-list listing the
              // project steward was shown, so the approval route is legible
              // (BB-135).
              const before = new Set(store.openNeeds(target.id).map((n) => n.id));
              await fileForwardedApprovePrNeed(approvalsCtx, target, forwarding);
              await pushNewGateNeeds(target, before);
            }
            // BB-213: a forward that reaches the user files the real item, so
            // the auto-filed `nextAction` item closes rather than sit beside it.
            if (route === "user") reconcileAutoNeed(target, target.status?.actor ?? "steward");
            await deliver(target, store.escalation(forwarding.id)!);
            if (approvalToUser) done.push(`forwarded ${forwarding.id} to the user as an approve-spec item: they press Approve or Decline on the Stewards page, so do not ask them in prose`);
            else if (prToUser) done.push(`forwarded ${forwarding.id} to the user as an approve-pr item: they approve on GitHub from the Stewards page`);
            else if (q !== null) done.push(`forwarded ${forwarding.id} to the user as question ${q.id}: ask them in your reply, then record their answer with guidance + resolve`);
            else done.push(`forwarded ${forwarding.id} to the project steward`);
          }
          if (!directs) return `${target.entityKey}: ${done.join("; ")}.`;

          if (approval !== null) {
            const by = approval.byUser ? ` by the user: "${input.quote}"` : " by the project steward";
            // BB-251: the approval confirms exactly the assumptions the
            // request listed, before the request closes.
            const confirmedAssumptions = store.confirmApprovalAssumptions(target.id, threadId);
            store.patch(target.id, { ready: { ...target.ready, approval: { at: now(), specHash: specHashFor(target, approval.entity), by: threadId, approvedText: specTextFor(target, approval.entity) }, voidedAt: null, voidedApprovedText: null, voidedApprovedAt: null, declinedSpecHash: null }, declinedSpecObjections: [] });
            store.closeNeeds(target.id, "approve-spec", "Approved.");
            for (const x of store.openEscalations(target.id).filter((e) => e.kind === "approval" && e.resolutionKind !== "approve-decline")) store.resolve(x.id, `Approved${by}.`);
            const others = store.openEscalations(target.id).filter((x) => x.id !== resolve);
            done.push(others.length === 0 ? "spec approved" : `spec approved; still open on it: ${others.map((x) => `${x.id} (${x.kind}, with ${x.route}): ${x.question}`).join(" | ")} — resolve any this approval answers`);
            if (confirmedAssumptions.length > 0) done.push(`confirmed ${confirmedAssumptions.length} assumption${confirmedAssumptions.length === 1 ? "" : "s"} by approval: ${confirmedAssumptions.join(", ")}`);
            notes.push(`The spec was approved${by}.`);
          }

          if (guidance !== undefined) {
            // The same guidance again within minutes is a retry: saved once.
            const saved = store.addGuidance(target.id, guidance, threadId);
            done.push(saved ? "guidance saved" : "guidance already saved");
            if (saved && resolve === undefined) notes.push(`New guidance: ${guidance}`);
          }
          if (resolving !== null) {
            // A declined pull-request approval posts its marker before the
            // escalation is resolved, so a GitHub failure leaves the request
            // open to retry rather than recording a decision nobody can see.
            const isDecline = !covered && resolving.kind === "approval" && resolving.resolutionKind === "approve-decline" && resolving.status === "open" && approval === null && classifyApproval(guidance) !== "approve";
            const declinePull = isDecline && target.lastSnapshot !== null ? observedPulls(target, target.lastSnapshot).find((p) => (p.url ?? p.key) === resolving.url) ?? null : null;
            const declineSha = resolving.headSha ?? declinePull?.pull?.headSha ?? null;
            if (isDecline && declinePull !== null) {
              const entry = input.entry ?? null;
              try {
                await recordProjectDecision(approvalsCtx, target, declinePull, threadId, { headSha: declineSha ?? "", entry, verdict: "declined", reasoning: guidance ?? "" });
              } catch (error) {
                return toolError(error);
              }
              await deliverProjectApproval(approvalsCtx, target, declinePull, { verdict: "declined", sha: declineSha ?? "", entry, reasoning: guidance ?? "" });
            }
            // Already resolved (the binding ended, a retry) is no error: the answer is added to the record.
            const outcome = store.answerEscalation(resolving.id, guidance!, threadId);
            if (isDecline) {
              // A declined pull-request approval: remember the head and the
              // reviewer marker so the same one is not asked again (BB-51).
              const pull = target.lastSnapshot === null ? null : observedPulls(target, target.lastSnapshot).find((p) => (p.url ?? p.key) === resolving.url) ?? null;
              store.patch(target.id, {
                declinedPrHeadSha: resolving.headSha ?? pull?.pull?.headSha ?? null,
                declinedPrMarker: pull === null ? null : markerKey(latestReviewMarker(pull.comments)),
              });
              done.push(`remembered the decline of ${shortSha(resolving.headSha)} so the same head and reviewer marker are not asked again`);
            } else if (!covered && resolving.kind === "approval" && resolving.status === "open" && approval === null && target.lastSnapshot !== null) {
              const fresh = store.binding(target.id)!;
              const objections = objectionLines(guidance ?? "");
              const previous = fresh.declinedSpecObjections;
              const repeated = previous.length > 0 && objections.some((o) => previous.some((p) => normObjection(p) === normObjection(o)));
              store.patch(target.id, { ready: { ...fresh.ready, declinedSpecHash: specHashFor(fresh, fresh.lastSnapshot!.entity) }, declinedSpecObjections: objections });
              if (repeated) {
                // The same objection came back after a revision: a third round
                // would only repeat it, so the user decides (BB-54).
                const q = store.ask({
                  projectId: target.projectId,
                  bindingId: target.id,
                  escalationId: resolving.id,
                  question: `The project steward declined ${target.entityKey}'s spec twice on the same objection: ${objections.join("; ")}. Decide how to proceed.`,
                  context: `First declined on: ${previous.join("; ")}. The revision did not answer it, so it is forwarded to you instead of a third round.`,
                  resolutionKind: "text",
                });
                done.push(`forwarded the repeated objection to the user as question ${q.id}`);
              } else if (objections.length > 0) {
                done.push(`recorded the decline's ${objections.length} objection(s) for the steward's checklist`);
              }
            }
            if (resolving.status === "open") done.push(`resolved ${resolving.id}${isProjectSteward(threadId, target) ? "; if this is a general judgement the playbook should carry, record it with steward_update { lesson: { text, file, scope } }" : ""}`);
            else if (outcome === "appended") done.push(`recorded the answer on ${resolving.id}, which was already resolved (${resolving.resolution ?? "no answer"})`);
            else done.push(`${resolving.id} already has this answer`);
            if (outcome !== "unchanged") notes.push(`Escalation ${resolving.id} decided: ${guidance}`);
          }
          if (input.priority !== undefined || input.hold !== undefined) {
            const behindKeys = behind.map((x) => x.entityKey);
            const stackKeys = stack.map((x) => x.entityKey);
            store.patch(target.id, {
              ...(input.priority === undefined ? {} : { priority: input.priority }),
              ...(input.hold === undefined ? {} : { hold: input.hold === "" ? null : input.hold, holdBehind: behindKeys, holdStack: stackKeys }),
            });
            const behindNote = behindKeys.length === 0 ? "" : ` (behind ${behindKeys.join(", ")}: lifts itself once ${behindKeys.length === 1 ? "its pull requests merge or it ends" : "their pull requests merge or they end"})`;
            const stackNote = stackKeys.length === 0 ? "" : ` (stacked on ${stackKeys.join(", ")}: lifts itself once ${stackKeys.length === 1 ? "its pull request opens" : "their pull requests open"})`;
            const what = [input.priority === undefined ? null : `priority ${input.priority}`, input.hold === undefined ? null : input.hold === "" ? "hold lifted" : `on hold: ${input.hold}${behindNote}${stackNote}`].filter((s) => s !== null).join("; ");
            done.push(what);
            notes.push(`Set by your ${isProjectSteward(threadId, target) ? "project" : "parent"} steward: ${what}`);
            // A hold answers an open scheduling request. A hold lifted by hand closes it too; the next look asks again if it must.
            if (input.hold !== undefined) {
              for (const x of store.openEscalations(target.id).filter((e) => e.kind === "schedule")) store.resolve(x.id, input.hold === "" ? "Hold lifted." : stackKeys.length > 0 ? `Stacked on ${stackKeys.join(", ")}.` : behindKeys.length === 0 ? `Held: ${input.hold}` : `Held behind ${behindKeys.join(", ")}.`);
            }
          }
          if (input.stewardModel !== undefined && target.threadId !== null) {
            await bb.sdk.threads.update({ threadId: target.threadId, ...(input.stewardModel.model === null ? {} : { model: input.stewardModel.model }), ...(input.stewardModel.reasoningLevel === null ? {} : { reasoningLevel: input.stewardModel.reasoningLevel }) });
          }
          if (input.stewardModel !== undefined || input.workerModel !== undefined || input.reviewerModel !== undefined) {
            store.patch(target.id, { ...(input.stewardModel === undefined ? {} : { modelSteward: input.stewardModel.text }), ...(input.workerModel === undefined ? {} : { modelWorker: input.workerModel.text }), ...(input.reviewerModel === undefined ? {} : { modelReviewer: input.reviewerModel.text }) });
            done.push(`models: steward ${input.stewardModel?.text ?? "unchanged"}, workers ${input.workerModel?.text ?? "unchanged"}, reviewers ${input.reviewerModel?.text ?? "unchanged"}`);
          }
          for (const n of notes) tell(threadId, target, n);
          return `${target.entityKey}: ${done.join("; ")}.`;
        } catch (error) {
          return toolError(error);
        }
      }),
    });

    /** One open "needs you" item, with whether its button can act now and why not when it cannot. */
    function needView(n: Need, b: Binding): { id: string; bindingId: string; key: string; kind: string; url: string | null; entityUrl: string | null; escalationId: string | null; choices: string[]; lessonId: string | null; prUrl: string | null; what: string; how: string | null; specDiff: string | null; specChangedLines: number | null; specCommentUrl: string | null; specFullText: string | null; destination: string | null; threadId: string | null; createdAt: number; actionable: boolean; why: string | null; actions: NeedAction[]; freeText: boolean } {
      let actionable = true;
      let why: string | null = null;
      let threadId: string | null = null;
      if (n.kind === "approve-pr" || n.kind === "merge") {
        const observed = b.lastSnapshot;
        const target = observed === null ? null : [observed.entity, ...observed.pulls].find((e) => (e.url ?? e.key) === n.url || e.key === n.url) ?? null;
        const gate = target === null ? null : prGate(target, { projectApprovals: projectApprovalsFor(b), ...productGateOptions(b, target) });
        if (n.kind === "approve-pr") {
          actionable = gate?.needsOwnerApproval ?? false;
          why = actionable ? null : (gate?.missing ?? "the pull request has not been observed yet");
        } else {
          // BB-175: only a running turn can race a push; a `finished` worker
          // is a pause, and a steward-filed merge item exists because it
          // could not merge, so it must not keep the item not actionable.
          const busy = runningWorkerReason(store.workers(b.id));
          actionable = (gate?.gateMet ?? false) && busy === null;
          why = actionable ? null : busy ?? (gate?.missing ?? "the pull request has not been observed yet");
        }
      } else if (n.kind === "provide-secret") {
        // Always actionable: the page opens a requester thread and the form
        // appears in its first turn. Link the thread once one has been spawned.
        threadId = store.secretRequesterForNeed(n.id)?.threadId ?? null;
      }
      const { actions, freeText } = needActions(n, b);
      return { id: n.id, bindingId: b.id, key: b.entityKey, kind: n.kind, url: httpUrl(n.url), entityUrl: b.url, escalationId: typeof n.data.escalationId === "string" ? n.data.escalationId : null, choices: needChoices(n), lessonId: typeof n.data.lessonId === "string" ? n.data.lessonId : null, prUrl: typeof n.data.prUrl === "string" ? n.data.prUrl : null, what: n.what, how: n.how, specDiff: typeof n.data.specDiff === "string" ? n.data.specDiff : null, specChangedLines: typeof n.data.specChangedLines === "number" ? n.data.specChangedLines : null, specCommentUrl: typeof n.data.specCommentUrl === "string" ? n.data.specCommentUrl : null, specFullText: typeof n.data.specFullText === "string" ? n.data.specFullText : null, destination: n.kind === "provide-secret" ? secretDestination(n) : null, threadId, createdAt: n.createdAt, actionable, why, actions, freeText };
    }

    /**
     * Ring the project's refetch channel when the patch about to be written
     * would change an open need's `actionable` or `why`, as `needView` computes
     * them (BB-237). The page disables Approve from that flag, so a snapshot or
     * spec approval the reconcile just refreshed must reach it without waiting
     * for the half-minute poll; a patch that flips nothing stays silent. Called
     * before the patch, with the binding as it stands. `observed` is the
     * snapshot being written, and `ready` the `ReadyState` when the patch also
     * changes it (it feeds `needView` through `ticketApprovedSpec`); the other
     * call sites write only the snapshot and ending fields. An ended binding's
     * needs are off the board, so it never rings.
     */
    function signalNeedActionability(b: Binding, observed: Observed, ready?: ReadyState): void {
      if (b.endedAt !== null) return;
      const needs = store.openNeeds(b.id);
      if (needs.length === 0) return;
      const after: Binding = { ...b, lastSnapshot: observed, ...(ready === undefined ? {} : { ready }) };
      const flipped = needs.some((n) => {
        const before = needView(n, b);
        const next = needView(n, after);
        return before.actionable !== next.actionable || before.why !== next.why;
      });
      if (flipped) store.signal(b.projectId, ["last_snapshot"]);
    }

    /**
     * The board's "waiting on you" lists for one project, in one place so the
     * board and the sidebar cannot disagree: open questions, the route-`user`
     * escalations no question or item covers, and open needs. `actionableOnly`
     * drops needs the server cannot act on now, which the sidebar's badge and
     * block do not show; the board keeps them and says why.
     */
    function needsYou(projectId: string, opts: { actionableOnly?: boolean } = {}): { questions: ReturnType<typeof questionView>[]; withUser: ReturnType<typeof withUserView>[]; needs: ReturnType<typeof needView>[] } {
      const open = store.all(projectId).filter((b) => b.endedAt === null);
      const questions = store.openQuestions(projectId).map(questionView);
      const allNeeds = open.flatMap((b) => store.openNeeds(b.id).map((n) => needView(n, b)));
      // A question or a need covers the escalation it was made for: the page's
      // row is the question or the item, never the raw escalation.
      const covered = new Set([...questions.map((q) => q.escalationId), ...allNeeds.map((n) => n.escalationId), ...store.openQuestionEscalationIds(projectId)].filter((id): id is string => id !== null));
      const withUser = open.flatMap((b) => store.openEscalations(b.id).filter((x) => x.route === "user" && !x.isQuestion && x.resolutionKind === null && !covered.has(x.id)).map((x) => withUserView(x, b)));
      return { questions, withUser, needs: opts.actionableOnly === true ? allNeeds.filter((n) => n.actionable) : allNeeds };
    }

    /** The board's question row; the sidebar reuses it, tagged. */
    function questionView(q: Question) {
      const b = q.bindingId === null ? null : store.binding(q.bindingId);
      const { actions, freeText } = questionActions(q);
      return { id: q.id, question: q.question, context: q.context, choices: q.choices, key: b?.entityKey ?? null, url: b?.url ?? null, escalationId: q.escalationId, createdAt: q.createdAt, rationaleWanted: q.rationaleWanted, actions, freeText };
    }

    /** The board's with-user row; the sidebar reuses it, tagged. */
    function withUserView(x: Escalation, b: Binding) {
      const { actions, freeText } = withUserActions();
      return { id: x.id, kind: x.kind, question: x.question, context: x.context, recommendation: x.recommendation, key: b.entityKey, url: b.url, threadId: b.threadId, createdAt: x.createdAt, rationaleWanted: x.rationaleWanted, actions, freeText };
    }

    /**
     * The roles a binding is attributed to: its target key (a namespace,
     * Sentry project or Dependabot alert), or the pull watch that adopted it
     * (BB-164).
     */
    const rolesForBinding = (roleMap: Map<string, string[]>, b: Binding): string[] => roleMap.get(b.entityId) ?? (b.adoptedBy === null ? [] : roleMap.get(b.adoptedBy)) ?? [];

    /**
     * The hold a row shows for a binding (BB-256): its start hold, or, when it
     * has none but a merge hold stands, a merge hold behind the same keys. A
     * merge hold ranks the effort as held (the existing hold tier) with the
     * steward's `waitingOn` text rather than filing a Merge item, so the page
     * does not read as "needs you". The stored field drives the plugin; this is
     * presentation only.
     */
    function presentationHold(b: Binding): { hold: string | null; holdBehind: string[] } {
      if (b.hold !== null) return { hold: b.hold, holdBehind: b.holdBehind };
      if (b.mergeBehind.length > 0) return { hold: b.status?.waitingOn ?? "merge hold", holdBehind: b.mergeBehind };
      return { hold: null, holdBehind: [] };
    }

    /** `rolesFor` names the role(s) whose definition owns a binding's target, for `bb stewards list` (BB-163). */
    function formatBindings(rows: Binding[], rolesFor?: (b: Binding) => string[]): string {
      if (rows.length === 0) return "No bindings.";
      return rows
        .map((b) => {
          const s = b.status;
          const roles = rolesFor?.(b) ?? [];
          const open = store.openEscalations(b.id);
          const look = b.opsLook;
          const sentry = b.sentryLook;
          const watch =
            look !== null
              ? look.error !== null
                ? `cannot read the target: ${look.error}`
                : `looked ${iso(look.at)}: ${look.findings.length === 0 ? "nothing failing" : `${look.findings.length} problem(s) failing`}`
              : sentry === null
                ? null
                : sentry.error !== null
                  ? `cannot read the target: ${sentry.error}`
                  : `looked ${iso(sentry.at)}: ${sentry.findings.length === 0 ? "nothing new" : `${sentry.findings.length} issue(s) new, regressed or rung`}`;
          const needs = store.openNeeds(b.id);
          const flags = [b.endedAt === null ? null : `ended: ${b.endReason}`, watch, b.adoptedBy === null ? null : `adopted by ${b.adoptedBy}`, b.priority === null ? null : `priority ${b.priority}`, b.noMorePulls === true ? "no more pull requests" : null, b.hold === null ? null : `HOLD: ${b.hold}${b.holdBehind.length === 0 ? "" : ` (behind ${b.holdBehind.join(", ")})`}${b.holdStack.length === 0 ? "" : ` (stacked on ${b.holdStack.join(", ")})`}`, b.mergeBehind.length === 0 ? null : `MERGE HOLD: behind ${b.mergeBehind.join(", ")}`, ...open.map((x) => `${x.kind} escalation ${x.id} with ${x.route}`), ...needs.map((n) => `${n.kind} need ${n.id}${n.url === "" ? "" : ` (${n.url})`}`), unheardWait(s, open, needs), asksForOpenApproval(s, open, needs)].filter((f) => f !== null);
          return `${b.entityKey} — ${b.kind}, ${b.phase ?? "?"}${roles.length === 0 ? "" : `, role ${roles.join(", ")}`}${b.threadId === null ? "" : `, thread ${b.threadId}`}\n  ${s === null ? "no report yet" : `${s.summary} Next: ${s.nextAction} (${s.actor})${b.noWakeSource ? "; waiting, no wake source" : s.waitingOn === null ? "" : `; waiting on ${s.waitingOn}${b.requeueUntil === null ? "" : ` until ${iso(b.requeueUntil).slice(0, 10)}`}`}`}${flags.length > 0 ? `\n  [${flags.join("; ")}]` : ""}`;
        })
        .join("\n");
    }

    // ---- timers: requeue, the sweep, the nightly pass ----------------------------------------------

    async function requeueTick(): Promise<void> {
      if ((await settings.get()).paused) return;
      for (const b of store.dueRequeue()) scheduleReconcile(b.id);
    }

    /** The mechanical backstop: adoption, stuck, overdue endings, and a look at every binding. */
    let lastSweepAt: number | null = null;
    /**
     * Deliver answers queued by a resolve to their originating thread: a
     * worker gets a `bb thread tell` (brought back if archived), a steward a
     * wake with the answer under "What changed". Bindings between already got
     * a quiet note in the store and are never woken for it (BB-30).
     */
    async function flushDeliveries(): Promise<void> {
      for (const d of store.pendingDeliveries()) {
        const origin = d.originBindingId === null ? null : store.binding(d.originBindingId);
        // A binding the plugin already ended is not woken for an answer to an
        // escalation it resolved on the way out (BB-60).
        if (origin === null || origin.endedAt === null) {
          try {
            if (origin !== null && origin.threadId !== null && origin.threadId === d.originThreadId) {
              const config = await loadConfig(origin.projectId);
              const playbook = config === null ? null : bindingPlaybook(config, origin);
              let observed: Observed | null = origin.lastSnapshot;
              if (observed === null && origin.source !== "ops") {
                const entity = await snapshot(origin.source, origin.entityId).catch(() => null);
                if (entity !== null) observed = { entity, pulls: [] };
              }
              if (config !== null && config.enabled && playbook !== null && observed !== null) {
                await wake(origin, config, playbook, observed, [`Escalation ${d.escalationId} was answered by ${d.decidedBy}: ${d.text}`], "changed");
              }
            } else if (d.originThreadId !== null) {
              await sendTo(d.originThreadId, `An escalation you raised was answered by ${d.decidedBy}: ${d.text}`);
            }
          } catch (error) {
            bb.log.warn(`stewards: could not deliver an answer to ${d.originThreadId ?? d.originBindingId ?? "?"}: ${errorMessage(error)}`);
          }
        }
        store.markDeliveryDone(d.id);
      }
    }

    /**
     * End everything this server does for one project. It is the one path for
     * both a project bb no longer lists (deletion, `purge` its records) and one
     * switched off on this server (records kept, so switching back on resumes
     * rather than starts over): each open binding with a live steward gets its
     * one stop turn, one without ends at once, the project steward is archived,
     * and the source leases lapse on the next push. Binding lookup is global,
     * one steward per entity per server, so a deleted project's bindings would
     * otherwise keep a successor project watching the same teams and repos from
     * ever adopting them.
     */
    async function endProject(projectId: string, reason: string, opts: { purge: boolean; config?: ProjectConfig }): Promise<void> {
      const open = store.open(projectId);
      // A switched-off project keeps its records and can be switched back on,
      // so its bindings get a stop turn; a deleted one is purged and cannot.
      // The caller's already-validated config is used when given, so one
      // transient `.bb` read cannot turn the stop turns into hard endings.
      const config = opts.purge ? null : (opts.config ?? (await loadConfig(projectId, true)));
      for (const b of open) {
        await serial(`b:${b.id}`, async () => {
          const fresh = store.binding(b.id);
          if (fresh === null || fresh.endedAt !== null) return;
          if (fresh.ending !== null) {
            // Already ending: send no second stop turn, but finish one whose
            // turn never went idle, the same backstop every ending gets.
            const deadline = endingDeadline(fresh, timing.endingTimeoutMs);
            if (deadline !== null && now() > deadline) await finishEnding(fresh, fresh.ending);
            return;
          }
          const playbook = config === null ? null : bindingPlaybook(config, fresh);
          if (config === null || playbook === null) {
            await finishEnding(fresh, reason);
            return;
          }
          await beginDisabledEnding(fresh, config, playbook);
        });
      }
      // The project steward has no entity to report on and nothing left to
      // wake it, so it is archived rather than given a turn.
      const row = store.project(projectId);
      if (row.threadId !== null) {
        const threadId = row.threadId;
        store.patchProject(projectId, { threadId: null, title: null });
        await quietly(`archive the project steward ${threadId}`, () => bb.sdk.threads.archive({ threadId }));
      }
      const purged = opts.purge ? store.purgeProject(projectId) : [];
      for (const id of purged) sentryRung.delete(id);
      if (opts.purge) for (const key of [`good/${projectId}/project`, `good/${projectId}/roles`, projectEnabledKey(projectId)]) await quietly(`forget ${key}`, () => bb.storage.kv.delete(key));
      // A deleted project's cached configuration goes; a switched-off one stays,
      // disabled, so its leases are not re-sent and the switch shows without a re-read.
      if (opts.purge) configs.delete(projectId);
      guidanceIndexes.delete(projectId);
      projectHostCache.delete(projectId);
      nativeFetchedAt.delete(projectId);
      bb.log.info(
        opts.purge
          ? `stewards: project ${projectId} is gone; ended ${open.length} open binding(s), purged ${purged.length}, and released its leases`
          : `stewards: project ${projectId} was switched off; ended ${open.length} open binding(s) and kept its records`,
      );
      pushInterest();
    }

    /** The per-project body of the sweep: adoption, the project steward, ops bindings and a look at every binding. */
    async function sweepProject(config: ProjectConfig): Promise<void> {
      // Only an enabled project is swept: `sweep()` filters to enabled configs
      // and the enable path passes `{ ...config, enabled: true }`. Guard it here
      // so the invariant is local rather than resting on the callers (BB-116).
      if (!config.enabled) return;
      // BB-116: a binding the switch-off ended comes back whenever the project
      // is on, whatever the timing. The enable loop cancels an ending still in
      // flight and reopens one already ended; this backstop catches the paths
      // that interleave with it (a server restart partway through, an idle
      // handler that ended the binding after the switch was already on), so a
      // stranded `[ended: disabled]` cannot survive a sweep. A binding
      // detached by hand stays ended; a reopened one is woken by the reconcile
      // scheduled for it below.
      for (const b of store.all(config.projectId)) {
        if (!switchOffHeld(b)) continue;
        await serial(`b:${b.id}`, async () => {
          const fresh = store.binding(b.id);
          if (fresh === null || !switchOffHeld(fresh)) return;
          await reopen(fresh, "the project's stewards were switched back on");
        });
      }
      if (!(await settings.get()).paused) await adoptionPass(config);
      await retireProjectSteward(config);
      await keepProjectSteward(config.projectId);
      await syncOpsBindings(config);
      await reconcileLessons(config);
      applyLessonTransitions(config);
      applyRationaleClustering(config);
      for (const b of store.open(config.projectId)) {
        if (b.threadId !== null) await keepSteward(config.projectId, b.threadId);
        const deadline = endingDeadline(b, timing.endingTimeoutMs);
        if (deadline !== null && now() > deadline) {
          await serial(`b:${b.id}`, async () => {
            const fresh = store.binding(b.id);
            if (fresh === null || fresh.ending === null || fresh.endedAt !== null) return;
            if (followingThrough(fresh)) await followThroughRanOut(fresh);
            else await finishEnding(fresh, fresh.ending!);
          });
          continue;
        }
        const playbook = bindingPlaybook(config, b);
        if (playbook !== null) {
          const limit = stuckDue(b, playbook, store.openEscalations(b.id), now());
          if (limit !== null) await raise(b, "stuck", `${b.entityKey}'s status has not moved in ${formatDuration(limit)} (phase ${b.phase}). What should happen?`, "Carrying on as before.");
        }
        scheduleReconcile(b.id);
      }
    }

    /** Drop the recorded send hashes older than twice the approval lookback; `userSaid` never reads them (BB-178). The hash is recorded just before the send, so a turn's `createdAt` is slightly later than its hash: the second lookback keeps a hash alive well past the turn's own window. */
    async function pruneSentHashes(): Promise<void> {
      const cutoff = now() - 2 * timing.approvalLookbackMs;
      for (const key of await bb.storage.kv.list("sent/")) {
        const at = await bb.storage.kv.get<number>(key);
        if (typeof at === "number" && at < cutoff) await bb.storage.kv.delete(key);
      }
    }

    async function sweep(): Promise<void> {
      lastSweepAt = now();
      await quietly("prune the recorded sent-message hashes", pruneSentHashes);
      await flushDeliveries();
      // One list for the stewarded projects and for the deleted ones below; a
      // failed read throws here, so a transient error never purges anything.
      const listed = await bb.sdk.projects.list();
      const configured = await configuredProjects(true, listed);
      const projects = configured.filter((c) => c.enabled);
      const ids = new Set(listed.map((p) => p.id));
      for (const projectId of store.projectIds()) {
        if (!ids.has(projectId)) await quietly(`retire the deleted project ${projectId}`, () => endProject(projectId, "project deleted", { purge: true }));
      }
      // A project switched off on this server ends anything it still holds:
      // the first sweep after the switch is a no-op, and the first sweep after
      // the upgrade ends what the default-off change left running, once.
      for (const config of configured) {
        if (config.enabled) continue;
        const row = store.project(config.projectId);
        // A binding with no ending is pending; so is one whose stop turn never
        // went idle, so the ending backstop still reaches a switched-off project.
        const pending = store.open(config.projectId).filter((b) => {
          if (b.ending === null) return true;
          const deadline = endingDeadline(b, timing.endingTimeoutMs);
          return deadline !== null && now() > deadline;
        });
        if (pending.length === 0 && row.threadId === null) continue;
        await quietly(`switch off the disabled project ${config.projectId}`, () => endProject(config.projectId, "disabled", { purge: false, config }));
      }
      pushInterest();
      for (const config of projects) await sweepProject(config);
    }

    const running = new Set<string>();

    /** One night for one project: adoption, a turn for every binding, then the project steward's digest. */
    async function nightlyPass(config: ProjectConfig, night: string, anytime = false): Promise<void> {
      // `bb stewards pass --nightly` runs now, whatever the hour, for at most two hours.
      const deadline = now() + 2 * 60 * 60_000;
      const inNight = () => (anytime ? now() < deadline : stillNight(now(), config.file.nightly, night));
      if (!config.enabled) return;
      if (running.has(config.projectId)) return;
      running.add(config.projectId);
      try {
        bb.log.info(`stewards: nightly pass for ${config.projectId} (${night})`);
        // The orphan list is read here so the digest can name the labelled
        // tickets nobody is assigned, which are adopted nowhere (BB-115).
        // Only the project steward's digest uses it, so a server without the
        // role does not pay for the extra snapshots.
        const adoption = (await settings.get()).paused ? { adopted: 0, unassigned: [] } : await adoptionPass(config, { collectUnassigned: config.role?.projectSteward === true });
        await reconcileLessons(config);
        applyLessonTransitions(config);
        applyValidations(config);
        applyRationaleClustering(config);
        // BB-35 step 4: an answer that went against a recommendation and has not
        // had its one follow-up yet is asked in the digest wake.
        const followUps = store.escalationsWithPendingRationale(config.projectId, AFTER_THE_FACT_RATIONALE_WHY);
        const order = store
          .open(config.projectId)
          .filter((b) => b.hold === null && b.ending === null)
          .sort((a, b) => (PRIORITY_ORDER[a.priority ?? "normal"] ?? 2) - (PRIORITY_ORDER[b.priority ?? "normal"] ?? 2) || (a.lastJudgmentAt ?? 0) - (b.lastJudgmentAt ?? 0));
        const woken: string[] = [];
        for (const b of order.slice(0, config.file.nightly.max)) {
          if (disposed || !inNight()) break;
          await serial(`b:${b.id}`, () => reconcileBinding(b.id, "nightly"));
          if (store.binding(b.id)?.threadId) woken.push(store.binding(b.id)!.threadId!);
          await new Promise((r) => setTimeout(r, timing.nightlyStaggerMs));
        }
        // The project steward reads the fresh records, so it waits for the turns.
        while (!disposed && inNight()) {
          const states = await Promise.all(woken.map((t) => threadInfo(t).catch(() => null)));
          if (!states.some((s) => s !== null && busy(s.status))) break;
          await new Promise((r) => setTimeout(r, 30_000));
        }
        if (!disposed) {
          // Mark only once the wake is really sent, so a disposed pass leaves
          // the follow-up for the next one.
          for (const x of followUps) store.markEscalationRationaleAsked(x.id);
          await wakeProject(config.projectId, `nightly pass ${night}`, {
            digestDue: true,
            notes: [
              `${woken.length} binding(s) had a turn tonight.`,
              ...adoption.unassigned.map((t) => `labelled, no assignee: ${t.key}${t.title === null ? "" : ` ${t.title}`}${t.url === null ? "" : ` — ${t.url}`}. Assign it in Linear to the server that should own it; this one does not adopt it.`),
              ...followUps.map((x) => `The user's answer on ${x.id} went against your recommendation. Ask them once, in this thread, why — one follow-up — then record their reasoning as a lesson candidate with steward_update { lesson: { text, file, scope } }.`),
            ],
          });
        }
      } finally {
        running.delete(config.projectId);
      }
    }

    async function nightlyTick(): Promise<void> {
      for (const config of await stewardedProjects()) {
        const row = store.project(config.projectId);
        const night = nightlyDue(now(), config.file.nightly, row.nightlyDate);
        if (night === null) continue;
        store.patchProject(config.projectId, { nightlyDate: night });
        void nightlyPass(config, night).catch((error: unknown) => bb.log.warn(`stewards: nightly pass for ${config.projectId}: ${errorMessage(error)}`));
      }
    }

    bb.background.schedule("nightly", "*/5 * * * *", nightlyTick);
    if (hooksUrl !== "") {
      // The stream is opened only once a project lists a Sentry target; a
      // server with none holds no stream for a source it never leases on.
      bb.background.service("sentry-hooks", {
        async start(signal) {
          while (!signal.aborted && !sentryWanted()) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 60_000);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
          }
          if (!signal.aborted) await sentryHooks.run(signal);
        },
      });
    }
    bb.background.service("loop", {
      async start(signal) {
        // BB-93: nothing hides threads any more; the first start after the
        // upgrade shows the ones the old hide path left hidden.
        await unhideOnce().catch((e: unknown) => bb.log.warn(`stewards: one-time unhide: ${errorMessage(e)}`));
        // BB-213: the first start after dropping the actor clause gives every
        // open actor-`user` binding the item its badge will now stand on.
        await backfillAutoNeedsOnce().catch((e: unknown) => bb.log.warn(`stewards: one-time auto-need backfill: ${errorMessage(e)}`));
        // BB-253: mute the steward trees that already exist, once.
        await muteStewardThreadsOnce().catch((e: unknown) => bb.log.warn(`stewards: one-time steward mute: ${errorMessage(e)}`));
        const requeue = setInterval(() => void requeueTick().catch((e: unknown) => bb.log.warn(`stewards: requeue: ${errorMessage(e)}`)), timing.requeueTickMs);
        const sweeper = setInterval(() => void sweep().catch((e: unknown) => bb.log.warn(`stewards: sweep: ${errorMessage(e)}`)), timing.sweepMs);
        // The first sweep tells linear and github what to watch after a restart.
        void sweep().catch((e: unknown) => bb.log.warn(`stewards: sweep: ${errorMessage(e)}`));
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        clearInterval(requeue);
        clearInterval(sweeper);
      },
    });

    // ---- the CLI --------------------------------------------------------------------------------------

    const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;
    const PROJECT_OPTION = { type: "string", description: "The project id; the invoking thread's project when left out" } as const;

    function projectOf(option: string | undefined, ctx: { projectId?: string }): string {
      const id = option ?? ctx.projectId;
      if (id === undefined || id === "") throw new PluginCliError("No project: run this from a thread, or pass --project.", { code: "no_project" });
      return id;
    }

    function bindingOrThrow(key: string, projectId?: string): Binding {
      const b = store.find(key, projectId);
      if (b === null)
        throw new PluginCliError(`No binding for ${key}${projectId === undefined ? "" : ` in project ${projectId}`}.`, {
          code: "binding_not_found",
          hint: "bb stewards list --all shows the project's bindings; pass --project for another project's.",
        });
      return b;
    }

    /**
     * The binding `brief`/`spawn-flags`/`gate`/`merge` acts on: the positional,
     * or the invoking thread's own. A worker thread resolves to its binding when
     * `worker` is set, so a worker can ask for its reviewer's spawn command and
     * its pull request's gate without naming the ticket (BB-133).
     */
    function bindingFromCli(positional: string | undefined, option: string | undefined, ctx: { threadId?: string; projectId?: string }, opts: { worker?: boolean } = {}): Binding {
      if (positional !== undefined && positional !== "") return bindingOrThrow(positional, option ?? ctx.projectId);
      const worker = opts.worker === true && ctx.threadId !== undefined ? store.worker(ctx.threadId) : null;
      const own = ctx.threadId === undefined ? null : store.byThread(ctx.threadId) ?? (worker === null ? null : store.binding(worker.bindingId));
      if (own === null) {
        const project = ctx.threadId === undefined ? null : store.projectByThread(ctx.threadId);
        throw new PluginCliError("This thread is not the steward of a binding; pass one (an entity key or binding id).", {
          code: "no_binding",
          hint: project === null ? "bb stewards list shows the project's bindings." : "The project steward starts no workers; run `bb stewards brief` for its invariants.",
        });
      }
      return own;
    }

    /**
     * The binding that watches a pull request: the invoking thread's own when
     * there is one, a binding whose own entity is the pull request, or any open
     * binding in the project whose last snapshot links it. Null when none does.
     * An explicit `project` (a `--project` lookup) resolves in that project
     * alone and does not use the invoking thread's own binding, so a pull
     * request in another project resolves from any thread.
     */
    function bindingForPullRef(ref: { repo: string; number: number }, ctx: { threadId?: string; projectId?: string }, project?: string): Binding | null {
      const projectId = project ?? ctx.projectId;
      const key = `${ref.repo}#${ref.number}`;
      // A binding whose own entity is the pull request (a review or pr
      // binding) wins, so a worker asking about another binding's pull request
      // does not read its own binding's approvals.
      const direct = store.find(key, projectId);
      if (direct !== null && direct.endedAt === null) return direct;
      if (project === undefined && ctx.threadId !== undefined) {
        const worker = store.worker(ctx.threadId);
        const own = store.byThread(ctx.threadId) ?? (worker === null ? null : store.binding(worker.bindingId));
        if (own !== null && own.endedAt === null) return own;
      }
      const matches = (b: Binding) => b.lastSnapshot !== null && observedPulls(b, b.lastSnapshot).some((p) => (p.url ?? p.key) === key || p.key === key);
      const candidates = projectId === undefined ? store.open() : store.open(projectId);
      return candidates.find(matches) ?? null;
    }

    /** The pull request a CLI ref names, read fresh from GitHub; null when it cannot be read. */
    async function readPullRef(ref: { repo: string; number: number }): Promise<EntitySnapshot | null> {
      return snapshot("github", `${ref.repo}#${ref.number}`).catch(() => null);
    }

    /** The worker spawn flags for a binding: the project source's environment first, then the playbook's worker model. */
    async function workerFlagsFor(b: Binding, playbook: Playbook, source: ProjectSource | null): Promise<string> {
      return [environmentFlags(source, await projectHost(b.projectId)), workerFlags(workerModel(b, playbook))].filter((f) => f !== "").join(" ");
    }

    /**
     * Switch this server's stewards for one project on or off. Turning on
     * sweeps the project at once, so its project steward and ops bindings start
     * now, and reopens the bindings the switch-off ended. Turning off runs the
     * shared end path: a stop turn for each open binding, the project steward
     * archived, and the leases released, with the records kept.
     */
    async function setProjectEnabledForUser(projectId: string, enabled: boolean): Promise<{ ok: boolean; message: string; enabled: boolean }> {
      const config = await loadConfig(projectId, true);
      if (config === null) return { ok: false, message: `Project ${projectId} has no ${PROJECT_FILE}; run bb stewards init.`, enabled: false };
      if (config.enabled === enabled) return { ok: true, message: enabled ? `Stewards are already on for ${config.file.label}.` : `Stewards are already off for ${config.file.label}.`, enabled };
      await setProjectEnabled(projectId, enabled);
      // The configuration was just read, so keep it cached with the new switch:
      // the interest set and the stop turns see it without a second `.bb` read.
      configs.set(projectId, { at: now(), value: { ...config, enabled } });
      bb.realtime.publish(PROJECT_CHANGED, { projectId });
      if (enabled) {
        // Resume what the switch-off ended rather than start over. A binding
        // whose stop turn is still running (`ending === "disabled"`, not
        // ended) is reopened too, so the turn going idle cannot end it after
        // the project is already back on (BB-116).
        for (const b of store.all(projectId)) {
          if (!switchOffHeld(b)) continue;
          await serial(`b:${b.id}`, async () => {
            const fresh = store.binding(b.id);
            if (fresh === null || !switchOffHeld(fresh)) return;
            await reopen(fresh, "the project's stewards were switched back on");
          });
        }
        // The configuration was just read above, so a transient `.bb` failure
        // here cannot silently skip the sweep the message promises.
        await ensureProjectSteward(config);
        await sweepProject({ ...config, enabled: true });
        return { ok: true, message: `Stewards are on for ${config.file.label}; swept now.`, enabled: true };
      }
      await endProject(projectId, "disabled", { purge: false, config });
      return { ok: true, message: `Stewards are off for ${config.file.label}; open bindings are ending.`, enabled: false };
    }

    /** How a `check` or `list` line names the role this server runs. */
    function roleSummary(config: ProjectConfig): string {
      if (!config.rolesPresent) return "none (legacy project.ops, run on every server)";
      const who = config.githubLogin ?? "(login unreadable)";
      if (config.role === null) return `${who} has no entry`;
      // Version 1 keeps its exact wording: its role name is the login itself,
      // so it only adds the project-steward note. Version 2 names the roles.
      if (config.roles !== null && config.roles.version === 1) return `${who}${config.role.projectSteward ? " (project steward)" : ""}`;
      return `${who} (${config.roleNames.length > 0 ? config.roleNames.join(", ") : "no roles"})`;
    }

    /**
     * Whether a `sourceEnsureLabel` failure means the source does not serve
     * the RPC at all: an unloaded/absent plugin (`isMissingPlugin`), or a
     * loaded plugin whose contract predates it (the SDK's `unknown_method`).
     * Anything else is a real failure and prints its own message.
     */
    function rpcUnavailable(error: unknown): boolean {
      if (isMissingPlugin(error)) return true;
      const e = error as { code?: unknown; message?: unknown };
      if (e?.code === "unknown_method") return true;
      return typeof e?.message === "string" && /unknown rpc method/iu.test(e.message);
    }

    /**
     * `check --create-labels` first creates the project's label in every
     * unit, then validates as plain `check` does. A unit that could not be
     * created is a `failed:` line and a `problem:` line, never a silent
     * skip; a source that does not serve the RPC is reported unavailable.
     */
    async function ensureLabels(source: Source, units: string[], label: string, lines: string[]): Promise<void> {
      if (units.length === 0) return;
      let results: z.infer<typeof sourceContract.sourceEnsureLabel.output>["results"];
      try {
        results = (await sourceRpc(source, "sourceEnsureLabel", { units, label }, sourceContract.sourceEnsureLabel.output)).results;
      } catch (error) {
        const why = rpcUnavailable(error) ? "sourceEnsureLabel is unavailable (the source plugin does not support it)" : errorMessage(error);
        lines.push(`problem: ${source}: could not create label ${label}: ${why}`);
        return;
      }
      for (const r of results) {
        const what = source === "linear" ? `linear team ${r.unit}` : `github repo ${r.unit}`;
        if (r.status === "created") lines.push(`created label ${label} in ${what}`);
        else if (r.status === "existed") lines.push(`existed label ${label} in ${what}`);
        else {
          const detail = r.error ?? "unknown error";
          lines.push(`failed to create label ${label} in ${what}: ${detail}`);
          lines.push(`problem: ${source}: ${r.unit}: could not create label ${label}: ${detail}`);
        }
      }
    }

    async function check(projectId: string, options: { createLabels?: boolean } = {}): Promise<{ ok: boolean; lines: string[] }> {
      const config = await loadConfig(projectId, true);
      if (config === null) {
        const error = configErrors.get(projectId);
        if (error !== undefined) return { ok: false, lines: [`problem: could not read the configuration: ${error}`] };
        return { ok: false, lines: [`No ${PROJECT_FILE} on the project's .bb. Run bb stewards init.`] };
      }
      const lines: string[] = [...config.problems.map((p) => `problem: ${p}`), ...config.warnings.map((w) => `warning: ${w}`), ...config.hints];
      if (!config.enabled) lines.push(`Stewards are off for this project on this server; nothing is adopted and no steward is woken. Switch on with bb stewards enable --project ${projectId}.`);
      lines.push(`Project source: ${projectSourceLabel(config.source.kind)}`);
      const linearTicket = config.ticketPlaybooks.linear ?? null;
      const githubTicket = config.ticketPlaybooks.github ?? null;
      lines.push(`Linear teams: ${config.file.linear.teams.join(", ") || "(none)"}; repos: ${config.repos.join(", ") || "(none)"}${config.file.github.exclude.length > 0 ? ` (excluded: ${config.file.github.exclude.join(", ")})` : ""}; label ${config.file.label}`);
      lines.push(`roles: ${roleSummary(config)}`);
      for (const kind of KINDS.filter((k) => usesKind(config.file, k, config.role))) {
        if (kind === "ticket") {
          // BB-234: name each source's ticket playbook, so a project that
          // carries both does not hide the GitHub one behind the Linear one.
          const parts = (["linear", "github"] as const)
            .map((source) => [source, config.ticketPlaybooks[source]] as const)
            .filter(([, p]) => p !== undefined)
            .map(([source, p]) => `${p!.name}@${p!.version} (${source})`);
          lines.push(`ticket: ${parts.length === 0 ? `no usable playbook (${playbookNameFor(config.file, "ticket")})` : parts.join(", ")}`);
          continue;
        }
        const p = config.playbooks[kind];
        lines.push(`${kind}: ${p === undefined ? `no usable playbook (${playbookNameFor(config.file, kind)})` : `${p.name}@${p.version}`}`);
      }
      lines.push(`deps-alerts: ${config.depsAlerts === null ? `no playbook (${depsAlertsPlaybookName(config.file)}); the dependency watch is off` : `${config.depsAlerts.name}@${config.depsAlerts.version}`}`);
      lines.push(`deps-prs: ${config.depsPrs === null ? `no playbook (${depsPrsPlaybookName(config.file)}); Dependabot pull requests are not adopted` : `${config.depsPrs.name}@${config.depsPrs.version}`}`);
      // The pull watches this server runs, synthesized Dependabot first, so
      // `check` shows the shape and `list` shows which one adopted a binding
      // (BB-164).
      const watches = rolePullWatches(config.role, config.repos, depsPrsPlaybookName(config.file));
      if (watches.length > 0) lines.push(`pulls: ${watches.map((w) => pullWatchId(w)).join(", ")}`);
      // The project-level ticket watches, so `check` shows the shape and
      // `list` shows which one adopted a binding (BB-246).
      if (config.file.tickets.length > 0) lines.push(`tickets: ${config.file.tickets.map((w) => ticketWatchId(w)).join(", ")}`);
      const filing = roleOpsTeam(config.role, config.file);
      // BB-235: a GitHub filing target needs the priority labels its autoAdopt
      // names, and `status:todo` so an autoAdopt issue is adopted as a ticket.
      // BB-236's `ensureLabels` creates them; check reports a filing repo that
      // lacks one. The labels are computed once, for the ensure and the check.
      const filingGithub = filing !== null && filing.source === "github" ? filing.target : null;
      const priorityLabels: string[] = [];
      if (filingGithub !== null) {
        const priorities = new Set<string>();
        for (const p of config.role?.ops?.autoAdopt ?? []) priorities.add(priorityLabel(p));
        for (const s of config.file.deps.autoAdopt) priorities.add(priorityLabelForSeverity(s));
        priorityLabels.push(...priorities);
      }
      if (options.createLabels === true) {
        await ensureLabels("linear", config.file.linear.teams, config.file.label, lines);
        await ensureLabels("github", config.repos, config.file.label, lines);
        // BB-234: a GitHub issue playbook keys its phases on status labels, so
        // the same step ensures each label state exists in every stewarded
        // repo, reporting created/existed/failed per label. GitHub's own
        // derived states (open, closed (reason)) are not labels and are skipped.
        if (githubTicket !== null) for (const label of githubStateLabels(githubTicket)) await ensureLabels("github", config.repos, label, lines);
        // BB-235: the filing repo's priority labels, and `status:todo` when no
        // `github-issues` playbook already creates it in every repo.
        if (filingGithub !== null && priorityLabels.length > 0) {
          for (const label of priorityLabels) await ensureLabels("github", [filingGithub], label, lines);
          if (githubTicket === null) await ensureLabels("github", [filingGithub], GITHUB_TODO_LABEL, lines);
        }
      }
      const validate = async (source: Source, units: string[], states: string[], labels: string[] = []) => {
        if (units.length === 0) return;
        try {
          const out = await sourceRpc(source, "sourceValidate", { units, label: config.file.label, states }, sourceContract.sourceValidate.output);
          if (out.error !== null) {
            lines.push(`problem: ${source}: ${out.error}`);
            return;
          }
          for (const u of out.units) {
            if (!u.found) lines.push(`problem: ${source}: ${u.unit} is not visible`);
            else if (!u.labelFound) lines.push(`problem: ${source}: ${u.unit} has no label ${config.file.label}`);
            if (u.missingStates.length > 0) lines.push(`problem: ${source}: ${u.unit} has no state ${u.missingStates.join(", ")}`);
          }
        } catch (error) {
          lines.push(`problem: could not validate against ${source}: ${errorMessage(error)}`);
          return;
        }
        // BB-248: a `label:` phase key names a label, not a workflow state, so
        // it is checked through the source's single-label field. The source
        // reads one label per call, so this is one read per distinct name.
        for (const name of labels) {
          if (lc(name) === lc(config.file.label)) continue;
          try {
            const out = await sourceRpc(source, "sourceValidate", { units, label: name, states: [] }, sourceContract.sourceValidate.output);
            if (out.error !== null) {
              lines.push(`problem: ${source}: ${out.error}`);
              continue;
            }
            for (const u of out.units) if (u.found && !u.labelFound) lines.push(`problem: ${source}: ${u.unit} has no label ${name}`);
          } catch (error) {
            lines.push(`problem: could not validate against ${source}: ${errorMessage(error)}`);
          }
        }
      };
      await validate("linear", config.file.linear.teams, linearTicket === null ? [] : playbookStates(linearTicket), linearTicket === null ? [] : playbookLabels(linearTicket));
      await validate("github", config.repos, githubTicket === null ? [] : githubStateLabels(githubTicket), githubTicket === null ? [] : playbookLabels(githubTicket));
      if (filingGithub !== null && priorityLabels.length > 0) await validate("github", [filingGithub], priorityLabels);
      if (usesKind(config.file, "ops", config.role)) {
        const auto = config.role?.ops?.autoAdopt ?? [];
        const context = config.role?.ops?.context;
        lines.push(`ops: tickets filed in ${filing === null ? "(no target)" : `${filing.target} (${filing.source})`}${auto.length > 0 ? `, adopted when filed at ${auto.join(", ")}` : ""}`);
        const host = await projectHost(projectId);
        lines.push(`ops: kubectl runs on ${host ?? "no machine"}${context === undefined ? ", in its current context" : `, in context ${context}`}`);
        const reader = opsReaderFor(config);
        for (const target of roleK8sTargets(config.role)) lines.push(...opsAccessLines(opsTargetKey(target), await reader.access(target).catch((error: unknown): OpsAccess => ({ error: errorMessage(error), reads: [], logs: null, writes: [] }))));
        const sentry = roleSentryTargets(config.role);
        if (sentry.length > 0) {
          if ((await sentryToken()) === null) lines.push(`problem: sentry: ${NO_TOKEN}: set the Sentry token in the stewards plugin's settings (a user auth token with ${TOKEN_SCOPES.join(" and ")})`);
          const sentryApi = await sentryReader();
          for (const target of sentry) {
            const key = opsTargetKey(target);
            const a = await sentryApi.access(target);
            lines.push(a.ok ? `sentry: ${key} is readable (${a.name})` : `problem: sentry: cannot read the target ${key}: ${a.error}`);
            const refused = sentryRefused.get(`project ${target.org}/${target.project}`);
            if (refused !== undefined) lines.push(`sentry: ${key}: bb-gate-hooks refused its project lease (${refused}); only the periodic look sees it`);
          }
          const status = sentryHooks.status();
          lines.push(hooksUrl === "" ? "sentry: no bb-gate-hooks here (BB_HOOKS_URL is not set), so Sentry issues are seen by the periodic look only" : `sentry: doorbells from bb-gate-hooks: ${status.state}${status.state === "connected" ? (status.leased ? ", leased" : ", not leased") : ""}`);
        }
      }
      const deps = config.file.deps;
      const slaText = (v: number | "asap") => (v === "asap" ? "asap" : formatDuration(v));
      lines.push(`deps: sla critical=${slaText(deps.sla.critical)} high=${slaText(deps.sla.high)} medium=${slaText(deps.sla.medium)} low=${slaText(deps.sla.low)}; batch medium=${formatDuration(deps.batch.medium)} low=${formatDuration(deps.batch.low)}; autoAdopt ${deps.autoAdopt.join(", ") || "(none)"}`);
      const deployTargets = deploymentTargets(config);
      if (deployTargets.length > 0) lines.push(`deployment: ${deployTargets.map((t) => `${t.repo} ${t.environment} (timeout ${formatDuration(t.timeout)})`).join(", ")}`);
      // A watch whose repo matches no structured carries rule cannot be
      // decided by the plugin, so the steward is woken for it. Report the repo
      // so a rule can be added (BB-204). A deployment target whose own repo
      // has no rule is the same gap before a watch exists.
      const ruleGaps = new Set<string>();
      for (const target of deployTargets) {
        if (typeof target.carries === "string") continue;
        if (!target.carries.some((r) => r.when.repo.toLowerCase() === target.repo.toLowerCase())) ruleGaps.add(target.repo);
      }
      for (const b of store.open(projectId)) {
        for (const w of Object.values(b.deployments)) {
          if (w.prRepo === "") continue;
          const target = deployTargets.find((t) => (w.target === "" ? matchesTarget(t, w.repo, w.environment) : targetKeyOf(t) === w.target));
          if (target === undefined || typeof target.carries === "string") continue;
          if (matchCarriesRule(target.carries, w.prRepo, w.files) === null) ruleGaps.add(w.prRepo);
        }
      }
      for (const repo of [...ruleGaps].sort()) lines.push(`problem: repo ${repo} has a deployment target but no carries rule`);
      const depsRepos = roleDepsTargets(config.role, config.repos);
      if (config.depsAlerts !== null && depsRepos.length > 0) {
        lines.push(`deps: watching ${depsRepos.length} repo${depsRepos.length === 1 ? "" : "s"} for alerts: ${depsRepos.map((t) => t.repo).join(", ")}`);
        try {
          const out = await sourceRpc("github", "sourceDependabotAlerts", { units: depsRepos.map((t) => t.repo), state: "open" }, sourceContract.sourceDependabotAlerts.output);
          if (out.viewer !== null) lines.push(`deps: reading alerts as ${out.viewer}`);
          for (const e of out.errors) lines.push(`deps: skipping ${e}: the gh login cannot read its alerts (a skip, not a problem)`);
        } catch (error) {
          lines.push(`problem: deps: could not read alerts: ${errorMessage(error)}`);
        }
      }
      return { ok: !lines.some((l) => l.startsWith("problem:")), lines };
    }

    /** Whether a project file names a project steward in roles.json, so it needs no onboarding. */
    function hasProjectSteward(config: ProjectConfig | null): boolean {
      return config !== null && config.roles !== null && Object.values(config.roles.roles).some((role) => role.projectSteward === true);
    }

    /** Spawn the ordinary thread that onboards a project, with the onboarding skill loaded. */
    async function onboardProject(projectId: string): Promise<{ ok: boolean; threadId: string | null; message: string }> {
      const source = (await selectProjectSource(projectId)).source;
      const hostId = await projectHost(projectId);
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: freshEnvironment(source, hostId),
        prompt: ONBOARDING_INTRO,
        title: "Set up stewards",
        pluginMetadata: { role: "onboarding", threadBriefs: THREAD_BRIEFS_OFF },
      });
      bb.log.info(`stewards: started a Set up stewards thread for ${projectId} (${thread.id})`);
      return { ok: true, threadId: thread.id, message: `Started a Set up stewards thread (${thread.id}).` };
    }

    /** What `bb stewards check` says about one ops target: readable or not, and whether its logs are. */
    function opsAccessLines(key: string, a: OpsAccess): string[] {
      if (a.error !== null) return [`problem: ops: cannot read the target ${key}: ${a.error}`];
      const pods = a.reads.find((r) => r.what === "get pods");
      if (pods !== undefined && !pods.ok) return [`problem: ops: cannot read the target ${key}: get pods: ${pods.detail ?? "refused"}`];
      const lines = [`ops: ${key} is readable (${a.reads.filter((r) => r.ok).map((r) => r.what).join(", ")}); logs ${a.logs === true ? "readable" : a.logs === false ? "not readable, so diagnosis is from status and events" : "unknown"}`];
      for (const r of a.reads.filter((x) => !x.ok)) lines.push(`ops: ${key}: cannot ${r.what} (${r.detail ?? "refused"}); looks go without it`);
      // Expected: kubectl acts as the developer. Said so nobody mistakes the playbook for a wall.
      if (a.writes.length > 0) lines.push(`ops: ${key}: this identity may also ${a.writes.join(", ")}; the plugin and the playbook keep to ${KUBECTL_VERBS.join(", ")}`);
      return lines;
    }

    // ---- the onboarding survey (BB-180) ----------------------------------------

    /** The workflow states the project's ticket playbook expects, for the survey's Linear section. */
    function surveyExpectedStates(config: ProjectConfig | null): string[] {
      const playbook = config?.ticketPlaybooks.linear ?? (() => { const parsed = parsePlaybook(LINEAR_TICKETS, "linear-tickets"); return parsed.ok ? parsed.value : null; })();
      return playbook === null ? [] : playbookStates(playbook);
    }

    const surveyUnavailable = (error: string): Available<never> => ({ available: false, error });

    /** Gather one repo's GitHub facts and the text of the files the survey reads. */
    async function gatherSurveyRepo(entry: { dir: string; url: string }, repo: string | null, otherRepos: { repo: string | null; url: string }[]): Promise<SurveyRepoInput> {
      const contents = new Map<string, string | null>();
      if (repo === null) {
        const error = `${entry.url} is not a GitHub repository`;
        return { dir: entry.dir, url: entry.url, repo, defaultBranch: null, branchProtection: surveyUnavailable(error), labels: surveyUnavailable(error), tree: null, treeError: error, contents, otherRepos };
      }
      let defaultBranch: string | null = null;
      try {
        defaultBranch = await github.defaultBranch(repo);
      } catch {
        defaultBranch = null;
      }
      let branchProtection: Available<BranchProtection>;
      if (github.branchProtection === undefined) branchProtection = surveyUnavailable("the gh writer does not read branch protection");
      else if (defaultBranch === null) branchProtection = surveyUnavailable("the repository has no readable default branch");
      else {
        try {
          const rule = await github.branchProtection(repo, defaultBranch);
          branchProtection = { available: true, value: rule ?? { protected: false, requiredApprovingReviewCount: null, requiresStatusChecks: null } };
        } catch (error) {
          branchProtection = surveyUnavailable(errorMessage(error));
        }
      }
      let labels: Available<string[]>;
      if (github.labels === undefined) labels = surveyUnavailable("the gh writer does not read labels");
      else {
        try {
          labels = { available: true, value: await github.labels(repo) };
        } catch (error) {
          labels = surveyUnavailable(errorMessage(error));
        }
      }
      let tree: GithubTreeEntry[] | null = null;
      let treeError: string | null = null;
      if (github.tree === undefined) treeError = "the gh writer does not read a repository tree";
      else if (defaultBranch === null) treeError = "the repository has no readable default branch";
      else {
        try {
          tree = await github.tree(repo, defaultBranch);
        } catch (error) {
          tree = null;
          treeError = errorMessage(error);
        }
      }
      if (tree !== null && github.fileContent !== undefined && defaultBranch !== null) {
        for (const path of surveyWantedPaths(tree)) {
          try {
            contents.set(path, await github.fileContent(repo, path, defaultBranch));
          } catch {
            contents.set(path, null);
          }
        }
      }
      return { dir: entry.dir, url: entry.url, repo, defaultBranch, branchProtection, labels, tree, treeError, contents, otherRepos };
    }

    /** Gather the Linear teams and workflow states the survey reports. */
    async function gatherSurveyLinear(config: ProjectConfig | null): Promise<SurveyLinear> {
      const label = config?.file.label ?? DEFAULT_LABEL;
      const configured = config?.file.linear.teams ?? [];
      const expected = surveyExpectedStates(config);
      try {
        const out = await sourceRpc("linear", "sourceValidate", { units: configured, label, states: expected }, sourceContract.sourceValidate.output);
        if (out.error !== null) return { available: false, error: out.error };
        const names = new Map(out.mine.map((m) => [m.unit, m.name]));
        const units = new Map(out.units.map((u) => [u.unit, u]));
        const keys = configured.length > 0 ? configured : out.mine.map((m) => m.unit);
        const teams = keys.map((key) => ({ key, name: names.get(key) ?? key, expectedStates: expected, missingStates: units.get(key)?.missingStates ?? [] }));
        return { available: true, value: { viewer: out.viewer, teams } };
      } catch (error) {
        return { available: false, error: errorMessage(error) };
      }
    }

    /** Gather what the project's `.bb` already holds, so adoption can diff rather than start over. */
    async function gatherSurveyBb(source: ProjectSource, config: ProjectConfig | null, reposError: string | null): Promise<SurveyBb> {
      const names = new Set<string>(KNOWN_PLAYBOOKS);
      if (config !== null) for (const name of Object.values(config.file.playbooks)) if (typeof name === "string") names.add(name);
      const paths = [PROJECT_FILE, ROLES_FILE, "repos.json", ...[...names].map(playbookPath)];
      let files = new Map<string, string | null>();
      let error: string | null = null;
      try {
        files = await source.readFiles(paths);
      } catch (e) {
        error = errorMessage(e);
      }
      const rolesText = files.get(ROLES_FILE) ?? null;
      let projectSteward: string | null = null;
      if (rolesText !== null) {
        const parsed = parseRolesFile(rolesText);
        if (parsed.ok) projectSteward = Object.entries(parsed.value.roles).find(([, role]) => role.projectSteward === true)?.[0] ?? null;
      }
      return {
        projectFile: (files.get(PROJECT_FILE) ?? null) !== null,
        roles: rolesText !== null,
        projectSteward,
        playbooks: [...names].filter((name) => (files.get(playbookPath(name)) ?? null) !== null).sort(),
        reposJson: (files.get("repos.json") ?? null) !== null,
        error: error ?? reposError,
      };
    }

    /** Read the project and emit the survey the onboarding skill works from. */
    async function surveyProject(projectId: string): Promise<SurveyReport> {
      const config = await loadConfig(projectId, true);
      const source = config?.source ?? (await selectProjectSource(projectId)).source;
      const set = await source.repoSet();
      const listed = set.layout === "primary" && set.primary !== null ? [...set.repos, set.primary] : set.repos;
      const seen = new Set<string>();
      const entries = listed.filter((entry) => {
        const key = `${entry.dir}\0${entry.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const others = entries.map((entry) => ({ repo: githubRepoOf(entry.url), url: entry.url }));
      const repos: SurveyRepoInput[] = [];
      for (const entry of entries) repos.push(await gatherSurveyRepo(entry, githubRepoOf(entry.url), others.filter((o) => o.url !== entry.url)));
      const linear = await gatherSurveyLinear(config);
      const bb = await gatherSurveyBb(source, config, set.error);
      return buildSurvey({ projectId, source: source.kind, layout: set.layout, primary: set.primary, repos, linear, bb });
    }

    const stewardsCommands: Record<string, PluginCliCommand> = {
          survey: cliCommand({
            summary: "Emit the mechanical facts about a project's repos, Linear and .bb, for onboarding",
            description:
              "Reads each repo's default branch, branch protection, languages, manifests, CI test and typecheck commands, Dockerfiles, deploy manifests, labels and cross-repo references from GitHub; the Linear teams and workflow states from the linear source; and what .bb already holds. A read that fails is reported as unavailable, never fabricated. --json is stable and is what the onboarding skill works from.",
            options: { project: PROJECT_OPTION, json: JSON_OPTION },
            async run(input, ctx) {
              const report = await surveyProject(projectOf(input.options.project, ctx));
              return { exitCode: 0, stdout: input.options.json === true ? JSON.stringify(report, null, 2) : formatSurvey(report) };
            },
          }),

          init: cliCommand({
            summary: "Write stewards/project.json and the default playbooks into a .bb checkout",
            description:
              "Run from a thread in a project workspace: writes into <cwd>/.bb on the thread's machine unless --dir is given. Existing files are left alone unless --force. A git repo is read at origin/<default>'s committed tip, so commit inside .bb and publish it (workspace_publish_guidance on a multi-repo project; on a native project, commit and merge the guidance branch yourself). A plain project directory is read from <dir>/.bb on disk, so the files take effect on the next read and there is nothing to commit or publish.",
            options: {
              teams: { type: "string", description: "Linear team keys, comma-separated; the teams you belong to when left out" },
              dir: { type: "string", description: "The .bb directory to write into" },
              force: { type: "boolean", description: "Overwrite existing files" },
            },
            async run(input, ctx) {
              let teams = (input.options.teams ?? "").split(",").map((t) => t.trim().toUpperCase()).filter((t) => t !== "");
              if (teams.length === 0) {
                try {
                  const out = await rpc("linear", "sourceValidate", { units: [], label: "bb-managed", states: [] }, sourceContract.sourceValidate.output);
                  teams = out.mine.map((m) => m.unit);
                } catch (error) {
                  throw new PluginCliError(`Could not ask Linear for your teams: ${errorMessage(error)}`, { code: "linear_unavailable", hint: "Pass --teams ENG,OPS." });
                }
              }
              const dir = input.options.dir ?? (ctx.cwd === undefined ? undefined : `${ctx.cwd.replace(/\/$/u, "")}/.bb`);
              if (dir === undefined) throw new PluginCliError("No directory: run from a thread or pass --dir.", { code: "no_dir" });
              // Write on the thread's machine, else the project's: left to core, the
              // write lands on the server's own daemon, which bb-gate's servers lack.
              const threadHost = ctx.threadId === undefined ? null : ((await threadInfo(ctx.threadId))?.environmentHostId ?? null);
              const hostId = threadHost ?? (ctx.projectId === undefined ? null : await projectHost(ctx.projectId)) ?? undefined;
              // BB-234: a project with no Linear teams is GitHub-tracked, so
              // init writes the github-issues ticket playbook too. A project
              // with Linear teams keeps the Linear ticket playbook alone.
              const templates = Object.entries(PLAYBOOK_TEMPLATES).filter(([name]) => name !== DEFAULT_GITHUB_TICKET_PLAYBOOK || teams.length === 0);
              const files: Array<[string, string]> = [[PROJECT_FILE, projectFileTemplate(teams)], ...templates.map(([name, text]) => [playbookPath(name), text] as [string, string])];
              const lines: string[] = [];
              for (const [rel, content] of files) {
                const path = `${dir}/${rel}`;
                await bb.sdk.files.mkdir({ path: path.slice(0, path.lastIndexOf("/")), recursive: true, ...(hostId === undefined ? {} : { hostId }) } as never).catch(() => undefined);
                const result = (await bb.sdk.files.write({ path, content, ...(input.options.force ? {} : { expectedSha256: null }), ...(hostId === undefined ? {} : { hostId }) } as never)) as { outcome: string };
                lines.push(`${result.outcome === "written" ? "wrote" : "kept existing"} ${rel}`);
              }
              lines.push("", `Teams: ${teams.join(", ") || "(none; add them to linear.teams)"}`, "Next: review the files. In a git repo, commit inside .bb and publish with workspace_publish_guidance (multi-repo) or open the guidance pull request yourself (native), then merge the guidance branch. In a plain project directory, .bb is read from disk, so there is nothing to commit or publish. Then run bb stewards check.", "Stewards are off until switched on for a server: run bb stewards enable --project <id> there, or use the toggle on each project's row of the settings page.");
              return { exitCode: 0, stdout: lines.join("\n") };
            },
          }),

          brief: cliCommand({
            summary: "A steward's invariants: thread id, allowed actions, phase instructions, ready gate, guidance and holds, the standing rules, and the worker spawn command",
            description:
              "Run this on any turn that is not a wake, and after your context was compacted. It defaults to the binding of the invoking thread. The plugin also injects a bounded form of it as per-turn system context, so it survives compaction.",
            positionals: [{ name: "binding", description: "The entity key (ENG-12, owner/repo#3) or binding id; the invoking thread's binding when left out", required: false }],
            options: { project: PROJECT_OPTION },
            async run(input, ctx) {
              const own = input.positionals.binding === undefined || input.positionals.binding === "" ? (ctx.threadId === undefined ? null : store.projectByThread(ctx.threadId)) : null;
              if (own !== null && ctx.threadId !== undefined) return { exitCode: 0, stdout: `# Project steward brief\n\n${projectStewardInvariants(ctx.threadId)}` };
              const b = bindingFromCli(input.positionals.binding, input.options.project, ctx);
              const config = await loadConfig(b.projectId);
              const playbook = config === null ? null : bindingPlaybook(config, b);
              if (config === null || playbook === null) throw new PluginCliError(`No playbook for ${b.entityKey}: run bb stewards check.`, { code: "playbook_missing" });
              return {
                exitCode: 0,
                stdout: formatBrief({ binding: b, playbook, gate: briefGate(b, playbook), workerFlags: await workerFlagsFor(b, playbook, config.source), escalations: store.openEscalations(b.id), conflicts: conflictsOf(b, store.open(b.projectId)) }),
              };
            },
          }),

          "spawn-flags": cliCommand({
            summary: "The full runnable `bb thread spawn` command for a steward's workers or a worker's reviewer, from the playbook's model and the project environment",
            description: "Use these flags as they are: they are the playbook's, not the steward's to choose. Defaults to the binding of the invoking thread. `--role reviewer` is run from the worker thread that owns the pull request, so `--parent-self` makes the reviewer that worker's child; it needs `models.reviewer` in the playbook or a binding override.",
            positionals: [{ name: "binding", description: "The entity key (ENG-12, owner/repo#3) or binding id; the invoking thread's binding when left out", required: false }],
            options: { project: PROJECT_OPTION, role: { type: "string", description: "worker (the default) or reviewer" } },
            async run(input, ctx) {
              const role = input.options.role ?? "worker";
              if (role !== "worker" && role !== "reviewer") throw new PluginCliError(`Unknown role ${JSON.stringify(role)}: worker or reviewer.`, { code: "bad_role" });
              // A reviewer is spawned with `--parent-self` from the worker it
              // reviews for, so the command only makes sense from that worker's
              // thread; from a steward it would parent the reviewer to the
              // steward and the plugin would stop it as a mis-spawned worker.
              if (role === "reviewer" && ctx.threadId !== undefined && store.worker(ctx.threadId) === null) throw new PluginCliError("`--role reviewer` is run from the worker thread that owns the pull request, so the reviewer is that worker's child; run it there.", { code: "reviewer_not_from_worker" });
              const b = bindingFromCli(input.positionals.binding, input.options.project, ctx, { worker: true });
              const config = await loadConfig(b.projectId);
              const playbook = config === null ? null : bindingPlaybook(config, b);
              if (config === null || playbook === null) throw new PluginCliError(`No playbook for ${b.entityKey}: run bb stewards check.`, { code: "playbook_missing" });
              const spec = role === "reviewer" ? reviewerModel(b, playbook) : workerModel(b, playbook);
              if (role === "reviewer" && spec === null) throw new PluginCliError(`No reviewer model for ${b.entityKey}: add models.reviewer to ${playbook.name}, or set one with steward_update { binding, reviewerModel }.`, { code: "no_reviewer_model" });
              const flags = [environmentFlags(config.source, await projectHost(b.projectId)), workerFlags(spec)].filter((f) => f !== "").join(" ");
              return { exitCode: 0, stdout: spawnCommand({ projectId: b.projectId, entityKey: b.entityKey, workerFlags: flags, role }) };
            },
          }),

          gate: cliCommand({
            summary: "The lane gate's verdict for a pull request, from the plugin's own rules",
            description: "Reads the pull request fresh from GitHub and prints the lane, the latest bb-review marker and its sha, the decide-list entry matched and who decides, the approval found and its sha, the check status, the binding's open items and whether the gate is met. Exit 0 when met, 1 when not. --json emits the same fields.",
            positionals: [{ name: "ref", description: "The pull request, owner/repo#N", required: true }],
            options: { project: PROJECT_OPTION, json: JSON_OPTION },
            async run(input, ctx) {
              const ref = parsePullRef(input.positionals.ref);
              if (ref === null) throw new PluginCliError(`${JSON.stringify(input.positionals.ref)} is not a pull request (owner/repo#N).`, { code: "bad_ref" });
              const b = bindingForPullRef(ref, ctx, input.options.project === undefined ? undefined : projectOf(input.options.project, ctx));
              if (b === null) throw new PluginCliError(`No binding watches ${ref.repo}#${ref.number}; pass --project or run from the thread that owns it.`, { code: "binding_not_found" });
              const pull = await readPullRef(ref);
              if (pull === null) throw new PluginCliError(`Could not read ${ref.repo}#${ref.number} from GitHub.`, { code: "pull_unreadable" });
              const report = await gateReport(b, ref, pull);
              return { exitCode: report.gateMet ? 0 : 1, stdout: input.options.json === true ? JSON.stringify(report) : formatGateReport(report) };
            },
          }),

          merge: cliCommand({
            summary: "Merge a pull request whose lane gate is met, through the same path as the Stewards page",
            description: "Re-reads the pull request, re-checks the gate with the project's approvals, and refuses with the gate's reason when it is unmet or a worker's turn is in progress. Otherwise squash-merges, posts the \"Merged:\" comment, and closes the binding's Merge item. Exit 1 on a refusal.",
            positionals: [{ name: "ref", description: "The pull request, owner/repo#N", required: true }],
            options: { project: PROJECT_OPTION },
            async run(input, ctx) {
              const ref = parsePullRef(input.positionals.ref);
              if (ref === null) throw new PluginCliError(`${JSON.stringify(input.positionals.ref)} is not a pull request (owner/repo#N).`, { code: "bad_ref" });
              const b = bindingForPullRef(ref, ctx, input.options.project === undefined ? undefined : projectOf(input.options.project, ctx));
              if (b === null) throw new PluginCliError(`No binding watches ${ref.repo}#${ref.number}; pass --project or run from the thread that owns it.`, { code: "binding_not_found" });
              const pull = await readPullRef(ref);
              if (pull === null) throw new PluginCliError(`Could not read ${ref.repo}#${ref.number} from GitHub.`, { code: "pull_unreadable" });
              const result = await mergePullRequest(b, ref, pull, "with bb stewards merge", { exceptThreadId: ctx.threadId });
              if (!result.ok) return { exitCode: 1, stdout: result.message };
              // The same record the page leaves, so the binding's steward is woken.
              const fresh = store.binding(b.id);
              if (fresh !== null) {
                store.note(fresh.id, `${pull.key} was merged with bb stewards merge. ${result.summary}`);
                scheduleReconcile(fresh.id);
              }
              return { exitCode: 0, stdout: `${result.summary}\nmerge commit ${result.mergeSha ?? "?"}` };
            },
          }),

          check: cliCommand({
            summary: "Validate the project file and every playbook against Linear and GitHub, and that kubectl can read every ops target",
            description: "--create-labels first creates the project's label in every Linear team and every non-excluded GitHub repo, reporting each as created, existed or failed, then validates. Plain check only reads.",
            options: { project: PROJECT_OPTION, "create-labels": { type: "boolean", description: "Create the project's label in every unit first, then validate" } },
            async run(input, ctx) {
              const result = await check(projectOf(input.options.project, ctx), { createLabels: input.options["create-labels"] === true });
              return { exitCode: result.ok ? 0 : 1, stdout: [...result.lines, result.ok ? "OK" : "Problems found."].join("\n") };
            },
          }),

          enable: cliCommand({
            summary: "Switch this server's stewards on for a project, and sweep it now",
            description: "Local to this server, keyed by project id, and off by default. `.bb`'s stewards/project.json still has to exist. Turning on reopens the bindings the last switch-off ended and sweeps the project at once.",
            options: { project: PROJECT_OPTION },
            async run(input, ctx) {
              const result = await setProjectEnabledForUser(projectOf(input.options.project, ctx), true);
              return { exitCode: result.ok ? 0 : 1, stdout: result.message };
            },
          }),

          disable: cliCommand({
            summary: "Switch this server's stewards off for a project, ending its bindings",
            description: "Local to this server only. Each open binding gets one stop turn and its workers are stopped, the project steward is archived, and the leases are released; the records are kept, so switching back on resumes rather than starts over.",
            options: { project: PROJECT_OPTION },
            async run(input, ctx) {
              const result = await setProjectEnabledForUser(projectOf(input.options.project, ctx), false);
              return { exitCode: result.ok ? 0 : 1, stdout: result.message };
            },
          }),

          list: cliCommand({
            summary: "Bindings and their status records",
            options: { all: { type: "boolean", description: "Include ended bindings" }, project: PROJECT_OPTION, json: JSON_OPTION },
            async run(input, ctx) {
              const projectId = input.options.project ?? ctx.projectId;
              const rows = input.options.all ? store.all(projectId) : store.open(projectId);
              if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(rows.map(({ lastSnapshot: _s, ...rest }) => rest)) };
              // With a project, its own line; without one, name every configured
              // project this server has switched off, so a bare list still says.
              const config = projectId === undefined ? null : await loadConfig(projectId);
              const configs = projectId === undefined ? await configuredProjects() : config === null ? [] : [config];
              const offProjects =
                projectId === undefined
                  ? configs.filter((c) => !c.enabled).map((c) => c.projectId)
                  : config?.enabled === false
                    ? [projectId]
                    : [];
              const offLine = offProjects.length === 0 ? [] : [`Stewards are off on this server for ${offProjects.join(", ")}. Switch on with bb stewards enable --project <id>.`];
              // The role this server runs, so the bindings below are read under
              // their role name, not only the login (BB-163).
              const roleLine = config === null ? [] : [`roles: ${roleSummary(config)}`];
              // Each binding is attributed to the role whose definition owns its
              // target, so a holder of several roles reads which role each is.
              const roleMaps = new Map(configs.map((c) => [c.projectId, bindingRoles(c.roles, c.githubLogin === null ? null : lc(c.githubLogin), c.repos)]));
              const rolesFor = (b: Binding): string[] => rolesForBinding(roleMaps.get(b.projectId) ?? new Map(), b);
              const lessons = projectId === undefined ? [] : store.lessons(projectId).filter((l) => l.tier !== "retired");
              const lessonLines = lessons.length === 0 ? [] : ["", `Lessons pending (${lessons.length}):`, ...lessons.map((l) => `  ${l.id} — ${l.scope}, ${l.file}${l.bindingId === null ? "" : `, from ${store.binding(l.bindingId)?.entityKey ?? l.bindingId}`}: ${l.text}`)];
              return { exitCode: 0, stdout: [...offLine, ...roleLine, formatBindings(rows, rolesFor), ...lessonLines].join("\n") };
            },
          }),

          lessons: cliCommand({
            summary: "Lessons the project steward recorded, their state, and the efficacy view",
            options: {
              all: { type: "boolean", description: "Include promoted and retired lessons" },
              efficacy: { type: "boolean", description: "The project line: escalations reaching the user per week, and hand-written guidance units uncited for 90 days" },
              project: PROJECT_OPTION,
              json: JSON_OPTION,
            },
            async run(input, ctx) {
              const projectId = projectOf(input.options.project, ctx);
              if (input.options.efficacy) {
                // BB-35 step 6: the project line that matters. Escalations that
                // reached the user, bucketed by week, and the hand-written
                // guidance nothing has cited in 90 days. Read-only: it names a
                // suggestion, it never removes a unit.
                const units = await guidanceUnits(projectId);
                const uncited = uncitedGuidanceUnits(units, store.guidanceCitations(projectId), now());
                // One count per user-facing item: a forwarded escalation is
                // represented by the question the user saw, not both. The
                // question's creation is when it reached them.
                const all = store.escalationsForProject(projectId);
                const covered = new Set(all.map((x) => x.forwardedFrom).filter((id): id is string => id !== null));
                const reaching = all.filter((x) => x.route === "user" && (x.isQuestion || !covered.has(x.id)));
                const weeks = escalationWeeks(reaching.map((x) => x.createdAt), now());
                if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ weeks, uncited: uncited.map((u) => ({ id: u.unit.id, file: u.unit.file, heading: u.unit.heading, text: u.unit.text, lastCitedAt: u.lastCitedAt })) }) };
                const lines = ["Escalations reaching the user, per week (oldest first):", ...weeks.map((w) => `  ${iso(w.start).slice(0, 10)}  ${w.count}`)];
                lines.push("", `Hand-written guidance units uncited for ${GUIDANCE_UNCITED_DAYS} days (consider removing):`);
                if (uncited.length === 0) lines.push("  none");
                for (const u of uncited) {
                  const snippet = u.unit.text.replace(/\s+/gu, " ").slice(0, 120);
                  lines.push(`  ${u.unit.id}  ${u.unit.file}${u.unit.heading === null ? "" : ` §${u.unit.heading}`}  ${u.lastCitedAt === null ? "(never cited)" : `(last cited ${iso(u.lastCitedAt).slice(0, 10)})`}\n    ${snippet}`);
                }
                return { exitCode: 0, stdout: lines.join("\n") };
              }
              const rows = store.lessons(projectId, input.options.all ?? false);
              if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(rows) };
              if (rows.length === 0) return { exitCode: 0, stdout: "No pending lessons." };
              return {
                exitCode: 0,
                stdout: rows
                  .map((l) => {
                    const b = l.bindingId === null ? null : store.binding(l.bindingId);
                    const source = [b === null ? null : `from ${b.entityKey}`, l.escalationId].filter((x) => x !== null).join(", ");
                    const landed = l.status === "merged" ? `${l.mergeSha === null ? "merged" : `merged at ${l.mergeSha.slice(0, 8)}`}${l.branch === null ? "" : ` on ${l.branch}`}` : l.status;
                    // The counters the lifecycle runs on (BB-35 step 6): hits
                    // (distinct bindings), corrections, when it was last cited,
                    // and when it entered its current tier.
                    const counts = `${l.hits} binding${l.hits === 1 ? "" : "s"}, ${l.corrections} correction${l.corrections === 1 ? "" : "s"}, last cited ${l.lastCitedAt === null ? "never" : iso(l.lastCitedAt).slice(0, 10)}${l.tierAt === null ? "" : `, ${l.tier} since ${iso(l.tierAt).slice(0, 10)}`}`;
                    return `${l.id} — ${l.tier} (${landed}), ${l.scope}, ${l.file}${source === "" ? "" : ` (${source})`}\n  ${counts}${l.note === null ? "" : ` — ${l.note}`}\n  ${l.text}`;
                  })
                  .join("\n"),
              };
            },
          }),

          "drop-lesson": cliCommand({
            summary: "Drop a pending lesson the project steward recorded",
            positionals: [{ name: "id", description: "The lesson id (lsn_…)", required: true }],
            options: { project: PROJECT_OPTION },
            async run(input, ctx) {
              const projectId = projectOf(input.options.project, ctx);
              const lesson = store.lesson(input.positionals.id);
              if (lesson === null || lesson.projectId !== projectId) throw new PluginCliError(`No lesson ${input.positionals.id} in this project.`, { code: "lesson_not_found", hint: "bb stewards lessons lists them." });
              if (lesson.status !== "pending") return { exitCode: 0, stdout: `Lesson ${lesson.id} is already ${lesson.status}.` };
              store.markLessonDropped(lesson.id, "Dropped with bb stewards drop-lesson.");
              if (lesson.bindingId !== null) store.closeNeedByKey(lesson.bindingId, "decide", lesson.id, "Dropped with bb stewards drop-lesson.");
              return { exitCode: 0, stdout: `Dropped ${lesson.id}.` };
            },
          }),

          show: cliCommand({
            summary: "One binding in full: status, ready gate, guidance, escalations, workers, action log",
            positionals: [{ name: "key", description: "The entity key (ENG-12, owner/repo#3) or binding id", required: true }],
            options: { project: PROJECT_OPTION, json: JSON_OPTION },
            async run(input, ctx) {
              const b = bindingOrThrow(input.positionals.key, input.options.project ?? ctx.projectId);
              const config = await loadConfig(b.projectId);
              const detail = { binding: b, escalations: store.escalations(b.id), needs: store.needs(b.id, true), workers: store.workers(b.id), children: store.children(b.id).map((c) => c.entityKey), fingerprints: store.fingerprints(b.id), assumptions: store.assumptions(b.id) };
              if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ ...detail, projectSource: config?.source.kind ?? null }) };
              const roleMap = bindingRoles(config?.roles ?? null, config?.githubLogin === null || config?.githubLogin === undefined ? null : lc(config.githubLogin), config?.repos ?? []);
              const lines = [formatBindings([b], (x) => rolesForBinding(roleMap, x)), "", `Project source: ${projectSourceLabel(config?.source.kind ?? null)}`, `Playbook ${b.playbook}@${b.playbookVersion}; stage ${b.stage ?? "?"}; created ${iso(b.createdAt)}${b.requeueAt === null ? "" : `; requeue ${iso(b.requeueAt)}`}`];
              if (b.kind !== "ops") lines.push(`Ready: ${b.ready.checklist.map((c) => `[${c.met ? "x" : " "}] ${c.item}`).join("; ") || "not reported"}; substantial ${b.ready.substantial ?? "?"}; approval ${b.ready.approval === null ? "none" : iso(b.ready.approval.at)}`);
              if (b.kind !== "ops") {
                const conflicts = conflictsOf(b, store.open(b.projectId));
                lines.push(`Touches: ${b.touches.join(", ") || "not reported"}${conflicts.length === 0 ? "" : `; file-level overlap: ${conflicts.map((c) => `${c.with.entityKey} on ${c.on.join(", ")}`).join("; ")}`}`);
              }
              for (const line of deploymentLines(b.deployments)) lines.push(`Deployment ${line}`);
              for (const g of b.guidance) lines.push(`Guidance ${iso(g.at)}: ${g.text}`);
              for (const n of b.pending) lines.push(`Pending${n.quiet === true ? " (quiet)" : ""}: ${n.text}`);
              for (const x of detail.escalations) lines.push(`Escalation ${x.id} ${x.kind} (${x.status}, ${x.route}): ${x.question}${choicesNote(x.choices)}${x.resolution === null ? "" : ` → ${x.resolution}`}`);
              for (const a of detail.assumptions) lines.push(`Assumption ${a.id} (${a.state}): Assuming: ${a.text}${a.context === null ? "" : ` — ${a.context}`} (recorded ${iso(a.recordedAt)} by ${a.recordedBy})${a.answer === null ? "" : ` → ${a.answer}`}`);
              for (const n of store.needs(b.id, true)) lines.push(`Need ${n.id} ${n.kind} (${n.status}): ${n.what}${choicesNote(needChoices(n))}${n.url === "" ? "" : ` — ${n.url}`}${n.resolution === null ? "" : ` → ${n.resolution}`}`);
              for (const w of detail.workers) lines.push(`Worker ${w.threadId} ${w.title}: ${w.status}`);
              for (const f of store.fingerprints(b.id)) lines.push(`Fingerprint ${f.fingerprint} → ${f.ticketKey ?? "no ticket"}; seen ${f.seenCount} time(s), last ${iso(f.lastSeenAt)}${f.filedByThread === null || f.filedByThread === undefined ? "" : `, filed by ${f.filedByThread}`}${f.lastCommentedAt === null ? "" : `; last word ${iso(f.lastCommentedAt)}`}`);
              if (b.kind === "ops") {
                for (const d of store.depsDecisions(b.projectId, b.entityId)) lines.push(`Decision ${d.ticketKey} (${d.status}, raised ${iso(d.raisedAt)}${d.raisedBy === null ? "" : ` by ${d.raisedBy}`}${d.needId === null ? "" : `, item ${d.needId}`}${d.snoozedUntil === null ? "" : `, snoozed until ${iso(d.snoozedUntil)}`}${d.reminded.length === 0 ? "" : `, reminded ${d.reminded.join(", ")}`}): ${d.fingerprints.join(", ")}${d.resolution === null ? "" : ` → ${d.resolution}`}`);
              }
              return { exitCode: 0, stdout: lines.join("\n") };
            },
          }),

          needs: cliCommand({
            summary: "Things waiting on the user: open questions, escalations with the user, then needs",
            description: "The same items as the Stewards page's \"Waiting on you\" section and the sidebar, in the same order: open questions, route-`user` escalations no question or need covers, then needs. Each line ends with the `bb stewards done` command that answers it. `--all` keeps its old job: every need, open or closed, as a diagnostic.",
            options: { all: { type: "boolean", description: "Include closed items" }, project: PROJECT_OPTION, json: JSON_OPTION },
            async run(input, ctx) {
              const projectId = projectOf(input.options.project, ctx);
              // `--all` stays the closed-needs diagnostic it was on main.
              if (input.options.all) {
                const rows = store.allNeedsForProject(projectId);
                if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(rows) };
                if (rows.length === 0) return { exitCode: 0, stdout: "Nothing is waiting on the user." };
                return {
                  exitCode: 0,
                  stdout: rows
                    .map((n) => {
                      const b = store.binding(n.bindingId);
                      const head = `${n.id} — ${n.kind}, ${b?.entityKey ?? n.bindingId}: ${n.what}${choicesNote(needChoices(n))}${n.url === "" ? "" : ` (${n.url})`}`;
                      // A closed row is a record of what happened, not an open
                      // item: show its resolution rather than needView's reason
                      // it cannot be acted on now (BB-283).
                      if (n.status === "done") return `${head}${n.resolution === null ? "" : ` → ${n.resolution}`}`;
                      const view = b === null ? null : needView(n, b);
                      return `${head}${view !== null && !view.actionable ? ` [not actionable: ${view.why}]` : ""}`;
                    })
                    .join("\n"),
                };
              }
              // One builder for the three surfaces, so the CLI, the page and the
              // sidebar cannot drift (BB-69).
              const { questions, withUser, needs } = needsYou(projectId);
              // The JSON extends the old needs array with the questions and
              // with-user escalations alongside it.
              if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ questions, withUser, needs: store.openNeedsForProject(projectId) }) };
              if (questions.length + withUser.length + needs.length === 0) return { exitCode: 0, stdout: "Nothing is waiting on the user." };
              const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();
              const done = (id: string, choices: readonly string[]) => `bb stewards done ${id}${choices.length === 0 ? "" : ` --choice "<label>"`}`;
              const lines = [
                ...questions.map((q) => `${q.id} — question, ${q.key ?? "project"}: ${oneLine(q.question)}${choicesNote(q.choices)} — ${done(q.id, q.choices)}`),
                ...withUser.map((x) => `${x.id} — ${x.kind} escalation, ${x.key}: ${oneLine(x.question)} — ${done(x.id, [])}`),
                ...needs.map((n) => `${n.id} — ${n.kind}, ${n.key}: ${oneLine(n.what)}${choicesNote(n.choices)}${n.url === null ? "" : ` (${n.url})`}${n.actionable ? "" : ` [not actionable: ${n.why ?? "unknown"}]`} — ${done(n.id, n.choices)}`),
              ];
              return { exitCode: 0, stdout: lines.join("\n") };
            },
          }),

          escalate: cliCommand({
            summary: "Raise an escalation from a worker thread to its steward",
            description: "Files one escalation on the worker's binding with the plugin's next hop and schedules the steward's reconcile. The question is the one line the sidebar row shows; the evidence and reasoning go in --context. The steward's wake lists it ahead of other changes.",
            positionals: [{ name: "text", description: "The one-line question, as the sidebar row shows it (at most 240 characters)", required: true }],
            options: { project: PROJECT_OPTION, context: { type: "string", description: "The evidence and reasoning behind the question (at most 3000 characters)" }, meanwhile: { type: "string", description: "wait (the default) or continue" } },
            async run(input, ctx) {
              const threadId = ctx.threadId;
              if (threadId === undefined) throw new PluginCliError("No thread: run this from a worker thread.", { code: "no_thread" });
              const worker = store.worker(threadId);
              if (worker === null) throw new PluginCliError("This thread is not a worker of a binding; a steward escalates with steward_report { escalate }.", { code: "not_a_worker" });
              const b = store.binding(worker.bindingId);
              if (b === null) throw new PluginCliError("The worker's binding is gone.", { code: "binding_missing" });
              const question = input.positionals.text.trim();
              if (question.length > 240) throw new PluginCliError("The question is the one line the sidebar row shows; keep it to 240 characters and put the evidence and reasoning in --context.", { code: "question_too_long" });
              const context = input.options.context === undefined || input.options.context.trim() === "" ? null : input.options.context.trim();
              if (context !== null && context.length > 3000) throw new PluginCliError("context is at most 3000 characters.", { code: "context_too_long" });
              const meanwhile = input.options.meanwhile === "continue" ? "continue" : "wait";
              const x = store.escalate({
                bindingId: b.id,
                kind: "decision",
                question,
                context,
                meanwhile,
                route: "steward",
                recommendation: null,
                projectId: b.projectId,
                origin: { threadId, bindingId: b.id, chain: [] },
              });
              await deliver(b, x);
              scheduleReconcile(b.id);
              return { exitCode: 0, stdout: `Escalation ${x.id} is with your steward.` };
            },
          }),

          done: cliCommand({
            summary: "Close a waiting item from a thread, record a choice, approve a spec item, or confirm or correct an assumption",
            description: "Closes a `needs` item (need_…) or a question to the user (qst_…), and wakes the steward with it under What changed. With --choice it records the label the user gave in chat, saved as guidance; a forwarded escalation resolves with it. On an `approve-spec` item it records the approval on the gate, resolves the escalation that asked for it, and wakes the steward and the project steward; decline a spec on the Stewards page instead. An assumption (asm_…) is confirmed with --choice confirm or corrected with --choice correct --answer \"<what is true>\"; a correction wakes the steward with the answer.",
            positionals: [{ name: "id", description: "The item id (need_…), question id (qst_…) or assumption id (asm_…)", required: true }],
            options: {
              project: PROJECT_OPTION,
              choice: { type: "string", description: "A label the user picked, which must be one of the item's choices; confirm or correct for an assumption" },
              note: { type: "string", description: "An optional note to save with the choice" },
              answer: { type: "string", description: "With an assumption and --choice correct: what is actually true, which is saved as the correction" },
            },
            async run(input, ctx) {
              const id = input.positionals.id;
              const choice = input.options.choice;
              const note = input.options.note === undefined || input.options.note.trim() === "" ? null : input.options.note.trim();
              const answer = input.options.answer === undefined || input.options.answer.trim() === "" ? null : input.options.answer.trim();
              // BB-251: an assumption is confirmed or corrected here. A
              // correction wakes the steward with the answer.
              const assumption = store.assumption(id);
              if (assumption !== null) {
                if (assumption.state !== "open") return { exitCode: 0, stdout: `Assumption ${id} is already ${assumption.state}.` };
                if (choice !== "confirm" && choice !== "correct") throw new PluginCliError(`Assumption ${id} is confirm or correct; pass --choice confirm or --choice correct.`, { code: "choice_required" });
                if (choice === "correct" && answer === null) throw new PluginCliError(`Correcting assumption ${id} needs the answer it was wrong about: --answer "<what is true>".`, { code: "answer_required" });
                store.resolveAssumption(id, choice === "confirm" ? "confirmed" : "corrected", answer, "user");
                const ab = assumption.bindingId === null ? null : store.binding(assumption.bindingId);
                const where = ab === null ? "the project" : ab.entityKey;
                if (ab !== null) {
                  store.note(ab.id, choice === "confirm" ? `Assumption ${id} was confirmed by the user from a thread.` : `Assumption ${id} was corrected by the user from a thread: ${answer}`);
                  scheduleReconcile(ab.id);
                }
                if (choice === "correct" && answer !== null) await offerAssumptionLesson(assumption.projectId, assumption, answer);
                return { exitCode: 0, stdout: `${choice === "confirm" ? "Confirmed" : "Corrected"} assumption ${id} on ${where}${choice === "correct" ? "; its steward has been told" : ""}.` };
              }
              // A question is the `decide` kind's mechanism; close it the same way.
              const q = store.question(id);
              if (q !== null) {
                if (q.status !== "open") return { exitCode: 0, stdout: `${id} is already closed.` };
                const x = q.escalationId === null ? null : store.escalation(q.escalationId);
                if (choice !== undefined) {
                  if (q.choices.length === 0) throw new PluginCliError(`Question ${id} has no choices; close it without --choice.`, { code: "no_choices" });
                  if (!q.choices.includes(choice)) throw new PluginCliError(`"${choice}" is not one of ${id}'s choices: ${q.choices.join(", ")}.`, { code: "bad_choice", hint: `bb stewards needs prints them.` });
                  const guidance = note === null ? choice : `${choice} — ${note}`;
                  store.answer(q.id, `Chose: ${choice}${note === null ? "" : ` — ${note}`}`, "user", guidance);
                  // The box was shown (there is no rationale input from the CLI):
                  // mark it asked so a later repeat is not a second box at once.
                  if (q.rationaleWanted !== null) store.markEscalationRationaleAsked(q.id);
                  if (x !== null) {
                    const b = store.binding(x.bindingId);
                    if (b !== null) {
                      const closure = `The user chose ${choice} for ${b.entityKey}'s forwarded escalation from a thread${note === null ? "" : `: ${note}`}.`;
                      store.addGuidance(b.id, guidance, "user");
                      countCorrections(x, guidance);
                      store.note(b.id, `The user chose ${choice} for ${q.question}${note === null ? "" : `: ${note}`}.`);
                      scheduleReconcile(b.id);
                      await wakeProjectOnForwardedAnswer(b, closure, [x]);
                    }
                  }
                  return { exitCode: 0, stdout: `Chose ${choice} for ${id}.` };
                }
                const answer = note ?? "Closed from a thread.";
                store.answer(q.id, answer, "user");
                if (q.rationaleWanted !== null) store.markEscalationRationaleAsked(q.id);
                if (x !== null) {
                  const b = store.binding(x.bindingId);
                  if (b !== null) {
                    const closure = note === null
                      ? `The user closed ${b.entityKey}'s forwarded escalation from a thread without an answer.`
                      : `The user answered ${b.entityKey}'s forwarded escalation from a thread: ${JSON.stringify(note)}.`;
                    if (note !== null) store.addGuidance(b.id, note, "user");
                    if (note !== null) countCorrections(x, note);
                    store.note(b.id, note === null ? `Question ${q.id} was closed from a thread.` : `Question ${q.id} was answered from a thread: ${note}`);
                    scheduleReconcile(b.id);
                    await wakeProjectOnForwardedAnswer(b, closure, [x], note !== null);
                  }
                }
                return { exitCode: 0, stdout: `Closed ${id}.` };
              }
              const n = store.need(id);
              if (n === null) throw new PluginCliError(`No waiting item ${id}.`, { code: "need_not_found", hint: "bb stewards needs lists them." });
              if (n.status !== "open") return { exitCode: 0, stdout: `${id} is already closed.` };
              // A lesson's validation item is not a free-text choice: a
              // boundary Merge runs the multi-repo fast-forward and Drop
              // discards it; a mixed-evidence Keep records the user's
              // confirmation and Retire removes it. Each closes the item and
              // wakes the steward.
              if (n.kind === "decide" && typeof n.data.lessonId === "string") {
                const lesson = store.lesson(n.data.lessonId);
                const isRetire = lesson !== null && lesson.retirePr !== null && lesson.status === "merged";
                if (lesson === null || lesson.status === "dropped" || (lesson.tier === "retired" && !isRetire)) return { exitCode: 0, stdout: "That lesson is already resolved." };
                const label = choice ?? null;
                if (n.data.validation === "mixed-evidence") {
                  if (label !== "Keep" && label !== "Retire") throw new PluginCliError(`Lesson ${lesson.id} is Keep or Retire; pass --choice Keep or --choice Retire.`, { code: "choice_required" });
                  const b = store.binding(n.bindingId);
                  if (label === "Keep") {
                    store.markLessonValidated(lesson.id);
                    store.closeNeedByKey(n.bindingId, "decide", n.url, "Kept from a thread.");
                    if (b !== null) {
                      store.note(b.id, `The user kept lesson ${lesson.id} from a thread.`);
                      scheduleReconcile(b.id);
                    }
                    return { exitCode: 0, stdout: `Kept ${lesson.id}.` };
                  }
                  const removed = await retireLesson(lesson);
                  if (removed.startsWith("retire refused")) retireLessonByRule(store.lesson(lesson.id) ?? lesson, "retired by the user");
                  store.closeNeedByKey(n.bindingId, "decide", n.url, "Retired from a thread.");
                  if (b !== null) {
                    store.note(b.id, `The user retired lesson ${lesson.id} from a thread: ${removed}.`);
                    scheduleReconcile(b.id);
                  }
                  return { exitCode: 0, stdout: `Retired ${lesson.id}.` };
                }
                if (!isRetire && lesson.status !== "pending") return { exitCode: 0, stdout: "That lesson is already resolved." };
                if (label !== "Review PR" && label !== "Drop") throw new PluginCliError(`Lesson ${lesson.id} is Review PR or Drop; pass --choice Review PR or --choice Drop.`, { code: "choice_required" });
                const b = store.binding(n.bindingId);
                if (label === "Drop") {
                  await closeLessonPr(lesson, isRetire ? lesson.retirePr : lesson.pr);
                  store.markLessonDropped(lesson.id, isRetire ? "Retire dropped from a thread." : "Dropped from a thread.");
                  store.closeNeedByKey(n.bindingId, "decide", n.url, "Dropped from a thread.");
                  if (b !== null) {
                    store.note(b.id, `The user dropped lesson ${lesson.id} from a thread.`);
                    scheduleReconcile(b.id);
                  }
                  return { exitCode: 0, stdout: `Dropped ${lesson.id}.` };
                }
                const prUrl = typeof n.data.prUrl === "string" ? n.data.prUrl : (lesson.retirePr ?? lesson.pr);
                return { exitCode: 0, stdout: prUrl === null ? `The pull request for ${lesson.id} is not open yet.` : `Review ${prUrl}` };
              }
              if (choice !== undefined) {
                if (n.kind !== "decide") throw new PluginCliError(`Choices are for a decide item; ${id} is ${n.kind}.`, { code: "not_decide" });
                const choices = needChoices(n);
                if (choices.length === 0) throw new PluginCliError(`Item ${id} has no choices; close it without --choice.`, { code: "no_choices" });
                if (!choices.includes(choice)) throw new PluginCliError(`"${choice}" is not one of ${id}'s choices: ${choices.join(", ")}.`, { code: "bad_choice", hint: `bb stewards needs prints them.` });
                const guidance = note === null ? choice : `${choice} — ${note}`;
                const forwarded = forwardedFor(n);
                store.closeNeed(n.id, `Chose: ${choice}${note === null ? "" : ` — ${note}`}`, "user");
                const b = store.binding(n.bindingId);
                if (b !== null) {
                  store.addGuidance(b.id, guidance, "user");
                  store.note(b.id, `The user chose ${choice} for ${n.what}${note === null ? "" : `: ${note}`}.`);
                  const escalationId = typeof n.data.escalationId === "string" ? n.data.escalationId : null;
                  if (escalationId !== null) {
                    const escalation = store.escalation(escalationId);
                    if (escalation !== null && escalation.status === "open") store.answerEscalation(escalationId, guidance, "user");
                  }
                  scheduleReconcile(b.id);
                  await wakeProjectOnForwardedAnswer(b, `The user chose ${choice} for ${n.what}${note === null ? "" : `: ${note}`}.`, forwarded);
                }
                return { exitCode: 0, stdout: `Chose ${choice} for ${id}.` };
              }
              const b = store.binding(n.bindingId);
              const forwarded = forwardedFor(n);
              // An `approve-spec` item is a decision, not a step to tick off:
              // `done` records the approval through the same path the page's
              // Approve button and `steward_update { approve }` use, so the
              // gate, the need and the forwarded escalation move together.
              // Decline it on the Stewards page.
              if (b !== null && n.kind === "approve-spec") {
                // Fresh like the page, so both surfaces pin the same spec.
                const entity = (b.source === "ops" ? null : await snapshot(b.source, b.entityId).catch(() => null)) ?? b.lastSnapshot?.entity ?? null;
                if (entity === null) throw new PluginCliError(`Cannot read ${b.entityKey}'s spec to approve it.`, { code: "need_not_readable", hint: "Look at it again with bb stewards pass, then retry." });
                const { closure, forwarded } = recordSpecVerdict(b, "approve", entity, null, "from a thread");
                store.note(b.id, closure);
                scheduleReconcile(b.id);
                await wakeProjectOnForwardedAnswer(b, closure, forwarded);
                return { exitCode: 0, stdout: `Approved ${id}; ${b.entityKey}'s steward has been told.` };
              }
              store.closeNeed(n.id, note === null ? "Closed from a thread." : `Answered from a thread: ${note}`, "user");
              if (b !== null) {
                if (note !== null) store.addGuidance(b.id, note, "user");
                store.note(b.id, note === null ? `${n.kind} item ${n.id} was closed from a thread.` : `${n.kind} item ${n.id} was answered from a thread: ${note}.`);
                scheduleReconcile(b.id);
                await wakeProjectOnForwardedAnswer(b, note === null ? `${n.kind} item ${n.id} was closed from a thread.` : `${n.kind} item ${n.id} was answered from a thread: ${note}.`, forwarded);
              }
              return { exitCode: 0, stdout: `Closed ${id}.` };
            },
          }),

          detach: cliCommand({
            summary: "Stop stewarding an entity: its steward gets one stop turn",
            description: "It stays detached until its label is removed and added again.",
            positionals: [{ name: "key", description: "The entity key or binding id", required: true }],
            options: { project: PROJECT_OPTION },
            async run(input, ctx) {
              const b = bindingOrThrow(input.positionals.key, input.options.project ?? ctx.projectId);
              if (b.endedAt !== null) return { exitCode: 0, stdout: `${b.entityKey} has already ended (${b.endReason}).` };
              store.patch(b.id, { manualDetach: true });
              const config = await loadConfig(b.projectId);
              const playbook = config === null ? null : bindingPlaybook(config, b);
              await serial(`b:${b.id}`, async () => {
                const fresh = store.binding(b.id)!;
                if (config === null || playbook === null || fresh.lastSnapshot === null) await finishEnding(fresh, "detach");
                else await beginEnding(fresh, config, playbook, "detach", fresh.lastSnapshot);
              });
              return { exitCode: 0, stdout: `Detaching ${b.entityKey}.` };
            },
          }),

          rebind: cliCommand({
            summary: "Point a binding at another steward thread, for operator recovery",
            description:
              "Re-points a live binding at another thread (for example a fork of its dead thread, kept with `bb thread fork <old> --environment <env>`), sends the binding's wake to it at once, and archives the previous thread. It never deletes a thread, so the binding is not marked manually detached. It refuses a thread in another project, a deleted thread, or one that is already another binding's steward or a worker.",
            positionals: [
              { name: "key", description: "The entity key or binding id", required: true },
              { name: "thread", description: "The thread that should steward the binding", required: true },
            ],
            options: { project: PROJECT_OPTION },
            async run(input, ctx) {
              const b = bindingOrThrow(input.positionals.key, input.options.project ?? ctx.projectId);
              if (b.endedAt !== null) throw new PluginCliError(`${b.entityKey} has ended (${b.endReason}); rebind is for a live binding.`, { code: "binding_ended", hint: "bb stewards list --all shows ended bindings." });
              const threadId = input.positionals.thread.trim();
              if (threadId === "") throw new PluginCliError("No thread: pass the thread id to rebind to.", { code: "no_thread" });
              const info = await threadInfo(threadId).catch(() => null);
              if (info === null || info.deletedAt !== null) throw new PluginCliError(`Thread ${threadId} does not exist.`, { code: "thread_not_found", hint: "bb thread list shows the threads." });
              if (info.projectId !== null && info.projectId !== b.projectId) throw new PluginCliError(`Thread ${threadId} is in project ${info.projectId}, not ${b.projectId}.`, { code: "thread_other_project" });
              // An ended binding's old thread is nobody's steward any more, so it
              // may be re-used; a live binding's thread may not.
              const other = store.byThread(threadId);
              if (other !== null && other.id !== b.id && other.endedAt === null) throw new PluginCliError(`Thread ${threadId} is already ${other.entityKey}'s steward.`, { code: "thread_taken", hint: `bb stewards show ${other.entityKey} shows it.` });
              const worker = store.worker(threadId);
              if (worker !== null) throw new PluginCliError(`Thread ${threadId} is a worker of ${store.binding(worker.bindingId)?.entityKey ?? worker.bindingId}.`, { code: "thread_worker" });
              const projectSteward = store.projectByThread(threadId);
              if (projectSteward !== null) throw new PluginCliError(`Thread ${threadId} is the project steward of ${projectSteward.projectId}, not a binding's steward.`, { code: "thread_project_steward" });
              const result = { outcome: "sent" as "sent" | "queued" | "missing" | "gone" };
              // The whole mutation runs under the binding's lock, the same one
              // every reconcile takes, so a doorbell-driven respawn cannot
              // re-point the binding between the rebind and its wake.
              await serial(`b:${b.id}`, async () => {
                const fresh = store.binding(b.id);
                if (fresh === null || fresh.endedAt !== null) {
                  result.outcome = "gone";
                  return;
                }
                const previous = fresh.threadId;
                // Clear the wait before the wake: the new thread has not had the
                // wake yet, and the old thread's report is not coming.
                store.patch(b.id, { threadId, awaitingReport: false });
                if (previous !== null && previous !== threadId) await quietly(`archive the previous steward thread ${previous}`, () => bb.sdk.threads.archive({ threadId: previous }));
                // The action log: the wake carries it, so the new thread's first
                // report knows where it came from.
                store.note(b.id, `Rebound from ${previous ?? "(none)"} to ${threadId} with bb stewards rebind.`);
                bb.log.info(`stewards: rebound ${b.entityKey} from ${previous ?? "(none)"} to ${threadId}`);
                const config = await loadConfig(b.projectId);
                const playbook = config === null ? null : bindingPlaybook(config, fresh);
                if (config === null || playbook === null) {
                  result.outcome = "missing";
                  return;
                }
                // Send the binding's wake now, not at the next requeue.
                await reconcileBinding(b.id, "requeue");
                result.outcome = store.binding(b.id)?.awaitingReport === true ? "sent" : "queued";
              });
              if (result.outcome === "gone") return { exitCode: 0, stdout: `${b.entityKey} ended while rebinding; nothing was changed.` };
              if (result.outcome === "missing") return { exitCode: 0, stdout: `Rebound ${b.entityKey} to ${threadId}, but its playbook is missing so no wake was sent.` };
              return { exitCode: 0, stdout: `Rebound ${b.entityKey} to ${threadId}; ${result.outcome === "sent" ? "its wake was sent." : "its wake is queued for its next turn."}` };
            },
          }),

          pass: cliCommand({
            summary: "Run a pass now: the mechanical sweep, or with --nightly the full nightly pass",
            options: { project: PROJECT_OPTION, nightly: { type: "boolean", description: "Give every binding a judgment turn and wake the project steward for a digest" } },
            async run(input, ctx) {
              const projectId = projectOf(input.options.project, ctx);
              const config = await loadConfig(projectId, true);
              if (config === null) throw new PluginCliError(`Project ${projectId} has no ${PROJECT_FILE}.`, { code: "not_configured" });
              if (input.options.nightly) {
                void nightlyPass(config, `manual-${iso(now())}`, true).catch((e: unknown) => bb.log.warn(`stewards: manual pass: ${errorMessage(e)}`));
                return { exitCode: 0, stdout: "Started the nightly pass; follow it with bb stewards list." };
              }
              await sweep();
              return { exitCode: 0, stdout: `Swept. ${store.open(projectId).length} open binding(s).` };
            },
          }),

          digest: cliCommand({
            summary: "The project steward's latest morning digest",
            options: { project: PROJECT_OPTION },
            async run(input, ctx) {
              const row = store.project(projectOf(input.options.project, ctx));
              return { exitCode: 0, stdout: row.digest === null ? "No digest yet." : `${iso(row.digestAt ?? 0)}\n\n${row.digest}` };
            },
          }),

          // Case B of a provide-secret need: a stewards secret setting cannot
          // be reached by `bb secret request` (which writes a dotenv on the
          // worker's machine), so the requester thread the plugin spawned
          // reads that dotenv here and writes the setting. Only that thread,
          // only while its need is open, and only for the need's own setting.
          "secret import": cliCommand({
            summary: "Write a secret from a dotenv into a declared secret setting (requester threads only)",
            description:
              "Only the requester thread the plugin spawned for an open provide-secret need may run this, and only for that need's own setting. The dotenv is read through bb.sdk.files on the invoking thread's host, the value is written with the plugin's settings, and the file is deleted. The value never appears in argv, logs, messages or output.",
            options: {
              from: { type: "string", required: true, description: "The dotenv file to read, on the invoking thread's host." },
              setting: { type: "string", required: true, description: "The declared secret setting to write." },
            },
            async run(input, ctx) {
              const from = input.options.from;
              const setting = input.options.setting;
              if (ctx.threadId === undefined) throw new PluginCliError("bb stewards secret import must run from a bb thread.", { code: "missing_thread" });
              const requester = store.secretRequester(ctx.threadId);
              if (requester === null) throw new PluginCliError("This thread is not a provide-secret requester thread.", { code: "not_requester", hint: "Press Provide on the Stewards page to open one." });
              const need = store.need(requester.needId);
              if (need === null || need.kind !== "provide-secret" || need.status !== "open") throw new PluginCliError("That provide-secret item is closed.", { code: "need_closed" });
              const expected = typeof need.data.setting === "string" && need.data.setting.trim() !== "" ? need.data.setting.trim() : null;
              if (expected !== setting) throw new PluginCliError(`This item's secret goes to ${JSON.stringify(expected ?? "no setting")}, not ${JSON.stringify(setting)}.`, { code: "wrong_setting" });
              if (!SECRET_SETTING_NAMES.has(setting)) throw new PluginCliError(`${JSON.stringify(setting)} is not a secret setting of the stewards plugin.`, { code: "not_secret_setting", hint: `Secret settings: ${[...SECRET_SETTING_NAMES].join(", ") || "none"}.` });
              const variable = secretVariable(need);
              const info = await threadInfo(ctx.threadId);
              const hostId = info?.environmentHostId ?? null;
              if (hostId === null) throw new PluginCliError("The requester thread has no machine to read the file from.", { code: "no_host" });
              let content: string;
              try {
                const result = await bb.sdk.files.read({ hostId, path: from });
                if (result.contentEncoding !== "utf8") throw new Error("the file is not UTF-8 text");
                content = result.content;
              } catch (error) {
                throw new PluginCliError(`Could not read ${from} on the thread's machine: ${errorMessage(error)}`, { code: "read_failed" });
              }
              const value = parseDotenvValue(content, variable);
              if (value === null || value === "") throw new PluginCliError(`${variable} is not set in ${from}.`, { code: "missing_value" });
              try {
                await settings.experimental_set({ [setting]: value } as unknown as Parameters<typeof settings.experimental_set>[0]);
              } catch {
                throw new PluginCliError(`Could not write the ${setting} setting; the value was not saved.`, { code: "write_failed" });
              }
              await bb.sdk.files.remove({ hostId, path: from }).catch(() => undefined);
              // Criterion 2: importing the secret closes the item and the
              // escalation it was forwarded from in one write, and the project
              // steward is told it is answered.
              const b = store.binding(need.bindingId);
              const forwarded = forwardedFor(need);
              const closure = `The secret ${variable} was imported into ${setting}${b === null ? "" : ` for ${b.entityKey}`}.`;
              store.closeNeed(need.id, closure, "user");
              if (b !== null) await wakeProjectOnForwardedAnswer(b, closure, forwarded);
              return { exitCode: 0, stdout: `Imported ${setting}; the dotenv is gone.` };
            },
          }),

          stats: cliCommand({
            summary: "Per-method RPC and CLI call counts and timings, and published signals in the last hour",
            description:
              "The in-memory table bb core's own handler stat cannot show: one row per RPC method and CLI command, plus the signals each project published in the last hour (BB-100). Reset by a restart.",
            options: { json: JSON_OPTION },
            async run(input) {
              const stats = statsSnapshot();
              if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(stats) };
              const lines: string[] = [];
              const section = (title: string, rows: Array<[string, MethodStat]>) => {
                lines.push(title);
                if (rows.length === 0) {
                  lines.push("  (none)");
                  return;
                }
                for (const [name, s] of rows.sort((a, b) => a[0].localeCompare(b[0]))) {
                  lines.push(`  ${name}: ${s.count} call${s.count === 1 ? "" : "s"}, total ${s.totalMs}ms, max ${s.maxMs}ms, last ${s.lastMs}ms${s.lastAt === null ? "" : ` at ${iso(s.lastAt)}`}`);
                }
              };
              section("RPC methods:", Object.entries(stats.rpc));
              section("CLI commands:", Object.entries(stats.cli));
              lines.push("Signals published in the last hour:");
              const signals = Object.entries(stats.signals).sort((a, b) => a[0].localeCompare(b[0]));
              if (signals.length === 0) lines.push("  (none)");
              else for (const [projectId, count] of signals) lines.push(`  ${projectId}: ${count}`);
              return { exitCode: 0, stdout: lines.join("\n") };
            },
          }),
    };
    bb.cli.register(
      defineCli({
        name: "stewards",
        summary: "Long-lived threads that manage labelled Linear tickets and GitHub pull requests, and watch production",
        description: "Configuration lives in the project's .bb (stewards/project.json and stewards/playbooks/): a git repo is read at origin/<default>'s committed tip through multi-repo, and a plain project directory is read from <dir>/.bb on disk.",
        commands: measuredCommands(stewardsCommands),
      }),
    );

    // Exposed for tests: drive the loop without timers.
    const forgetTags = () => {
      tagged.clear();
      kept.clear();
    };
    await pinSidebarThreadListProvider(bb);
    testHooks.set(bb.pluginId, { sweep, requeueTick, unhideOnce, backfillAutoNeedsOnce, muteStewardThreadsOnce, signalNeedActionability: (bindingId: string, observed: Observed, ready?: ReadyState) => { const b = store.binding(bindingId); if (b !== null) signalNeedActionability(b, observed, ready); }, store, db, settings, forgetTags, setProjectEnabled, nightlyPass: (projectId: string, night: string) => loadConfig(projectId, true).then((c) => (c === null ? undefined : nightlyPass(c, night, true))), loadConfig: (projectId: string, force = false) => loadConfig(projectId, force), forgetConfigs: () => configs.clear(), settle: () => Promise.all([...chains.values(), ...configReads.values()]).then(() => undefined), sentryDoorbell: onSentryDoorbell, sentryLeases });
  };
}

/** Test seams, keyed by plugin id. Not part of any contract. */
export const testHooks = new Map<string, { sweep(): Promise<void>; requeueTick(): Promise<void>; unhideOnce(): Promise<void>; backfillAutoNeedsOnce(): Promise<void>; muteStewardThreadsOnce(): Promise<void>; signalNeedActionability(bindingId: string, observed: Observed, ready?: ReadyState): void; store: Store; db: { prepare(sql: string): { run(...args: unknown[]): unknown } }; settings: { get(): Promise<Record<string, unknown>> }; forgetTags(): void; setProjectEnabled(projectId: string, enabled: boolean): Promise<void>; nightlyPass(projectId: string, night: string): Promise<void>; loadConfig(projectId: string, force?: boolean): Promise<ProjectConfig | null>; forgetConfigs(): void; settle(): Promise<void>; sentryDoorbell(id: string, unit: string | null): void; sentryLeases(): Lease[] }>();

export { DEFAULT_PLAYBOOKS, STEWARDS_PLUGIN_ID };

export default createStewardsPlugin({ now: () => Date.now() });
