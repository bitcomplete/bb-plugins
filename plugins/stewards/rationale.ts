// BB-35 step 4: when the page asks the user why, and what it says. Pure, so
// the rules live in one place and every ask and never-ask is a unit test. The
// plugin sets `rationaleWanted` on an escalation only through these; the page
// shows the box only when it is set. The user's input is rationed: an empty box
// is always accepted, and one cluster is never asked twice.

/** The one-line why for a routine decision the guidance did not settle. */
export const ROUTINE_RATIONALE_WHY = "The project's guidance did not settle this, so your reasoning becomes a lesson instead of being asked again.";
/** The one-line why for a repeat the nightly pass clustered under one playbook. */
export const REPEAT_RATIONALE_WHY = "This has reached you before, so a sentence on why helps the guidance stick.";
/** The one-line why for the single after-the-fact follow-up in the project steward's thread. */
export const AFTER_THE_FACT_RATIONALE_WHY = "Your answer went against the recommendation, so a sentence on why helps the lesson stick.";

/**
 * Normalise a question to a cluster key under its playbook, so the same
 * question asked twice about the same kind of work clusters. Case, punctuation
 * and spacing are dropped; the playbook keeps two kinds of work apart.
 */
export function clusterKey(playbook: string | null, question: string): string {
  const text = question.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, " ").trim();
  return `${playbook ?? "?"}\u0000${text}`;
}

/**
 * Whether a forwarded escalation is a routine one the guidance did not settle,
 * so the page should ask why. A named decide-list entry means the project
 * steward forwarded a big decision (which the project could never decide), and
 * the gate items (`approval`) and a credential or a plain step (`secret`,
 * `done`) never ask. Only a free-text or fixed-choice decision does.
 */
export function routineRationaleWanted(fields: { kind: string; resolutionKind: string | null; entry?: string | null }): boolean {
  if (fields.kind === "approval") return false;
  if (fields.resolutionKind !== "text" && fields.resolutionKind !== "choice") return false;
  return (fields.entry ?? "").trim() === "";
}
