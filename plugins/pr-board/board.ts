// The board's data: the view model simple.py prints, the playbook check playbook.py prints, and the
// Python runs that produce them.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

export const actionSchema = z.enum(["fix-feedback", "rebase", "fix-ci"]);
export const stopSchema = z.enum(["prepare", "publish"]);
export type Action = z.infer<typeof actionSchema>;
export type Stop = z.infer<typeof stopSchema>;

const rowSchema = z.object({
  key: z.string(),
  number: z.number().int(),
  url: z.string().url(),
  area: z.string(),
  tone: z.number().int().min(0),
  title: z.string(),
  sentence: z.string(),
  blocked: z.string().nullable(),
  depth: z.number().int().min(0),
  after: z.object({ number: z.number().int(), url: z.string().url() }).nullable(),
  reviewers: z.array(z.object({ name: z.string(), state: z.enum(["requested", "approved", "approved_old", "changes"]) })),
  size: z.object({ lines: z.number().int(), files: z.number().int(), bar: z.number(), label: z.string() }),
  stack: z.string().nullable(),
  action: actionSchema.nullable(),
});

export const viewModelSchema = z.object({
  fetched_at: z.string(),
  summary: z.object({
    work: z.number().int(),
    ready: z.number().int(),
    mine: z.number().int(),
    theirs: z.number().int(),
    drafts: z.number().int(),
    other: z.number().int(),
  }),
  suggestions: z.array(
    z.object({ id: z.string(), text: z.string(), action: actionSchema.nullable(), keys: z.array(z.string()) }),
  ),
  trains: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      prs: z.array(
        z.object({
          key: z.string(),
          number: z.number().int(),
          url: z.string().url(),
          letter: z.string(),
          state: z.string(),
          title: z.string(),
          sentence: z.string(),
        }),
      ),
    }),
  ),
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      count: z.number().int(),
      open: z.boolean(),
      groups: z.array(z.object({ title: z.string().nullable(), rows: z.array(rowSchema) })),
    }),
  ),
  reviewer_load: z.object({
    reviewers: z.array(
      z.object({
        name: z.string(),
        count: z.number().int(),
        first: z.number().int(),
        re: z.number().int(),
        oldest_days: z.number().int(),
        approx: z.boolean(),
        keys: z.array(z.string()),
      }),
    ),
    none: z.object({ count: z.number().int(), keys: z.array(z.string()) }),
  }),
});

/** What the panel shows for a PR an agent thread was started on (see markers.ts). */
export const markerViewSchema = z.object({
  key: z.string(),
  status: z.enum(["starting", "live", "done", "refused"]),
  threadId: z.string().nullable(),
  title: z.string().nullable(),
  at: z.string(),
  reason: z.string().nullable(),
});

export const stateSchema = z.object({
  view: viewModelSchema.nullable(),
  lastSuccess: z.string().nullable(),
  lastError: z.string().nullable(),
  refreshing: z.boolean(),
  markers: z.array(markerViewSchema),
});

export type ViewModel = z.infer<typeof viewModelSchema>;
export type BoardState = z.infer<typeof stateSchema>;
export type MarkerView = z.infer<typeof markerViewSchema>;

export const preparedSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), title: z.string(), prompt: z.string(), head_oid: z.string(), move: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type Prepared = z.infer<typeof preparedSchema>;

/** The Python steps. Each throws with a one-line, user-readable reason. */
export interface Runner {
  /** Fetch every open PR from GitHub and derive facts: the text of data.json. */
  fetch(signal: AbortSignal): Promise<string>;
  /** The view model for a data.json, leaving `busy` PR keys out of suggestions. */
  view(data: string, busy: string[], signal: AbortSignal): Promise<ViewModel>;
  /** Re-check one PR against data.json and fill its playbook, or say why not. */
  prepare(data: string, request: { key: string; expect: Action; stop: Stop }, signal: AbortSignal): Promise<Prepared>;
}

const run = promisify(execFile);
const TIMEOUT_MS = 4 * 60_000;

/** The directory holding the Python scripts, playbooks and gates.json (the plugin root, also when loaded from dist/). */
export function pluginDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === "dist" ? dirname(here) : here;
}

function reason(cause: unknown): string {
  const failed = z.object({ code: z.unknown().optional(), stderr: z.string().optional() }).safeParse(cause);
  if (failed.success && failed.data.code === "ENOENT") return "python3 is not installed or not on PATH";
  const stderr = failed.success ? failed.data.stderr?.trim() : undefined;
  if (stderr) return stderr.split("\n").slice(-3).join(" ").slice(0, 500);
  return cause instanceof Error ? cause.message : String(cause);
}

/** Parse a script's JSON output, failing with one readable line instead of a schema dump. */
function parseOutput<T>(schema: z.ZodType<T>, script: string, stdout: string): T {
  const parsed = schema.safeParse(JSON.parse(stdout));
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(`${script} printed unexpected output at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`);
}

export function pythonRunner(dir: string = pluginDir()): Runner {
  const python = async (args: string[], signal: AbortSignal) => {
    try {
      const { stdout } = await run("python3", args, { cwd: dir, signal, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (cause) {
      throw new Error(reason(cause));
    }
  };
  /** Runs `use` with a temp directory, writing `data` to data.json first when given. */
  const withDir = async <T>(data: string | null, use: (out: string) => Promise<T>) => {
    const out = await mkdtemp(join(tmpdir(), "pr-board-"));
    try {
      if (data !== null) await writeFile(join(out, "data.json"), data);
      return await use(out);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  };
  return {
    fetch: (signal) =>
      withDir(null, async (out) => {
        await python([join(dir, "build.py"), "--out", out], signal);
        return readFile(join(out, "data.json"), "utf8");
      }),
    view: (data, busy, signal) =>
      withDir(data, async (out) => {
        const args = [join(dir, "simple.py"), "--json", "--data", join(out, "data.json"), "--busy", JSON.stringify(busy)];
        return parseOutput(viewModelSchema, "simple.py", await python(args, signal));
      }),
    prepare: (data, { key, expect, stop }, signal) =>
      withDir(data, async (out) => {
        const args = [join(dir, "playbook.py"), "--data", join(out, "data.json"), "--key", key, "--expect", expect, "--stop", stop];
        return parseOutput(preparedSchema, "playbook.py", await python(args, signal));
      }),
  };
}
