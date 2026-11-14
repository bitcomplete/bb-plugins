// The template stamp (BB-328): the `<name>@<hash>` a playbook copied from a
// shipped template carries in its front matter, and the warnings `check`
// raises when the copy has drifted from the template it came from.
//
// The hash is of the shipped template text, never of the project copy, so a
// project's own edits leave the stamp's hash alone. Pure, and deliberately
// free of imports, so both `config.ts` (which parses the key) and
// `templates.ts` (which writes it) can use it without a cycle.
import { createHash } from "node:crypto";

/** The short hash of a shipped template's text, as the stamp records it. */
export function templateHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** A `template: <name>@<hash>` stamp: a playbook name, an `@`, and a hex hash. */
export const TEMPLATE_STAMP = /^([a-z0-9][a-z0-9-]{0,62})@([0-9a-f]{6,64})$/u;

/** A parsed stamp, or null when the value is not one. */
export function parseTemplateStamp(value: string): { name: string; hash: string } | null {
  const m = TEMPLATE_STAMP.exec(value.trim());
  return m === null ? null : { name: m[1]!, hash: m[2]! };
}

/** A finding `check` reports: a `warning:` (does not fail the check) or a `problem:` (does). */
export type CheckFinding = { level: "warning" | "problem"; text: string };

/**
 * The template warnings for a project's playbooks (BB-328). One line per
 * playbook, however many load paths reached it: a stamp whose hash differs
 * from the shipped template's is lag; a stamp naming a template that no
 * longer exists is a warning; a playbook with no stamp is "unknown origin".
 * `templateHashes` maps a template name to the current hash of its shipped
 * text, so the reader stays injectable for tests.
 */
export function templateWarnings(
  playbooks: Iterable<{ name: string; template: { name: string; hash: string } | null }>,
  templateHashes: ReadonlyMap<string, string>,
): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const p of playbooks) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    if (p.template === null) {
      warnings.push(`${p.name} has no template stamp, so its origin is unknown`);
      continue;
    }
    const current = templateHashes.get(p.template.name);
    if (current === undefined) {
      warnings.push(`${p.name} was copied from template ${p.template.name}, which no longer exists`);
      continue;
    }
    if (p.template.hash !== current) warnings.push(`${p.name} was copied from template ${p.template.hash}; current is ${current}.`);
  }
  return warnings;
}
