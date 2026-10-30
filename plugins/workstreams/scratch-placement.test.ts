import { expect, it } from "vitest";
import { rejectedScratchPlacement } from "./scratch-placement.js";

it("releases claims only for BB's definitive workspace refusal", () => {
  const refusal = "Workspace path is inside bb-managed storage but is not a workspace of this project";
  expect(rejectedScratchPlacement(new Error(`HTTP 409: ${refusal}`))).toBe(true);
  expect(rejectedScratchPlacement(Object.assign(new Error(refusal), { status: 409 }))).toBe(true);
  expect(rejectedScratchPlacement(Object.assign(new Error(refusal), { status: 500 }))).toBe(false);
  expect(rejectedScratchPlacement(new Error("HTTP 409: request failed after spawn"))).toBe(false);
});
