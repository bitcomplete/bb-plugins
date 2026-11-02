import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./store.js";

/**
 * The plugin SDK records the sha256 of every migration statement by index in
 * each server's store and refuses to start the plugin when a recorded index no
 * longer matches ("append a new migration instead of changing or reusing an
 * index"). So the list is append-only across releases: a statement may only be
 * added after the last one, never inserted into an earlier group, edited or
 * removed. #239 inserted two statements into BASE_MIGRATIONS, shifted every
 * later index, and no server with an existing store could open it.
 *
 * `migrations.snapshot.json` is the hash of every statement as shipped. To add
 * a migration, append its hash to the end of the file; a diff that changes or
 * removes a line is the bug this test is for.
 */
describe("the migration list is append-only", () => {
  const snapshot = JSON.parse(readFileSync(new URL("./migrations.snapshot.json", import.meta.url), "utf8")) as string[];
  const hashes = MIGRATIONS.map((sql) => createHash("sha256").update(sql).digest("hex"));

  it("keeps every shipped migration at its recorded index", () => {
    snapshot.forEach((recorded, index) => {
      expect({ index, hash: hashes[index], statement: MIGRATIONS[index] }).toEqual({ index, hash: recorded, statement: MIGRATIONS[index] });
    });
  });

  it("has a snapshot entry for every migration (append the new hashes to migrations.snapshot.json)", () => {
    expect(hashes.slice(snapshot.length)).toEqual([]);
  });
});
