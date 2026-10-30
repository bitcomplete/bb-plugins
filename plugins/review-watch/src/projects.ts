import { z } from "zod";

const organizationProjectsSchema = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9-]*$/i),
  z.string().trim().min(1),
);

export function parseOrganizationProjects(value: string): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Organization projects must be a JSON object mapping GitHub organizations to BB project IDs."); }
  const entries = organizationProjectsSchema.parse(parsed);
  const normalized: Record<string, string> = Object.create(null);
  for (const [organization, projectId] of Object.entries(entries)) {
    const key = organization.toLowerCase();
    if (normalized[key] !== undefined && normalized[key] !== projectId) {
      throw new Error(`Conflicting project mappings for ${organization}.`);
    }
    normalized[key] = projectId;
  }
  return normalized;
}

export const projectChoiceSchema = z.object({
  projectId: z.string().nullable(),
  reason: z.enum(["organization", "default", "mixed", "choose"]),
});

export function suggestedProject(
  items: readonly { repo: string }[],
  mappings: Readonly<Record<string, string>>,
  fallback: string | undefined,
): z.infer<typeof projectChoiceSchema> {
  const targets = items.map((item) => mappings[item.repo.split("/")[0]!.toLowerCase()] ?? fallback);
  if (new Set(targets).size > 1) return { projectId: null, reason: "mixed" };
  const projectId = targets[0];
  if (projectId === undefined) return { projectId: null, reason: "choose" };
  const mapped = items.every((item) => mappings[item.repo.split("/")[0]!.toLowerCase()] !== undefined);
  return { projectId, reason: mapped ? "organization" : "default" };
}
