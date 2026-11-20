/**
 * Plain-language "what to check" text for the codes a stage run records when it fails or waits.
 * Runs store only fixed codes (see services.ts), never provider messages; a run can record several, comma-separated.
 */
const HELP: Record<string, string> = {
  "invalid-model-json": "the model's answer couldn't be read",
  "model-output-truncated": "the model's answer was cut off; try a model with a larger output limit",
  "configure-bb-provider-model-project-environment": "Execution isn't set up",
  "configure-native-execution": "Execution isn't set up",
  "repair-configuration": "the configuration is invalid; run `bb self-improve doctor`",
  "configure-development-evaluation-suite": "no development test cases are configured",
  "invalid-development-evaluation-suite": "the development test cases aren't valid JSON",
  "awaiting-problem-ranking": "problems haven't been ranked yet",
  "native-task-timeout": "an agent session took longer than `taskTimeoutMs`",
  "native-task-admission-denied": "a budget or concurrency limit stopped the work; see `bb self-improve budgets`",
  "native-task-spawn-uncertain": "BB didn't confirm the agent session started; it is reconciled automatically",
  "native-task-execution-changed": "Execution settings changed while the work ran",
  "native-task-environment-changed": "the worker environment changed while the work ran",
  "native-task-privacy-changed": "privacy settings changed while the work ran",
  "native-task-cleanup-pending": "an earlier agent session is still being cleaned up",
  "provider-rejected": "the provider refused the request; check its BB sign-in",
  "pool-exhausted": "no provider account was available",
  "daily-call-budget-exhausted": "the daily call limit (`budgets.maxDailyCalls`) was reached",
  "daily-cost-budget-exhausted": "the daily spending limit was reached",
  "monthly-cost-budget-exhausted": "the monthly spending limit was reached",
  "scope-cost-budget-exhausted": "a stage or solution spending limit was reached",
  "unpriced-model": "`budgets.allowUnknown` is off, so work without a known price can't start",
  "budget-currency-mismatch": "a recorded charge uses a different currency than `budgets.currency`",
  "service-stopped": "BB stopped the service; it resumes on its own",
  "stage-failed": "an unexpected error; run `bb self-improve doctor`",
};

/** What to check for a recorded code (or comma-separated codes); unknown codes are returned as they are. */
export function stageErrorHelp(code: string): string {
  return code.split(",").map(part => HELP[part.trim()] ?? part.trim()).join("; ");
}
