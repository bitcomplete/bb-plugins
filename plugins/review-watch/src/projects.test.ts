import { describe, expect, it } from "vitest";
import { parseOrganizationProjects, suggestedProject } from "./projects.js";

describe("organization project mappings", () => {
  it("normalizes organization names and validates the configuration", () => {
    expect(parseOrganizationProjects('{"ParsleyHealth":"proj_parsley"}')).toEqual({ parsleyhealth: "proj_parsley" });
    for (const value of ["not JSON", '[]', '{"owner":42}', '{"owner/repo":"p"}', '{"owner":""}']) {
      expect(() => parseOrganizationProjects(value)).toThrow();
    }
    expect(() => parseOrganizationProjects('{"owner":"one","OWNER":"two"}')).toThrow("Conflicting");
  });
  it("chooses the mapping, the fallback, or an explicit choice for a mixed batch", () => {
    const mappings = parseOrganizationProjects('{"parsleyhealth":"parsley","bitcomplete":"bitcomplete"}');
    const parsley = { repo: "ParsleyHealth/sage" }, other = { repo: "elsewhere/repo" };
    expect(suggestedProject([parsley], mappings, "default")).toEqual({ projectId: "parsley", reason: "organization" });
    expect(suggestedProject([other], mappings, "default")).toEqual({ projectId: "default", reason: "default" });
    expect(suggestedProject([other], mappings, undefined)).toEqual({ projectId: null, reason: "choose" });
    expect(suggestedProject([parsley, other], mappings, "default")).toEqual({ projectId: null, reason: "mixed" });
    expect(suggestedProject([parsley, other], mappings, "parsley")).toEqual({ projectId: "parsley", reason: "default" });
  });
});
