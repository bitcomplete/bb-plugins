import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { viewModelSchema } from "./board";
import { MIGRATIONS } from "./server";

it("validates the actual Python model on the TypeScript RPC boundary, including checks, gates, and other repos", () => {
  const output = execFileSync("python3", ["-c", `import json
from test_simple import board, pr, failing, MONO
print(json.dumps(board(pr(1,"ready",approvals={"current":[],"stale":["flasd"]}), failing(2,gates=["Staging"],gate_links=[{"label":"Staging","cleared_by":"acme/repo#7"}],checks=[{"name":"unit","status":"COMPLETED","conclusion":"SUCCESS","url":None}]),pr(3,"draft",repo="acme/repo"))))`], { cwd: new URL(".", import.meta.url), env: { ...process.env, TZ: "UTC" }, timeout: 5000, encoding: "utf8" });
  const model = viewModelSchema.parse(JSON.parse(output));
  expect(model.prs).toHaveLength(3);
  expect(new Set(model.prs.map((row) => row.key)).size).toBe(3);
  expect(model.prs.find((row) => row.number === 2)).toMatchObject({ group: "blocked", checks: [{ name: "unit", state: "pass", url: null }], gate_links: [{ cleared_by: "acme/repo#7" }] });
  expect(model.prs.find((row) => row.number === 3)).toMatchObject({ repo: "acme/repo", segment: "drafts" });
});

it("keeps every shipped database migration at its recorded index", () => {
  const snapshot = z.array(z.string()).parse(JSON.parse(readFileSync(new URL("./migrations.snapshot.json", import.meta.url), "utf8")));
  expect(MIGRATIONS.map((sql) => createHash("sha256").update(sql).digest("hex"))).toEqual(snapshot);
});
