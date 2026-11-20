const MASK = "[revalidation record: read with self_improve_revalidation_read]";
/**
 * Revalidation records hold planned expected answers and frozen artifact text. The editing chat reads those only
 * through the per-solution revalidation tool; the general audit view shows that a change happened, not its content.
 */
export function chatAuditRow<T extends Record<string, unknown>>(row: T): T {
  if (typeof row.namespace !== "string" || !row.namespace.startsWith("revalidation")) return row;
  return { ...row, before_value: row.before_value === "null" || row.before_value == null ? null : MASK, after_value: MASK };
}
