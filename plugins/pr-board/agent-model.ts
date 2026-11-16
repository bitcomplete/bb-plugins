import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const agentModelSchema = z.object({
  providerId: z.string().min(1).max(200),
  model: z.string().min(1).max(300),
  reasoningLevel: z.string().min(1).max(100).optional(),
  serviceTier: z.string().min(1).max(100).optional(),
}).strict();
export type AgentModelChoice = z.infer<typeof agentModelSchema>;
export const DEFAULT_AGENT_MODEL: AgentModelChoice = Object.freeze({ providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" });

export function normalizeAgentModel(choice: AgentModelChoice): AgentModelChoice {
  const { serviceTier, ...standard } = choice;
  return serviceTier === "default" ? standard : choice;
}

/** Use one checkout host for the picker, validation, and project-default starts. */
export async function agentModelRouting(bb: BbPluginApi, projectId: string): Promise<{ kind: "host"; hostId: string }> {
  const project = await bb.sdk.projects.get({ projectId });
  const source = project.sources.find((source) => source.isDefault) ?? (project.sources.length === 1 ? project.sources[0] : undefined);
  if (!source) throw new Error("Choose a default project checkout in BB before selecting or starting an agent.");
  return { kind: "host", hostId: source.hostId };
}

/** Validate against the same project checkout host that project-default starts use. */
export async function validateAgentModel(bb: BbPluginApi, input: AgentModelChoice, projectId: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const choice = normalizeAgentModel(input);
  const { hostId } = await agentModelRouting(bb, projectId);
  const catalog = await bb.sdk.providers.models({ hostId, projectId, providerId: choice.providerId, signal });
  signal.throwIfAborted();
  if (catalog.modelLoadError) throw new Error(`Could not load the ${choice.providerId} model catalog: ${catalog.modelLoadError.detail ?? catalog.modelLoadError.code}`);
  if (!catalog.providers.some((provider) => provider.id === choice.providerId && provider.available)) throw new Error(`Agent provider ${choice.providerId} is unavailable on this project's checkout host.`);
  const model = catalog.models.find((model) => model.model === choice.model && (!model.routeProviderId || model.routeProviderId === choice.providerId));
  if (!model) throw new Error(`Agent model ${choice.model} is unavailable for ${choice.providerId}. Choose an available model.`);
  if (choice.reasoningLevel === undefined ? model.supportedReasoningEfforts.length > 0 : !model.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === choice.reasoningLevel)) throw new Error(`Reasoning level ${choice.reasoningLevel} is unavailable for ${choice.model}.`);
  if (choice.serviceTier && !model.supportedServiceTiers?.some((tier) => tier.id === choice.serviceTier)) throw new Error(`Service tier ${choice.serviceTier} is unavailable for ${choice.model}.`);
}
