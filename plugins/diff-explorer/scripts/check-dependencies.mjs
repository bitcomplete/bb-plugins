import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
assert.equal(pkg.packageManager, "pnpm@10.34.6");
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  assert.deepEqual(lock.packages[""][field] ?? {}, pkg[field] ?? {}, `${field}: npm compatibility lock is stale`);
  for (const [name, version] of Object.entries(pkg[field] ?? {})) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `${name}: use an exact version`);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name}: npm compatibility lock is stale`);
  }
}
for (const [name, version] of Object.entries(pkg.overrides ?? {})) {
  assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name}: npm compatibility override is stale`);
}
