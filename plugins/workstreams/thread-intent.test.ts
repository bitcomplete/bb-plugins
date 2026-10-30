import { expect, it } from "vitest";
import { confirmedPrCohorts, confirmedThreadPrUrls } from "./thread-intent.js";

const a = "https://github.com/inkwell/folio/pull/42";
const b = "https://github.com/inkwell/folio/pull/43";
const c = "https://github.com/inkwell/folio/pull/44";

it("discovers only recorded PRs and an exact checkout, including completed actions", () => {
  expect(confirmedThreadPrUrls({ metadata: { linkedPrUrl: `${a}/?view=files`, prUrl: b }, recordedUrls: [c],
    environmentPath: "/p/folio-42/", scanned: [{ path: "/p/folio-42", pr: { url: a } },
      { path: "/p/folio-42-other", pr: { url: "https://github.com/inkwell/folio/pull/45" } }],
    knownUrls: [a, b, c] })).toEqual([a, b, c]);
  expect(confirmedThreadPrUrls({ metadata: {}, recordedUrls: [], environmentPath: "/p/folio-42/child",
    scanned: [{ path: "/p/folio-42", pr: { url: a } }], knownUrls: [a] })).toEqual([]);
});

it("claims only confirmed PRs while guarding connected ticket siblings", () => {
  expect(confirmedPrCohorts([a, b], [{ key: a, tickets: ["ABC-101"] }, { key: b, tickets: ["ABC-101", "ABC-202"] },
    { key: c, tickets: ["ABC-202"] }])).toEqual([{ members: { tickets: ["ABC-101", "ABC-202"], prUrls: [a, b] },
    guard: { tickets: ["ABC-101", "ABC-202"], prUrls: [a, b, c] } }]);
  expect(confirmedPrCohorts([a], [{ key: a, tickets: ["ABC-101"] }, { key: b, tickets: ["ABC-101", "ABC-202"] },
    { key: c, tickets: ["ABC-202"] }])).toEqual([{ members: { tickets: ["ABC-101"], prUrls: [a] },
    guard: { tickets: ["ABC-101", "ABC-202"], prUrls: [a, b, c] } }]);
});
