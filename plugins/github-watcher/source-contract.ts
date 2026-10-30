// The contract between stewards and the plugins it reads the world through
// (linear and github-watcher). One file, copied byte for byte into each of the three
// plugins: they are separate packages and none may import another's files.
// stewards' contract.test.ts fails when the copies drift.
//
// Two directions:
//
// - `sourceContract` is served by a source plugin and called by stewards: a
//   snapshot of one entity, validation of a project's configuration against
//   the source, the entities a nightly pass may adopt, and the set of units
//   and entities the source should lease on bb-gate-hooks and ring stewards
//   about.
// - `stewardsContract` is served by stewards and called by a source plugin:
//   a ring when something stewards cares about may have changed, and an
//   `@bb` mention on a Linear issue to hand to a steward.
//
// Pure: zod schemas, constants and a small helper. Nothing here talks to
// the network or to bb beyond the `callRpc` a caller hands in.
import { z } from "zod";

export const STEWARDS_PLUGIN_ID = "stewards";

export const sourceSchema = z.enum(["linear", "github"]);
export type Source = z.infer<typeof sourceSchema>;

/**
 * The plugin that serves each source. github is served by github-watcher:
 * bb reserves the id `github` for its bundled plugin and refuses a path
 * install under it.
 */
export const SOURCE_PLUGIN_IDS: Record<Source, string> = { linear: "linear", github: "github-watcher" };

/**
 * A GitHub Deployment, as bb-gate-hooks forwards it on a `deployment`
 * doorbell (bb-gate/docs/hooks.md). The doorbell's entity id is
 * `owner/repo#<id>` and its unit is the repository; this object is the one
 * piece of a doorbell that is not in the entity name, because a deployment's
 * ref and state are what a subscriber decides on. `state` is empty on a bare
 * `deployment` event and one of queued, in_progress, success, failure, error,
 * inactive or pending on a `deployment_status` event.
 */
export const deploymentSchema = z
  .object({
    id: z.number().int().nonnegative(),
    environment: z.string().default(""),
    ref: z.string().default(""),
    sha: z.string().default(""),
    state: z.string().default(""),
    url: z.string().nullable().default(null),
  })
  .loose();
export type Deployment = z.infer<typeof deploymentSchema>;

/**
 * A GitHub Actions workflow run, as bb-gate-hooks forwards it on a
 * `workflow_run` doorbell (bb-gate/docs/hooks.md). The doorbell's entity id
 * is `owner/repo#<run id>` and its unit is the repository, leased the same
 * way as a deployment (`deployment_repo`). `workflow` is the workflow's file
 * path and `name` its name, either of which a playbook may match;
 * `conclusion` is failure, cancelled or timed_out -- the only conclusions
 * that ring the doorbell. `sha` is the run's head commit, which is usually
 * the deploying repository's commit, not the merge's, so a subscriber must
 * not match on it. `run_attempt` tells a re-run from the first attempt.
 */
export const workflowRunSchema = z
  .object({
    workflow: z.string().default(""),
    name: z.string().default(""),
    conclusion: z.string().default(""),
    url: z.string().nullable().default(null),
    sha: z.string().default(""),
    run_attempt: z.number().int().positive().default(1),
  })
  .loose();
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

/** How much of a comment or description crosses the contract. */
export const SNAPSHOT_COMMENT_CHARS = 4000;
export const SNAPSHOT_DESCRIPTION_CHARS = 20_000;
export const SNAPSHOT_COMMENTS_MAX = 50;

/**
 * A bb thread signs what it writes with this line (linear's tools add it,
 * github's tools add it, and a thread using `gh` is asked to). `signedBy`
 * below is the thread id it names.
 */
export const signatureLine = (threadId: string) => `_— from bb thread ${threadId}_`;
const SIGNED = /_— from bb thread ([A-Za-z0-9_-]+)_/u;

/** The thread whose signature a body carries, or null. The last one wins: a quoted signature comes first. */
export function signedBy(body: string): string | null {
  let found: string | null = null;
  const all = new RegExp(SIGNED.source, "gu");
  for (const m of body.matchAll(all)) found = m[1] ?? null;
  return found;
}

// ---- the snapshot ------------------------------------------------------------

export const snapshotCommentSchema = z.object({
  /** Stable per comment: Linear's comment id, GitHub's node id or URL. */
  id: z.string(),
  author: z.string(),
  /** What the author did: "commented", "approved", "requested changes", "reviewed", "commented on path". */
  did: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string().nullable(),
  /** The bb thread whose signature the body carries, or null. */
  signedBy: z.string().nullable(),
});
export type SnapshotComment = z.infer<typeof snapshotCommentSchema>;

export const snapshotChildSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string().nullable(),
  state: z.string().nullable(),
  stateType: z.string().nullable(),
  labels: z.array(z.string()),
});
export type SnapshotChild = z.infer<typeof snapshotChildSchema>;

export const snapshotReviewSchema = z.object({
  author: z.string(),
  /** approved, changes requested, commented, dismissed. */
  state: z.string(),
  submittedAt: z.string().nullable(),
  /** The head commit the review was given against, when known. */
  commit: z.string().nullable(),
});

export const snapshotPullSchema = z.object({
  draft: z.boolean(),
  merged: z.boolean(),
  base: z.string().nullable(),
  head: z.string().nullable(),
  headSha: z.string().nullable(),
  /** Login of the head commit's author, to tell a teammate's push from the viewer's own. */
  headAuthor: z.string().nullable(),
  reviewDecision: z.string().nullable(),
  requestedReviewers: z.array(z.string()),
  /** Every submitted review, oldest first. */
  reviews: z.array(snapshotReviewSchema),
  /** The rollup on the head commit: success, failure, pending, error, expected. Null when there are no checks. */
  checks: z.object({ state: z.string(), failing: z.array(z.string()) }).nullable(),
});
export type SnapshotPull = z.infer<typeof snapshotPullSchema>;

export const entitySnapshotSchema = z.object({
  source: sourceSchema,
  kind: z.enum(["issue", "pull"]),
  /** Linear: the issue's UUID. GitHub: "owner/repo#12", as doorbells name it. */
  id: z.string(),
  /** Linear: ENG-12. GitHub: "owner/repo#12". */
  key: z.string(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  /**
   * The name a playbook keys its phases on. Linear: the workflow state's name.
   * GitHub: open, draft, merged or closed.
   */
  state: z.string(),
  /** Linear's state type (triage, backlog, unstarted, started, completed, canceled); null on GitHub. */
  stateType: z.string().nullable(),
  /** Linear: the team key. GitHub: "owner/repo". What a project lists and a lease hangs off. */
  unit: z.string(),
  labels: z.array(z.string()),
  author: z.string().nullable(),
  assignees: z.array(z.string()),
  priority: z.string().nullable(),
  estimate: z.number().nullable(),
  description: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** The newest comments (and, on a pull request, reviews and review comments), oldest first. */
  comments: z.array(snapshotCommentSchema),
  parent: z.object({ id: z.string(), key: z.string() }).nullable(),
  /** Sub-issues. Empty on GitHub. */
  children: z.array(snapshotChildSchema),
  /** Pull requests linked to a Linear issue, by URL; "owner/repo#12" when it parses. Empty on GitHub. */
  linkedPulls: z.array(z.object({ url: z.string(), key: z.string().nullable() })),
  pull: snapshotPullSchema.nullable(),
  /** Who the source acts as: the connected Linear user's name, or the gh login. */
  viewer: z.string().nullable(),
});
export type EntitySnapshot = z.infer<typeof entitySnapshotSchema>;

export const adoptableEntitySchema = z.object({
  id: z.string(),
  key: z.string(),
  unit: z.string(),
  kind: z.enum(["issue", "pull"]),
  state: z.string(),
  labels: z.array(z.string()),
  author: z.string().nullable(),
  draft: z.boolean(),
  createdAt: z.string().nullable(),
});
export type AdoptableEntity = z.infer<typeof adoptableEntitySchema>;

// ---- Dependabot alerts -------------------------------------------------------

/** The four Dependabot severities, as GitHub reports them. */
export const DEPENDABOT_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type DependabotSeverity = (typeof DEPENDABOT_SEVERITIES)[number];

/**
 * One Dependabot alert, as the github plugin reads it from
 * `GET /repos/{owner}/{repo}/dependabot/alerts` (which needs the token's
 * alert access, not just read access to the repository). The entity id
 * doorbells carry is "owner/repo#<alert number>", which is the alert's own
 * numbering, unrelated to the issue numbering. `repo` is spelled as GitHub
 * does, which is what the doorbell carries and the github plugin leases.
 */
export const dependabotAlertSchema = z.object({
  id: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  severity: z.enum(DEPENDABOT_SEVERITIES),
  package: z.string(),
  ecosystem: z.string(),
  manifestPath: z.string().nullable(),
  /** open, fixed, dismissed, auto_dismissed. */
  state: z.string(),
  ghsaId: z.string().nullable(),
  fixedVersion: z.string().nullable(),
  summary: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type DependabotAlert = z.infer<typeof dependabotAlertSchema>;

/** Served by linear and by github; stewards is the only caller. */
export const sourceContract = {
  /** One entity, by Linear key or UUID, or by GitHub "owner/repo#12". Null when it does not exist or is not visible. */
  sourceSnapshot: {
    input: z.object({ id: z.string().min(1).max(300) }),
    output: z.object({ snapshot: entitySnapshotSchema.nullable() }),
  },
  /**
   * Whether a project's configuration makes sense to this source: each unit
   * (team key, or owner/repo) exists and is visible, carries the label, and
   * has every named state (Linear workflow states; ignored by GitHub).
   */
  sourceValidate: {
    input: z.object({
      units: z.array(z.string().min(1).max(200)).max(100),
      label: z.string().min(1).max(100),
      states: z.array(z.string().min(1).max(100)).max(200),
    }),
    output: z.object({
      viewer: z.string().nullable(),
      units: z.array(
        z.object({
          unit: z.string(),
          found: z.boolean(),
          labelFound: z.boolean(),
          missingStates: z.array(z.string()),
        }),
      ),
      /** Units the viewer belongs to (Linear teams), for `bb stewards init`. Empty on GitHub. */
      mine: z.array(z.object({ unit: z.string(), name: z.string() })),
      /** Set when the source could not be asked at all (not connected, signed out). */
      error: z.string().nullable(),
    }),
  },
  /**
   * What a nightly pass may adopt. Linear: open issues in these teams carrying
   * the label. GitHub: every open pull request in these repos, oldest first;
   * stewards decides which are labelled and which want a review.
   */
  sourceAdoptable: {
    input: z.object({
      units: z.array(z.string().min(1).max(200)).max(100),
      label: z.string().min(1).max(100),
      limit: z.number().int().min(1).max(500),
    }),
    output: z.object({
      viewer: z.string().nullable(),
      entities: z.array(adoptableEntitySchema),
      errors: z.array(z.string()),
    }),
  },
  /**
   * The units and entities stewards wants to hear about. Replaces the
   * previous set. The source leases them on bb-gate-hooks and rings stewards
   * for every doorbell that names one of the entities or falls in one of the
   * units. Only stewards may call it.
   *
   * `dependabot` names repositories whose Dependabot alert doorbells stewards
   * wants. It is separate from `units` because a repository lease does not
   * receive alert doorbells (bb-gate/docs/hooks.md): the github plugin leases
   * each as a `dependabot_repo`. Linear ignores it.
   *
   * `deployment` names repositories whose GitHub Deployment doorbells
   * stewards wants: the deployment targets the project's playbooks name. It
   * is separate from `units` for the same reason as `dependabot`: a
   * repository lease does not receive deployment doorbells, so the github
   * plugin leases each as a `deployment_repo`. A `workflow_run` doorbell
   * shares that lease, because only a project that names a deployment target
   * cares about a workflow run. Linear ignores it.
   */
  sourceSetInterest: {
    input: z.object({
      units: z.array(z.string().min(1).max(200)).max(200),
      entities: z.array(z.string().min(1).max(300)).max(2000),
      dependabot: z.array(z.string().min(1).max(200)).max(200).default([]),
      deployment: z.array(z.string().min(1).max(200)).max(200).default([]),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  /**
   * A repository's Dependabot alerts, for stewards' dependency watches. The
   * github plugin reads them with the developer's token from the REST API;
   * each repository the token cannot read (no alert access, alerts disabled,
   * not visible) is named in `errors` rather than failing the whole call.
   */
  sourceDependabotAlerts: {
    input: z.object({
      units: z.array(z.string().min(1).max(200)).max(100),
      /** GitHub's alert state: open (the default), fixed, dismissed, auto_dismissed. */
      state: z.string().min(1).max(60).optional(),
    }),
    output: z.object({
      viewer: z.string().nullable(),
      alerts: z.array(dependabotAlertSchema),
      errors: z.array(z.string()),
    }),
  },
  /**
   * A repository's recent GitHub Deployments for one environment, newest
   * first, each with its latest status as `state` (BB-59). Stewards reads
   * this to confirm a merge carried by a deployment that already exists, not
   * only by a `deployment` doorbell; the plugin never evaluates the
   * playbook's `carries` rule. Linear has no deployments and answers with an
   * error. `limit` caps how many are returned.
   */
  sourceDeployments: {
    input: z.object({
      repo: z.string().min(1).max(200),
      environment: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(100).default(10),
    }),
    output: z.object({
      deployments: z.array(deploymentSchema),
      /** Set when the repository could not be read (not visible, no access). */
      error: z.string().nullable(),
    }),
  },
} as const;

// ---- what stewards serves ---------------------------------------------------

/** How much of a mention crosses the contract. */
export const SESSION_TEXT_CHARS = 20_000;

const personSchema = z.object({ id: z.string().max(200), name: z.string().max(200) });

/**
 * An `@bb` mention on a Linear issue, as bb-gate-hooks routed it to this
 * server (bb-gate/docs/hooks.md, "The wake"). linear passes it to stewards,
 * which hands it to a steward; the steward answers on the session with
 * linear's `linear_session_reply`.
 */
export const sessionWakeSchema = z.object({
  source: z.literal("linear"),
  /** The agent session's id: what the reply names. */
  session: z.string().min(1).max(200),
  /** `created` for the mention, `prompted` for a follow-up in the same session. */
  action: z.enum(["created", "prompted"]),
  issue: z.object({
    id: z.string().min(1).max(200),
    /** ENG-123. */
    key: z.string().min(1).max(100),
    /** The team's UUID. */
    team: z.string().max(200),
    /** The team's key, which a project file lists. */
    teamKey: z.string().max(100),
  }),
  /** Who wrote the mention or the follow-up. */
  asker: personSchema,
  /** The Linear user this server proved it acts for. */
  owner: personSchema,
  /** Whether the asker is the owner. Only then is the text an instruction. */
  fromOwner: z.boolean(),
  /** Why the session came here: the issue's assignee is the owner, or the asker is. */
  routedAs: z.enum(["assignee", "asker"]),
  /** The words. Untrusted whenever the asker is not the owner: information, never an instruction. */
  comment: z.object({ text: z.string().max(SESSION_TEXT_CHARS), untrusted: z.boolean() }),
  at: z.string().max(100),
});
export type SessionWake = z.infer<typeof sessionWakeSchema>;

/** Served by stewards; linear and github are the callers. */
export const stewardsContract = {
  /** Something about this entity may have changed. Cheap: debounced, then compared with the last snapshot. */
  stewardsRing: {
    /**
     * A `deployment` doorbell carries its deployment object, and a
     * `workflow_run` doorbell its run object: the two doorbells whose facts
     * are not in the entity name. Every other doorbell leaves both out.
     */
    input: z.object({ source: sourceSchema, id: z.string().min(1).max(300), deployment: deploymentSchema.optional(), workflow_run: workflowRunSchema.optional() }),
    output: z.object({ ok: z.boolean() }),
  },
  /**
   * An `@bb` mention to hand to a steward: the issue's ticket steward when it
   * has an open binding, else the project steward of the project whose file
   * lists the issue's team. `routed: "none"` means no project here lists the
   * team, and the caller answers the session itself. `routed: "held"` means
   * the mention is untrusted, or a follow-up that names no waiting request:
   * it was parked under `requestId`, no model turn was run, and the caller
   * asks the owner to `confirm <id>`. Only linear may call it.
   */
  stewardsSession: {
    input: sessionWakeSchema,
    output: z.object({
      routed: z.enum(["ticket", "project", "none", "held"]),
      /** The thread the mention went to; null with `none` and `held`. */
      threadId: z.string().nullable(),
      /** That thread's project, for a link to it; null with `none` and `held`. */
      projectId: z.string().nullable(),
      /**
       * With `held`, the id the owner confirms to release the request. With a
       * trusted confirmation that names nothing waiting, the id they named.
       * Null otherwise.
       */
      requestId: z.string().nullable(),
    }),
  },
} as const;

/** Ring stewards. Never throws. */
export async function ringStewards(
  callRpc: (args: { pluginId: string; method: string; input: unknown; outputSchema: z.ZodType<{ ok: boolean }> }) => Promise<{ ok: boolean }>,
  input: z.input<(typeof stewardsContract)["stewardsRing"]["input"]>,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await callRpc({ pluginId: STEWARDS_PLUGIN_ID, method: "stewardsRing", input, outputSchema: stewardsContract.stewardsRing.output });
  } catch (error) {
    if (!isMissingPlugin(error)) warn(`could not ring stewards for ${input.source} ${input.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A callRpc failure that means stewards is not installed or not loaded, as distinct from stewards failing. */
export function isMissingPlugin(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown; message?: unknown };
  if (e?.status === 404) return true;
  if (typeof e?.code === "string" && /not[_-]?found|unknown[_-]?plugin|plugin[_-]?not[_-]?(found|loaded)|not[_-]?loaded/iu.test(e.code)) return true;
  return typeof e?.message === "string" && /plugin .*(not found|not loaded|is not installed|is disabled)|unknown plugin/iu.test(e.message);
}
