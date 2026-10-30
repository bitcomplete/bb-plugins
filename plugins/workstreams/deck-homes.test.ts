import { describe, expect, it } from "vitest";
import { threadHome, type ThreadEvidence } from "./deck-homes.js";

const url = (repo: string, number: number) => `https://github.com/inkwell/${repo}/pull/${number}`;
const pr = (repo: string, number: number, effortId: string | null = null) => ({ url: url(repo, number), repo: `inkwell/${repo}`, effortId });
const thread = (patch: Partial<ThreadEvidence>): ThreadEvidence => ({ id: "thr", effortId: null, prs: [], checkout: null, environment: null, ...patch });

describe("where a thread lands on the deck", () => {
  // Explicit efforts always win: a thread you put in an effort, or one it coordinates, stays there whatever else it links.
  it("puts a thread in its own effort first, then in the effort most of its own PRs are in, over any service card", () => {
    expect(threadHome(thread({ effortId: "shelf", prs: [pr("folio", 325), pr("folio", 305)] }))).toEqual({ kind: "effort", id: "shelf" });
    // One PR in Shelf order beats two that no effort owns: an effort is a real home, a service card only a fallback.
    expect(threadHome(thread({ prs: [pr("folio", 340, "shelf"), pr("atlas", 410), pr("atlas", 411)] }))).toEqual({ kind: "effort", id: "shelf" });
    expect(threadHome(thread({ prs: [pr("folio", 340, "shelf"), pr("quill", 210, "pickup"), pr("quill", 211, "pickup")] }))).toEqual({ kind: "effort", id: "pickup" });
    // Two efforts tied: the same one every read, so the thread never jumps between cards.
    expect(threadHome(thread({ prs: [pr("quill", 210, "pickup"), pr("folio", 340, "shelf")] }))).toEqual({ kind: "effort", id: "pickup" });
  });

  it("puts a thread with no effort on the service card of the repository its own PRs are in, or of the checkout only it runs in", () => {
    expect(threadHome(thread({ prs: [pr("folio", 325)] }))).toEqual({ kind: "service", repo: "inkwell/folio" });
    // Merged or open alike: the PR says which repository the thread works in.
    expect(threadHome(thread({ prs: [pr("atlas", 410), pr("atlas", 390), pr("folio", 305)] }))).toEqual({ kind: "service", repo: "inkwell/atlas" });
    expect(threadHome(thread({ checkout: "inkwell/Quill", environment: "inkwell/quill" }))).toEqual({ kind: "service", repo: "inkwell/quill" });
  });

  // The real case: 25 threads ran in one shared clone and would all have landed on whatever PR its branch was then. The server never
  // counts that link, so all such a thread has left is the clone's repository as its environment, which only breaks ties.
  it("leaves a thread whose only link is a checkout it shares loose, rather than on the repository's service card", () => {
    expect(threadHome(thread({ environment: "inkwell/folio" }))).toEqual({ kind: "loose" });
    expect(threadHome(thread({}))).toEqual({ kind: "loose" });
  });

  it("breaks a tie between repositories with the thread's environment, and leaves the thread loose when that says nothing", () => {
    expect(threadHome(thread({ prs: [pr("atlas", 410), pr("catalog", 97)], environment: "inkwell/catalog" }))).toEqual({ kind: "service", repo: "inkwell/catalog" });
    // Its environment isn't one of the tied repositories, or it has none: no repository is more its own than another.
    expect(threadHome(thread({ prs: [pr("atlas", 410), pr("catalog", 97)], environment: "inkwell/folio" }))).toEqual({ kind: "loose" });
    expect(threadHome(thread({ prs: [pr("atlas", 410), pr("folio", 305)] }))).toEqual({ kind: "loose" });
    // A checkout only it runs in doesn't outvote its PRs.
    expect(threadHome(thread({ prs: [pr("atlas", 410), pr("folio", 305)], checkout: "inkwell/quill" }))).toEqual({ kind: "loose" });
  });
});
