/**
 * Run a checkout's summarizer prompt over frozen threads against the live
 * model, and report how often the status it produces agrees with a person's.
 *
 *   FIREWORKS_API_KEY=… npx vite-node eval/run.ts -- \
 *     --fixtures <dir> --labels <labels.json> [--src <plugin dir>] \
 *     [--feedback on|off|both] [--runs 1] [--out results.json]
 *
 * `--src` is the plugin directory whose `summarize.ts`, `transcript.ts` and
 * `brief.ts` are used, so the same harness scores `main` and a candidate:
 * check one out with `git worktree add` and point `--src` at it.
 *
 * `--feedback` controls whether the stored brief is fed back as the previous
 * brief. `on` is what a Re-summarize press does today; `off` is a thread's
 * first summary. Running both shows whether feeding the brief back makes a
 * wrong reading stick.
 *
 * A status is read from the parsed summary's own `status` when the prompt asks
 * for one, and from the checkout's `deriveStatus` over its fields otherwise —
 * which is how `main` read status before the summarizer was asked for it.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { StoredBriefStatus } from "../contract.js";
import type { EvalFixture, EvalLabels } from "./fixture.js";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    fixtures: { type: "string" },
    labels: { type: "string" },
    src: { type: "string", default: resolve(import.meta.dirname, "..") },
    feedback: { type: "string", default: "both" },
    runs: { type: "string", default: "1" },
    out: { type: "string" },
    "base-url": { type: "string", default: "https://api.fireworks.ai/inference/v1" },
    model: { type: "string", default: "accounts/fireworks/models/glm-5p3-flash" },
    concurrency: { type: "string", default: "6" },
  },
});

if (values.fixtures === undefined || values.labels === undefined) {
  console.error("usage: vite-node eval/run.ts -- --fixtures <dir> --labels <labels.json>");
  process.exit(2);
}
const apiKey = process.env.FIREWORKS_API_KEY ?? process.env.SUMMARIZER_API_KEY ?? "";
if (apiKey === "") {
  console.error("set FIREWORKS_API_KEY");
  process.exit(2);
}

const src = resolve(values.src);
const summarize = await import(join(src, "summarize.ts"));
const transcriptModule = await import(join(src, "transcript.ts"));
const brief = await import(join(src, "brief.ts"));

const labels = JSON.parse(readFileSync(values.labels, "utf8")) as EvalLabels;
const fixtures = readdirSync(values.fixtures)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(values.fixtures!, name), "utf8")) as EvalFixture)
  .filter((fixture) => fixture.threadId in labels);

const feedbackModes: boolean[] =
  values.feedback === "both" ? [true, false] : [values.feedback === "on"];
const runs = Number(values.runs);
const config = {
  baseUrl: values["base-url"]!,
  apiKey,
  model: values.model!,
  jsonMode: true,
};

interface Outcome {
  threadId: string;
  feedback: boolean;
  run: number;
  expected: StoredBriefStatus;
  got: StoredBriefStatus | "error";
  stage?: string;
  nextStep?: string;
  blockedOn?: string;
  /** The status exactly as the model wrote it, before the parser's guard and fallback. */
  rawStatus?: unknown;
  error?: string;
}

function statusOf(summary: Record<string, unknown>): StoredBriefStatus {
  if (typeof summary.status === "string") return summary.status as StoredBriefStatus;
  return brief.deriveStatus(summary);
}

async function evaluate(
  fixture: EvalFixture,
  feedback: boolean,
  run: number,
): Promise<Outcome> {
  const expected = labels[fixture.threadId]!;
  const transcript = transcriptModule.renderTranscript({
    title: fixture.title,
    outline: fixture.outline,
    lastAssistantText: fixture.lastAssistantText,
    previousBrief: feedback ? fixture.previousBrief : null,
  });
  const userPrompt = summarize.buildUserPrompt({ transcript, fixedStage: null, pinnedStatus: null });
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await summarize.requestSummary(config, userPrompt, AbortSignal.timeout(120_000));
      const summary = summarize.parseSummary(reply, null) as Record<string, unknown>;
      const raw = summarize.extractJson(reply) as Record<string, unknown>;
      return {
        threadId: fixture.threadId,
        feedback,
        run,
        expected,
        got: statusOf(summary),
        stage: String(summary.stage),
        nextStep: String(summary.nextStep ?? ""),
        blockedOn: String(summary.blockedOn ?? ""),
        rawStatus: raw.status,
      };
    } catch (error) {
      if (attempt < 2) continue;
      return { threadId: fixture.threadId, feedback, run, expected, got: "error", error: String(error) };
    }
  }
}

const jobs: (() => Promise<Outcome>)[] = [];
for (const feedback of feedbackModes) {
  for (let run = 0; run < runs; run += 1) {
    for (const fixture of fixtures) jobs.push(() => evaluate(fixture, feedback, run));
  }
}

const outcomes: Outcome[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const outcome = await job();
      outcomes.push(outcome);
      process.stderr.write(outcome.got === outcome.expected ? "." : "x");
    }
  }),
);
process.stderr.write("\n");

const STATUSES = ["done", "waiting-on-me", "waiting-on-other"] as const;
const short = { done: "done", "waiting-on-me": "on-me", "waiting-on-other": "on-other", error: "error" };

console.log(`src: ${src}`);
console.log(`model: ${config.model}, ${fixtures.length} threads, ${runs} run(s) each\n`);
for (const feedback of feedbackModes) {
  const subset = outcomes.filter((outcome) => outcome.feedback === feedback);
  const agree = subset.filter((outcome) => outcome.got === outcome.expected).length;
  // The expensive error: a thread someone still owes an action read as done,
  // which puts it on the auto-archive clock.
  const falseDone = subset.filter(
    (outcome) => outcome.got === "done" && outcome.expected !== "done",
  ).length;
  const missedDone = subset.filter(
    (outcome) => outcome.expected === "done" && outcome.got !== "done",
  ).length;
  console.log(`## previous brief fed back: ${feedback ? "yes" : "no"}`);
  console.log(
    `agreement ${agree}/${subset.length} (${Math.round((100 * agree) / subset.length)}%)` +
      `  false done ${falseDone}  missed done ${missedDone}`,
  );
  console.log(`\n| expected \\ got | ${[...STATUSES, "error" as const].map((s) => short[s]).join(" | ")} |`);
  console.log(`| --- |${" --- |".repeat(STATUSES.length + 1)}`);
  for (const expected of STATUSES) {
    const row = [...STATUSES, "error" as const].map(
      (got) =>
        subset.filter((outcome) => outcome.expected === expected && outcome.got === got).length,
    );
    if (row.every((count) => count === 0)) continue;
    console.log(`| ${short[expected]} | ${row.join(" | ")} |`);
  }
  const misses = subset
    .filter((outcome) => outcome.got !== outcome.expected)
    .sort((a, b) => a.threadId.localeCompare(b.threadId));
  if (misses.length > 0) {
    console.log("\nDisagreements:");
    for (const miss of misses) {
      console.log(
        `- ${miss.threadId} expected ${short[miss.expected]}, got ${short[miss.got]}` +
          (miss.error !== undefined
            ? `: ${miss.error.slice(0, 160)}`
            : `${miss.rawStatus !== miss.got ? ` (model said ${JSON.stringify(miss.rawStatus) ?? "nothing"})` : ""}` +
              `${miss.blockedOn ? ` blockedOn: "${miss.blockedOn}"` : ""} nextStep: "${miss.nextStep}"`),
      );
    }
  }
  console.log("");
}

if (values.out !== undefined) {
  writeFileSync(values.out, `${JSON.stringify(outcomes, null, 1)}\n`);
}
