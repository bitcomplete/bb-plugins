// Text shared by the panel and the CLI. Per-PR sentences come from simple.py; this only joins them.
import type { BoardState, ViewModel } from "./board";

/** The summary sentence as text and counts, so the panel can set the counts in bold. */
export function summaryParts({ work, ready, held, mine, theirs, drafts }: ViewModel["summary"]): (string | number)[] {
  return [work, " open Parsley PRs: ", ready, " can merge, ", ...(held ? [held, " approved but held, "] : []),
    mine, " need you, ", theirs, " wait on a reviewer, ", drafts, " are drafts."];
}

export function summaryLine(summary: ViewModel["summary"]): string {
  return summaryParts(summary).join("");
}

export function boardText(state: BoardState): string {
  const lines: string[] = [];
  if (state.view) {
    lines.push(summaryLine(state.view.summary), `As of ${state.view.fetched_at}`);
    if (state.view.suggestions.length > 0) {
      lines.push("", "Suggested next steps");
      for (const suggestion of state.view.suggestions) lines.push(`  - ${suggestion.text}`);
    }
    for (const section of state.view.sections) {
      lines.push("", `${section.title} (${section.count})`);
      for (const group of section.groups) {
        if (group.title !== null) lines.push(`  ${group.title}`);
        const indent = group.title === null ? "  " : "    ";
        for (const row of group.rows) {
          const nest = row.depth > 0 ? `${"  ".repeat(row.depth - 1)}└ ` : "";
          const after = row.after ? ` (after #${row.after.number})` : "";
          lines.push(`${indent}${nest}#${row.number} ${row.title} [${row.area}] — ${row.sentence}${after}`);
          if (row.blocked) lines.push(`${indent}${"  ".repeat(row.depth)}  Blocked by: ${row.blocked}`);
        }
      }
    }
  } else {
    lines.push(state.refreshing ? "The first refresh is running." : "No board yet.");
  }
  if (state.lastError) lines.push("", `Last refresh failed: ${state.lastError}`);
  return lines.join("\n");
}
