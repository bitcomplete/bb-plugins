import {
  BRIEF_STAGES,
  summaryResultSchema,
  type BriefStage,
  type SummaryResult,
} from "./contract.js";

export const SYSTEM_PROMPT = `You write one-paragraph-max operating briefs for software engineering threads, so someone returning after a day away knows what the thread is for and what to do next without reading it.

Return ONLY a JSON object with exactly these keys:

  "goal"          One line: what this thread is actually trying to achieve. Not the opening prompt restated — the underlying objective, as it stands now.
  "currentState"  What exists now, including half-finished work. Name the concrete artifacts (files, branches, PRs) where the transcript names them.
  "nextStep"      The single most concrete next action, phrased so the reader could start it without thinking. ONE action, not a plan.
  "blockedOn"     Who or what the thread is waiting on. Empty string if nothing is blocking it.
  "constraints"   Facts learned during the thread that would break a naive re-plan: API limits, rejected approaches, assumptions proven wrong. Empty string if none.
  "stage"         One of: "discovery", "planning", "implementation", "review".

Rules:
- Every field is a string. Keep each to one or two lines.
- NEVER invent a next step. If the work described is finished, "nextStep" MUST be the empty string. A brief that invents work is worse than one that says the thread is done.
- Use empty strings, not "none" / "N/A" / "nothing".
- Write plainly and specifically. No preamble, no hedging, no restating these instructions.
- Base every claim on the transcript. Do not speculate about what the code or the user probably wants.`;

export function buildUserPrompt(args: {
  transcript: string;
  fixedStage: BriefStage | null;
}): string {
  const stageLine =
    args.fixedStage === null
      ? `Judge "stage" from the transcript.`
      : `"stage" is fixed to ${JSON.stringify(
          args.fixedStage,
        )} by the user — return exactly that value regardless of what the transcript suggests.`;

  return `${stageLine}

Thread transcript follows.

---
${args.transcript}
---

Return the JSON object now.`;
}

/**
 * Pull a JSON object out of a model reply. Small models wrap JSON in prose or
 * fences often enough that strict parsing would be the main source of failures.
 */
export function extractJson(reply: string): unknown {
  const trimmed = reply.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed);
  const candidates = [fenced?.[1], trimmed].filter(
    (value): value is string => typeof value === "string",
  );

  for (const candidate of candidates) {
    const text = candidate.trim();
    try {
      return JSON.parse(text);
    } catch {
      // Fall through to brace-slicing below.
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Try the next candidate.
      }
    }
  }
  throw new Error("model reply contained no JSON object");
}

const EMPTY_SYNONYMS = new Set([
  "",
  "none",
  "n/a",
  "na",
  "nothing",
  "unknown",
  "not applicable",
  "no next step",
  "-",
]);

/** The model is told to use empty strings; this catches it when it doesn't. */
function normalizeField(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return EMPTY_SYNONYMS.has(trimmed.toLowerCase()) ? "" : trimmed;
}

export function parseSummary(
  reply: string,
  fixedStage: BriefStage | null,
): SummaryResult {
  const raw = extractJson(reply);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("model reply was not a JSON object");
  }
  const record = raw as Record<string, unknown>;

  const rawStage = typeof record.stage === "string" ? record.stage.trim() : "";
  const stage: BriefStage =
    fixedStage ??
    (BRIEF_STAGES.includes(rawStage as BriefStage)
      ? (rawStage as BriefStage)
      : // An unrecognized stage is not worth failing the whole brief over;
        // implementation is the safest neutral guess.
        "implementation");

  return summaryResultSchema.parse({
    goal: normalizeField(record.goal),
    currentState: normalizeField(record.currentState),
    nextStep: normalizeField(record.nextStep),
    blockedOn: normalizeField(record.blockedOn),
    constraints: normalizeField(record.constraints),
    stage,
  });
}

export interface CompletionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  jsonMode: boolean;
}

/** Trailing slashes are the single most common way a base URL is mistyped. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/u, "")}/chat/completions`;
}

export async function requestSummary(
  config: CompletionConfig,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(chatCompletionsUrl(config.baseUrl), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      ...(config.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `summarizer HTTP ${response.status}${
        detail === "" ? "" : `: ${detail.slice(0, 400)}`
      }`,
    );
  }

  const body = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("summarizer returned an empty reply");
  }
  return content;
}
