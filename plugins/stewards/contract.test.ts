// The contract is copied into linear and github-watcher; the copies must not drift.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isMissingPlugin, signatureLine, signedBy } from "./source-contract.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

describe("source-contract.ts", () => {
  for (const sibling of ["linear", "github-watcher"]) {
    const path = here(`../${sibling}/source-contract.ts`);
    it.skipIf(!existsSync(path))(`is byte-identical in ${sibling}`, () => {
      expect(readFileSync(path, "utf8")).toBe(readFileSync(here("./source-contract.ts"), "utf8"));
    });
  }

  it("reads the last signature in a body", () => {
    expect(signedBy(`hello\n\n${signatureLine("thr_abc")}`)).toBe("thr_abc");
    expect(signedBy(`> ${signatureLine("thr_old")}\n\nreply\n\n${signatureLine("thr_new")}`)).toBe("thr_new");
    expect(signedBy("no signature")).toBeNull();
  });

  it("tells a missing plugin from a failing one", () => {
    expect(isMissingPlugin(Object.assign(new Error("x"), { status: 404 }))).toBe(true);
    expect(isMissingPlugin(new Error("plugin stewards is not installed"))).toBe(true);
    expect(isMissingPlugin(Object.assign(new Error("boom"), { code: "handler_error" }))).toBe(false);
  });
});
