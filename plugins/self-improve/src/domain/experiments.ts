import type { Experiment } from "./types.js";
import { finite, integer, stableId, text } from "./shared.js";

export function preregisterExperiment(experiment: Experiment): Experiment {
  text(experiment.id, "experiment ID"); text(experiment.metric, "preregistered metric"); text(experiment.seed, "assignment seed");
  finite(experiment.preregisteredAtMs, "preregistration time"); finite(experiment.startsAtMs, "start"); finite(experiment.endsAtMs, "end"); integer(experiment.sampleSize, "sample size", 1);
  if (experiment.startsAtMs <= experiment.preregisteredAtMs || experiment.endsAtMs <= experiment.startsAtMs) throw new Error("preregister before the experiment starts and specify a positive duration");
  if (!experiment.blindedOwnerRatings) throw new Error("owner relevance ratings must be blinded");
  return structuredClone(experiment);
}
export function blindRatingLabel(experiment: Experiment, evidenceId: string, variant: "abstract" | "concrete"): string {
  text(evidenceId, "evidence ID");
  return stableId("rating", [experiment.id, experiment.seed, evidenceId, variant]);
}
export function assignWording(experiment: Experiment, evidenceId: string): Array<{ evidenceId: string; variant: "abstract" | "concrete"; blindLabel: string }> {
  preregisterExperiment(experiment); text(evidenceId, "evidence ID");
  const order = parseInt(stableId("order", [experiment.seed, evidenceId]).slice(-2), 16) % 2 === 0 ? ["abstract", "concrete"] as const : ["concrete", "abstract"] as const;
  return order.map(variant => ({ evidenceId, variant, blindLabel: blindRatingLabel(experiment, evidenceId, variant) }));
}
