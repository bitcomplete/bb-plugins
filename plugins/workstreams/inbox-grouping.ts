import {
  INBOX_SECTIONS,
  INBOX_SECTION_LABEL,
  byInboxOrder,
  type InboxSection,
} from "./workstreams.js";
import type { Row } from "./inbox.js";

export type InboxGrouping = "action" | "effort";
export type RowGroup = { key: string; label: string; rows: Row[]; section: InboxSection | null };

/** Board v2 separates completed checkouts from active rows. */
export function partitionCompletedRows(sections: Map<InboxSection, Row[]>): {
  active: Map<InboxSection, Row[]>;
  merged: Row[];
  inReleaseTag: Row[];
} {
  const active = new Map<InboxSection, Row[]>();
  const merged: Row[] = [];
  const inReleaseTag: Row[] = [];
  for (const [section, rows] of sections) {
    active.set(section, rows.filter((row) => {
      if (row.unit.lifecycle === "merged") { merged.push(row); return false; }
      if (row.unit.lifecycle === "shipped") { inReleaseTag.push(row); return false; }
      return true;
    }));
  }
  return { active, merged, inReleaseTag };
}

/** Folded completion cards do not participate in keyboard row navigation. */
export function visibleCompletedRows(
  completed: Pick<ReturnType<typeof partitionCompletedRows>, "merged" | "inReleaseTag">,
  open: { merged: boolean; inReleaseTag: boolean },
): Row[] {
  return [...(open.merged ? completed.merged : []), ...(open.inReleaseTag ? completed.inReleaseTag : [])];
}

/** Keep action order inside each effort; use the stable group key to distinguish duplicate names. */
export function groupInboxRows(sections: Map<InboxSection, Row[]>, by: InboxGrouping): RowGroup[] {
  if (by === "action") {
    return INBOX_SECTIONS.map((section) => ({
      key: section,
      label: INBOX_SECTION_LABEL[section],
      rows: sections.get(section) ?? [],
      section,
    }));
  }
  const efforts = new Map<string, RowGroup>();
  for (const section of INBOX_SECTIONS) {
    for (const row of sections.get(section) ?? []) {
      let effort = efforts.get(row.effortKey);
      if (effort === undefined) {
        effort = { key: row.effortKey, label: row.effort, rows: [], section: null };
        efforts.set(row.effortKey, effort);
      }
      effort.rows.push(row);
    }
  }
  const priority = (row: Row) => INBOX_SECTIONS.indexOf(row.section);
  const facts = (row: Row) => ({
    repo: row.repo,
    prNumber: row.unit.pr?.number ?? null,
    path: row.unit.path,
    since: row.age.since,
  });
  const groups = [...efforts.values()];
  for (const group of groups) {
    group.rows.sort((a, b) => priority(a) - priority(b) || byInboxOrder(facts(a), facts(b)));
  }
  return groups.sort((a, b) =>
    priority(a.rows[0]!) - priority(b.rows[0]!) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  );
}

/** Keyboard traversal follows the rows currently shown, including folded groups. */
export function visibleInboxRows(groups: readonly RowGroup[], isOpen: (group: RowGroup) => boolean): Row[] {
  return groups.flatMap((group) => isOpen(group) ? group.rows : []);
}

/** Keep completed work under the effort that owns it. */
export function completedByEffort(completed: Pick<ReturnType<typeof partitionCompletedRows>, "merged" | "inReleaseTag">): Map<string, { merged: Row[]; inReleaseTag: Row[] }> {
  const efforts = new Map<string, { merged: Row[]; inReleaseTag: Row[] }>();
  for (const kind of ["merged", "inReleaseTag"] as const) {
    for (const row of completed[kind]) {
      const group = efforts.get(row.effortKey) ?? { merged: [], inReleaseTag: [] };
      group[kind].push(row);
      efforts.set(row.effortKey, group);
    }
  }
  return efforts;
}
