/** Validate the model response before any names or verdicts reach the cache. */
export type NamedGroupRow = {
  label: string;
  name: string;
  cohesion: "cohesive" | "mixed";
  reason: string | null;
};

export function parseNames(text: string, labels: readonly string[]): NamedGroupRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const groups = (parsed as { groups?: unknown }).groups;
  if (!Array.isArray(groups) || groups.length !== labels.length) return null;
  const expected = new Set(labels);
  const seen = new Set<string>();
  const rows: NamedGroupRow[] = [];
  for (const entry of groups) {
    if (entry === null || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.label !== "string" || !expected.has(record.label) || seen.has(record.label)
      || typeof record.name !== "string"
      || (record.cohesion !== "cohesive" && record.cohesion !== "mixed")
      || (record.reason !== null && typeof record.reason !== "string")
    ) return null;
    const reason = typeof record.reason === "string" && record.reason.trim() !== ""
      ? record.reason.trim().slice(0, 300)
      : null;
    if (record.cohesion === "mixed" && reason === null) return null;
    seen.add(record.label);
    rows.push({ label: record.label, name: record.name, cohesion: record.cohesion, reason });
  }
  return rows;
}

export function namingResponse(
  level: "domain" | "program" | "effort",
  stopReason: string | null,
  text: string,
  labels: readonly string[],
): { names: NamedGroupRow[]; warnings: string[] } {
  if (stopReason === "refusal") {
    return { names: [], warnings: [`Claude declined to name ${level}s; they keep their selected names.`] };
  }
  if (stopReason !== "end_turn") {
    return { names: [], warnings: [`Claude did not finish naming ${level}s; they will be retried on the next scan.`] };
  }
  const names = parseNames(text, labels);
  return names === null
    ? { names: [], warnings: [`Claude returned invalid names for ${level}s; they will be retried on the next scan.`] }
    : { names, warnings: [] };
}
