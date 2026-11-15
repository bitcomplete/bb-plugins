// The pure half of the playbook refresh (BB-328 Part 2): which stamped
// playbooks lag their shipped template, whether a queued refresh may be
// started, how the diff a refresh publishes is classified, and the pull
// request body the plugin opens from it. Nothing here touches the store or a
// plugin, so every decision is a unit test; server.ts applies what it returns.
import type { PlaybookRefresh } from "./store.js";

/** A playbook whose stamp hash differs from its current shipped template. */
export type LaggingPlaybook = {
  /** The playbook's front-matter `name`. */
  name: string;
  /** The shipped template it was copied from. */
  templateName: string;
  /** The stamp hash the project copy carries. */
  fromHash: string;
  /** The current shipped template's hash, which the refresh targets. */
  toHash: string;
};

/**
 * The stamped playbooks whose template hash has moved. A playbook with no
 * stamp (unknown origin) and one whose template no longer exists are left
 * alone: there is no template to merge, so they get the `check` warning but no
 * refresh. One entry per playbook, however many load paths reached it.
 */
export function laggingPlaybooks(
  playbooks: Iterable<{ name: string; template: { name: string; hash: string } | null }>,
  templateHashes: ReadonlyMap<string, string>,
): LaggingPlaybook[] {
  const out: LaggingPlaybook[] = [];
  const seen = new Set<string>();
  for (const p of playbooks) {
    if (p.template === null) continue;
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    const current = templateHashes.get(p.template.name);
    if (current === undefined || current === p.template.hash) continue;
    out.push({ name: p.name, templateName: p.template.name, fromHash: p.template.hash, toHash: current });
  }
  return out;
}

/** The states in which a refresh is still in flight for its playbook. */
export const OPEN_REFRESH_STATES: readonly PlaybookRefresh["state"][] = ["queued", "spawned", "pr_open"];

/** Whether a playbook may be queued for a refresh, and why not when it may not. */
export type RefreshQueueDecision = { queue: true } | { queue: false; reason: "open" | "declined" | "failed" | "merged" };

/**
 * Whether to queue a refresh for `candidate` given every refresh already
 * recorded for the playbook, newest last. At most one refresh is open per
 * playbook, and a closed refresh is not retried until the template changes: a
 * declined, failed or already-merged refresh whose target hash is still the
 * current one blocks a new queue, while one that targeted an older hash does
 * not. The merged block is the stamp-only-on-merge rule read from the queue
 * side: the merged pull request is what updated the stamp, so a still-lagging
 * read is stale and must not start a second refresh.
 */
export function refreshQueueDecision(prior: readonly PlaybookRefresh[], candidate: LaggingPlaybook): RefreshQueueDecision {
  const forPlaybook = prior.filter((r) => r.playbook === candidate.name);
  if (forPlaybook.some((r) => OPEN_REFRESH_STATES.includes(r.state))) return { queue: false, reason: "open" };
  const latest = forPlaybook.at(-1);
  if (latest !== undefined && latest.targetHash === candidate.toHash && !OPEN_REFRESH_STATES.includes(latest.state)) {
    return { queue: false, reason: latest.state === "merged" ? "merged" : latest.state === "failed" ? "failed" : "declined" };
  }
  return { queue: true };
}

/** How a refresh's published diff reads: additive, or not, and what it moved. */
export type RefreshClassification = {
  classification: "additive" | "not-additive";
  /** Lines the merge removed or rewrote, one each, for the pull request body. */
  removals: string[];
  /** A rewrite as `before → after`. */
  rewrites: Array<{ before: string; after: string }>;
  /** Why it is not purely additive: the front-matter keys that changed, if any. */
  reasons: string[];
};

/** The front matter keys a change to which is never purely additive (BB-328). */
const NEVER_ADDITIVE_KEYS = new Set(["models", "may", "requeue-default"]);

const splitFrontMatter = (text: string): { front: string | null; body: string } => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text);
  if (m === null) return { front: null, body: text };
  return { front: m[1]!, body: text.slice(m[0].length) };
};

/** The front-matter lines keyed by their key; a line that is not `key: value` is skipped. */
const frontMatterLines = (front: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const line of front.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):(.*)$/u.exec(line);
    if (m !== null) out.set(m[1]!, line);
  }
  return out;
};

/** A line-level diff operation, from a longest-common-subsequence walk. */
type DiffOp = { type: "equal" | "delete" | "insert"; line: string };

/** The LCS line diff of two texts, in order. */
function diffOps(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j] is the length of the LCS of before[i:] and after[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: "equal", line: before[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ type: "delete", line: before[i]! });
      i += 1;
    } else {
      ops.push({ type: "insert", line: after[j]! });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ type: "delete", line: before[i]! });
  for (; j < m; j += 1) ops.push({ type: "insert", line: after[j]! });
  return ops;
}

/** The removals and rewrites in a diff, pairing a delete with an adjacent insert as a rewrite. */
function movedLines(ops: DiffOp[]): { removals: string[]; rewrites: Array<{ before: string; after: string }> } {
  const removals: string[] = [];
  const rewrites: Array<{ before: string; after: string }> = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.type === "equal") {
      i += 1;
      continue;
    }
    const dels: string[] = [];
    const ins: string[] = [];
    while (i < ops.length && ops[i]!.type !== "equal") {
      if (ops[i]!.type === "delete") dels.push(ops[i]!.line);
      else ins.push(ops[i]!.line);
      i += 1;
    }
    const paired = Math.min(dels.length, ins.length);
    for (let k = 0; k < paired; k += 1) rewrites.push({ before: dels[k]!, after: ins[k]! });
    for (let k = paired; k < dels.length; k += 1) removals.push(dels[k]!);
  }
  return { removals, rewrites };
}

/**
 * Classify a refresh's published playbook against the project copy it replaces.
 * Purely additive means only insertions and the front matter untouched apart
 * from the `template:` stamp: a removed or rewritten body line, or any other
 * front-matter change (and a change to `models`, `may`, `requeue-default` or a
 * gate in particular), is not additive.
 */
export function classifyRefresh(before: string, after: string): RefreshClassification {
  const b = splitFrontMatter(before);
  const a = splitFrontMatter(after);
  const reasons: string[] = [];
  if (b.front === null || a.front === null) {
    if (b.front !== a.front) reasons.push("the front matter is missing or added");
  } else {
    const bf = frontMatterLines(b.front);
    const af = frontMatterLines(a.front);
    for (const key of new Set([...bf.keys(), ...af.keys()])) {
      if (key === "template") continue;
      if (bf.get(key) !== af.get(key)) {
        const never = NEVER_ADDITIVE_KEYS.has(key) || key.includes("gate");
        reasons.push(never ? `\`${key}\` changed, and a change to it is never additive` : `front matter \`${key}\` changed`);
      }
    }
  }
  const { removals, rewrites } = movedLines(diffOps(b.body.split("\n"), a.body.split("\n")));
  const substantiveRemovals = removals.filter((l) => l.trim() !== "");
  const substantiveRewrites = rewrites.filter((r) => r.before.trim() !== "" || r.after.trim() !== "");
  const additive = reasons.length === 0 && substantiveRemovals.length === 0 && substantiveRewrites.length === 0;
  return {
    classification: additive ? "additive" : "not-additive",
    removals: substantiveRemovals,
    rewrites: substantiveRewrites,
    reasons,
  };
}

/**
 * The pull request body the plugin opens for a refresh. The classification is
 * the plugin's own read of the diff; the refresh thread's own summary is kept
 * beside it as its claim. The project steward reads the diff and decides, and
 * the removals or rewrites are listed so that decision starts from what
 * actually moved.
 */
export function refreshPrBody(
  refresh: Pick<PlaybookRefresh, "playbook" | "templateName" | "fromHash" | "targetHash">,
  c: RefreshClassification,
  threadId: string,
  claim?: string | null,
): string {
  const path = `stewards/playbooks/${refresh.playbook}.md`;
  const lines = [
    `Refreshes \`${path}\` from template \`${refresh.templateName}\` (stamp \`${refresh.fromHash}\` → \`${refresh.targetHash}\`).`,
    "",
    "The refresh worker merged the current shipped template into the project copy, keeping the project's own additions, and updated the stamp. This is a reviewed change, never a mechanical overwrite.",
    "",
    "## Classification",
    c.classification === "additive" ? "**Purely additive** — only insertions, and the front matter is untouched apart from the stamp." : "**Not purely additive** — the merge removes or rewrites something the project copy carried.",
  ];
  if (claim !== undefined && claim !== null && claim.trim() !== "") lines.push("", "The refresh thread's own summary (its claim, not the decision):", "", "```", claim.trim(), "```");
  if (c.reasons.length > 0) lines.push("", "Front matter:", ...c.reasons.map((r) => `- ${r}`));
  if (c.removals.length > 0) lines.push("", "Removed lines:", ...c.removals.map((l) => `- \`${l}\``));
  if (c.rewrites.length > 0) {
    lines.push("", "Rewritten lines:");
    for (const r of c.rewrites) lines.push(`- \`${r.before}\` → \`${r.after}\``);
  }
  if (c.removals.length === 0 && c.rewrites.length === 0 && c.reasons.length === 0) lines.push("", "Nothing was removed or rewritten.");
  lines.push("", `_— from bb thread ${threadId}_`);
  return lines.join("\n");
}

/**
 * Whether a playbook text carries the given `template: <name>@<hash>` stamp,
 * so a merge never lands a copy whose stamp the refresh did not update.
 */
export function hasTemplateStamp(text: string, name: string, hash: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^template:\\s*${escaped}@${hash}\\s*$`, "mu").test(text);
}
