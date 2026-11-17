import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { MIGRATIONS } from "./server";

it("preserves every shipped migration index and snapshots appended statements", () => {
  const recorded = z.array(z.string()).parse(JSON.parse(readFileSync(new URL("./migrations.snapshot.json", import.meta.url), "utf8")));
  expect(MIGRATIONS.map((sql) => createHash("sha256").update(sql).digest("hex"))).toEqual(recorded);
});
