import { z } from "zod";

/** Explicit execution choices for every thread started by Workstreams, read from settings per role. */
export type ModelRole = "code" | "planning";
const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;
export type ModelChoice = { providerId: string; model: string; reasoningLevel: (typeof REASONING_LEVELS)[number] };

const MODEL_SETTING = new RegExp(`^([^/\\s]+)/([^/\\s]+)/(${REASONING_LEVELS.join("|")})$`, "u");
export const modelSettingSchema = z.string().regex(MODEL_SETTING,
  `Use providerId/model/reasoningLevel, such as codex/gpt-6-sol/high. Reasoning levels: ${REASONING_LEVELS.join(", ")}.`);

export function parseModelSetting(value: string): ModelChoice {
  const match = MODEL_SETTING.exec(value);
  if (!match) throw new Error(`Model setting "${value}" is not providerId/model/reasoningLevel.`);
  return { providerId: match[1]!, model: match[2]!, reasoningLevel: match[3] as ModelChoice["reasoningLevel"] };
}

/** Threads that delegate are told the settings, so the children they start follow them too. */
export function delegationModels(models: Record<ModelRole, ModelChoice>): string {
  const setting = ({ providerId, model, reasoningLevel }: ModelChoice) => `${providerId}/${model}/${reasoningLevel}`;
  return `Use ${setting(models.code)} for work agents and ${setting(models.planning)} for planning agents (providerId/model/reasoningLevel).`;
}

/** A thread's provider is fixed at creation; changing its model cannot migrate it. */
export function configuredProviderError(thread: { providerId: string }, choice: ModelChoice): string | null {
  return thread.providerId === choice.providerId ? null
    : `This thread runs on ${thread.providerId}, not the configured ${choice.providerId} provider. Message it in its own thread, or set the Code-work model to a ${thread.providerId} model; nothing was sent.`;
}
