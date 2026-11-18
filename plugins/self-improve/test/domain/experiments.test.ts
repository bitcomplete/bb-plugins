import { describe, expect, it } from "vitest";
import { preregisterExperiment, assignWording, blindRatingLabel } from "../../src/domain/experiments.js";
import { DAY, NOW } from "./fixtures.js";
describe("pre-registered paired wording experiment", () => {
  const spec = { id: "exp-one", preregisteredAtMs: NOW, startsAtMs: NOW + DAY, endsAtMs: NOW + 29 * DAY, sampleSize: 100, metric: "Paper candidates built and reducing votes; blinded relevance ratings", blindedOwnerRatings: true, seed: "fixed-seed" };
  it("locks sample/duration/metric before assignment", () => {
    expect(preregisterExperiment(spec)).toEqual(spec);
    expect(() => preregisterExperiment({ ...spec, startsAtMs: NOW - 1 })).toThrow();
    expect(() => preregisterExperiment({ ...spec, sampleSize: 0 })).toThrow();
  });
  it("pairs variants on the same evidence without exposing wording in rating labels", () => {
    const one = assignWording(spec, "evidence-a"), replay = assignWording(spec, "evidence-a");
    expect(one).toEqual(replay);
    expect(new Set(one.map(x => x.variant))).toEqual(new Set(["abstract", "concrete"]));
    expect(one.every(x => x.evidenceId === "evidence-a")).toBe(true);
    expect(blindRatingLabel(spec, "evidence-a", "abstract")).not.toMatch(/abstract|concrete/);
    expect(blindRatingLabel(spec, "evidence-a", "abstract")).not.toBe(blindRatingLabel(spec, "evidence-a", "concrete"));
  });
});
