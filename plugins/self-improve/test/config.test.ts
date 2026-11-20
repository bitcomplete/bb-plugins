import { expect, it } from "vitest";
import { checkConfig, defaultConfig, parseConfig } from "../src/config.js";
import { improvementScope, projectReceivesImprovements, recordedImprovementScope } from "../src/improvements.js";
import { stageErrorHelp } from "../src/stage-errors.js";

it("names the failing field when a configuration is invalid", () => {
  expect(() => checkConfig({ budgets: { currency: "dollars" } })).toThrow(/^Invalid configuration at budgets\.currency: /);
  expect(() => parseConfig("{")).toThrow("Invalid configuration: not valid JSON");
});

it("keeps settings saved by earlier versions readable", () => {
  const saved = { ...defaultConfig(), publicationRepositories: ["org/repo"], experimentalParentLinks: false, experimentalMatchAudit: false };
  expect(parseConfig(JSON.stringify(saved))).toEqual(defaultConfig());
  expect(saved.publicationRepositories).toEqual(["org/repo"]);
});

it("decides which projects receive improvements in one place", () => {
  expect(improvementScope([])).toBe("all-except-worker");
  expect(projectReceivesImprovements("worker", [], "worker")).toBe(false);
  expect(projectReceivesImprovements("other", [], "worker")).toBe(true);
  expect(projectReceivesImprovements("worker", ["worker"], "worker")).toBe(true);
  expect(projectReceivesImprovements("other", ["listed"], "worker")).toBe(false);
  expect(recordedImprovementScope([])).toEqual(["all-projects"]);
  expect(recordedImprovementScope(["listed"])).toEqual(["listed"]);
});

it("explains recorded stage codes in plain language", () => {
  expect(stageErrorHelp("configure-bb-provider-model-project-environment")).toBe("Execution isn't set up");
  expect(stageErrorHelp("native-task-timeout,invalid-model-json")).toBe("an agent session took longer than `taskTimeoutMs`; the model's answer couldn't be read");
  expect(stageErrorHelp("something-new")).toBe("something-new");
});
