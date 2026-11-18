import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MIGRATIONS } from "../src/store.js";
it("preserves the index and exact text of every shipped migration", () => {
  const hashes = MIGRATIONS.map(sql => createHash("sha256").update(sql).digest("hex"));
  const shipped = JSON.parse(readFileSync(new URL("../migrations.snapshot.json", import.meta.url), "utf8"));
  expect(hashes).toEqual(shipped);
});
