import {
  INBOX_SECTIONS,
  INBOX_SECTION_LABEL,
  byInboxOrder,
  type InboxSection,
} from "./workstreams.js";
import type { Row } from "./inbox.js";

export type InboxGrouping = "action" | "effort";
export type RowGroup = { key: string; label: string; rows: Row[]; section: InboxSection | null };

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
