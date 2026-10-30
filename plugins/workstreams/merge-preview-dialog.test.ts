import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { blockers, mergeBlocked, mergeInOrder, MergePreviewBody, mergeTrigger, type MergeItem, type MergePreview } from "./merge-preview-dialog";

const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&#x27;/gu, "'").replace(/\s+/gu, " ").trim();
const fresh = (head: string, patch: Partial<MergePreview> = {}): MergePreview => ({ ok: true, live: { state: "OPEN", isDraft: false, reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN", headRefOid: head.padEnd(40, "0"), stackedAbove: [], unresolvedThreads: 0, unresolvedAtLeast: false, approvalNotes: [], approvalNotesMore: 0,
  approvalNotesComplete: true }, refusals: [], warnings: [], method: "squash",
  deleteBranch: true, ...patch });
const item = (n: number, number: number, preview: MergeItem["preview"]): MergeItem =>
  ({ n, target: `https://github.com/inkwell/spine/pull/${number}`, repo: "spine", number, title: `PR ${n}`, preview, result: null });
const nine = item(9, 212, fresh("a41c9e0", { live: { ...fresh("a41c9e0").live, stackedAbove: [215, 217] } }));
const sixteen = item(16, 192, fresh("9c2f1e7"));
const held = { ...sixteen, preview: fresh("9c2f1e7", { refusals: ["On hold. Release the hold before advancing or merging this PR."] }) };

describe("the fresh merge preview", () => {
  it("merges only on a pointer click or ⌘↵, and refuses Enter or Space on its button", () => {
    expect(mergeTrigger({ kind: "click", detail: 0 })).toBe("refuse");
    expect(mergeTrigger({ kind: "click", detail: 1 })).toBe("merge");
    expect(mergeTrigger({ kind: "key", key: "Enter", metaKey: false, ctrlKey: false })).toBeNull();
    expect(mergeTrigger({ kind: "key", key: " ", metaKey: false, ctrlKey: false })).toBeNull();
    expect(mergeTrigger({ kind: "key", key: "Enter", metaKey: true, ctrlKey: false })).toBe("merge");
    expect(mergeTrigger({ kind: "key", key: "Enter", metaKey: false, ctrlKey: true })).toBe("merge");
  });

  it("merges in number order and stops at the first failure", async () => {
    const both = new Set([sixteen.target, nine.target]);
    const tried: (number | null)[] = [];
    const ok = await mergeInOrder([sixteen, nine], both, async (entry) => { tried.push(entry.n); return { ok: true, text: "merged" }; });
    expect(tried).toEqual([9, 16]);
    expect([...ok.values()].every((result) => result.ok)).toBe(true);
    tried.length = 0;
    const failed = await mergeInOrder([sixteen, nine], both, async (entry) => { tried.push(entry.n); throw new Error("Head moved since the preview"); });
    expect(tried).toEqual([9]);
    expect(failed.get(nine.target)).toEqual({ ok: false, text: "Head moved since the preview" });
    expect(failed.has(sixteen.target)).toBe(false);
  });

  it("keeps Merge disabled while GitHub is read, with nothing picked, or while a picked PR has a refusal", () => {
    expect(mergeBlocked([nine, { ...sixteen, preview: null }], new Set([nine.target]))).toBe("Reading GitHub…");
    expect(mergeBlocked([nine, sixteen], new Set())).toBe("Pick a PR to merge");
    expect(mergeBlocked([nine, held], new Set([nine.target, held.target]))).toBe("16 can't merge: On hold. Release the hold before advancing or merging this PR.");
    expect(mergeBlocked([nine, held], new Set([nine.target]))).toBeNull();
    // A batch never acknowledges unresolved threads for you, and a failed read can't merge.
    expect(blockers(item(9, 212, fresh("a41c9e0", { live: { ...fresh("a41c9e0").live, unresolvedThreads: 2 } }))))
      .toEqual(["2 unresolved review threads; merge it from its own preview to acknowledge them"]);
    expect(blockers(item(9, 212, { ok: false, error: "rate limited" }))).toEqual(["GitHub read failed: rate limited"]);
  });

  it("shows each PR's fresh facts, leaves a refused PR unpicked, and says Enter doesn't merge", () => {
    const refusedPicked = renderToStaticMarkup(createElement(MergePreviewBody, { items: [nine, held], selected: new Set([nine.target, held.target]), busy: false,
      notice: null, onToggle: noop, onMerge: noop, onCancel: noop, onOpenUrl: noop }));
    expect(refusedPicked.match(/<button[^>]*data-merge-go[^>]*>/u)?.[0]).toContain('disabled=""');
    const html = renderToStaticMarkup(createElement(MergePreviewBody, { items: [nine, held], selected: new Set([nine.target]), busy: false,
      notice: "Merging needs ⌘↵ or a click; Enter alone doesn't merge", onToggle: noop, onMerge: noop, onCancel: noop, onOpenUrl: noop }));
    expect(text(html)).toContain("9 spine #212 PR 9 head a41c9e0 · open · approved · CLEAN · then #215, #217 retarget");
    expect(html).toMatch(/aria-checked="false"[^>]*disabled=""[^>]*aria-label="Merge 16"|disabled=""[^>]*aria-checked="false"[^>]*aria-label="Merge 16"/u);
    expect(text(html)).toContain("On hold. Release the hold before advancing or merging this PR.");
    const go = html.match(/<button[^>]*data-merge-go[^>]*>/u)?.[0] ?? "";
    expect(go).toContain('title="Click, or press ⌘↵. Merging needs ⌘↵ or a click; Enter alone doesn&#x27;t merge."');
    expect(go).not.toContain('disabled=""');
    expect(text(html)).toContain("Merge 1 PR ⌘↵ Cancel Merging needs ⌘↵ or a click; Enter alone doesn't merge");
    expect(html).not.toContain("Written approval history");
  });

  it("shows what approvers wrote and warns when the review history is incomplete, as the row's own merge preview does", () => {
    const noted = item(9, 212, fresh("a41c9e0", { live: { ...fresh("a41c9e0").live, approvalNotesMore: 1, approvalNotesComplete: false,
      approvalNotes: [{ author: "tobyk", body: "Approving; keep the shelf label fallback before this ships", submittedAt: "2026-09-27T15:04:00Z", truncated: true }] } }));
    const html = text(renderToStaticMarkup(createElement(MergePreviewBody, { items: [noted, sixteen], selected: new Set([noted.target]), busy: false, notice: null,
      onToggle: noop, onMerge: noop, onCancel: noop, onOpenUrl: noop })));
    expect(html).toContain("Written approval history. These notes may have been addressed since the review. Check their requests before merging. tobyk ·");
    expect(html).toContain("Approving; keep the shelf label fallback before this ships… 1 older written approval on GitHub. "
      + "Review history is incomplete. Check all reviews on GitHub before merging.");
    // It informs the merge rather than gating it: the server's refusals gate unverified feedback.
    expect(mergeBlocked([noted, sixteen], new Set([noted.target]))).toBeNull();
    expect(html.match(/Written approval history/gu)).toHaveLength(1);
  });
});
