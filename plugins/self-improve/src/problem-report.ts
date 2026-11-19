import type { Problem, Solution, Vote } from "./domain/types.js";
import type { AppliedImprovement } from "./improvements.js";

export interface ProblemReport { title: string; body: string; issueUrl: string | null }
const WHERE: Record<NonNullable<Problem["location"]>["kind"], string> = {
  agent: "How the agent worked", plugin: "A plugin", skill: "A skill", bb: "BB itself", configuration: "A setting or configuration", unknown: "Not yet known",
};

/**
 * A report about a problem whose cause is outside what Self improve can change (a plugin, a skill, BB or a setting),
 * for the owner to send wherever it belongs. Built from the ledger only; text there is already redacted.
 */
export function problemReport(input: { problem: Problem; votes: Vote[]; solutions: Solution[]; applied: AppliedImprovement[]; sourceUrl?: string | null }): ProblemReport {
  const { problem } = input, location = problem.location ?? { kind: "unknown" as const, name: null };
  const votes = input.votes.filter(v => v.problemId === problem.id || problem.aliases.includes(v.problemId));
  const threads = [...new Set(votes.flatMap(v => v.evidence?.kind === "thread" ? [v.evidence.threadId] : []))];
  const days = votes.map(v => v.day).sort();
  const linked = input.solutions.filter(s => problem.solutionIds.includes(s.id) || s.problemIds.includes(problem.id));
  const workaround = input.applied.find(a => a.enabled && linked.some(s => s.id === a.solutionId));
  const symptom = problem.symptoms[0]?.text ?? problem.category;
  const where = location.name ? `${WHERE[location.kind]}: ${location.name}` : WHERE[location.kind];
  const lines = [
    "## What happens", ...problem.symptoms.map(s => `- ${s.text}`), "",
    "## Where", where, "",
    "## Likely cause", ...problem.causes.map(c => `- ${c.text}`), "",
    "## Evidence", `${votes.length} ${votes.length === 1 ? "occurrence" : "occurrences"} in ${threads.length} BB ${threads.length === 1 ? "thread" : "threads"}${days.length ? `, ${days[0]} to ${days.at(-1)}` : ""}.`,
    ...(threads.length ? [`Threads: ${threads.slice(0, 10).join(", ")}${threads.length > 10 ? ", …" : ""}`] : []), "",
    ...(workaround ? ["## Workaround in use", "Agents in this installation currently receive this instruction:", "", `> ${workaround.content.replace(/\n/g, "\n> ")}`, ""] : []),
    ...(linked.length ? ["## Suggested fixes", ...linked.map(s => `- ${s.title}: ${s.mechanism}`), ""] : []),
    "_Found by the Self improve plugin from this installation's BB threads._",
  ];
  const title = `${symptom.length > 90 ? `${symptom.slice(0, 87)}…` : symptom}`;
  const body = lines.join("\n");
  const repo = input.sourceUrl ? /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[#/?].*)?$/.exec(input.sourceUrl)?.[1] ?? null : null;
  const issueUrl = repo ? `https://github.com/${repo}/issues/new?${new URLSearchParams({ title, body: body.slice(0, 6000) }).toString()}` : null;
  return { title, body, issueUrl };
}
