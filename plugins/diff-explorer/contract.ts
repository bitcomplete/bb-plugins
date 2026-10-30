import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const location = z.object({
  path: z.string(),
  line: z.number().int(),
  column: z.number().int(),
});
export type Location = z.infer<typeof location>;

const position = z.object({
  path: z.string().startsWith("/"),
  line: z.number().int().min(1),
  column: z.number().int().min(1),
});

const fileAction = z.object({
  path: z.string().startsWith("/"),
  action: z.enum(["delete", "ignore", "ignore-directory", "ignore-extension", "ignore-local", "ignore-local-directory", "ignore-local-extension"]),
});
export type FileAction = z.infer<typeof fileAction>["action"];

const commitPaths = z.array(z.string().min(1).max(4096)).min(1).max(1000);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const recentCommits = z.array(z.object({ sha: objectId, subject: z.string() })).max(50);
export const commitSnapshot = z.object({ head: objectId.nullable(), branch: z.string().startsWith("refs/heads/"), tree: objectId, index: z.string().regex(/^[0-9a-f]{64}$/) });
export type CommitSnapshot = z.infer<typeof commitSnapshot>;
export const commitJob = z.object({
  root: z.string().startsWith("/"), hostId: z.string(), environmentId: z.string(), paths: commitPaths, push: z.boolean(),
  status: z.enum(["pending", "reviewed", "finishing", "done", "failed"]), snapshot: commitSnapshot.optional(),
});
const commitResult = z.object({ commit: objectId.nullable(), pushed: z.boolean(), error: z.string().nullable() });

export const hostContract = defineRpcContract({
  commits: {
    input: z.object({ root: z.string().startsWith("/") }),
    output: recentCommits,
  },
  reviewCommit: {
    input: z.object({ root: z.string().startsWith("/"), paths: commitPaths, snapshot: commitSnapshot.optional() }),
    output: z.object({ snapshot: commitSnapshot, diff: z.string() }),
  },
  finishCommit: {
    input: z.object({ root: z.string().startsWith("/"), paths: commitPaths, snapshot: commitSnapshot, messageFile: z.string().startsWith("/"), push: z.boolean() }),
    output: commitResult,
  },
  fileAction: {
    input: fileAction.extend({ root: z.string().startsWith("/") }),
    output: z.null(),
  },
  definition: {
    input: position.extend({ root: z.string().startsWith("/"), content: z.string() }),
    output: z.object({ locations: z.array(location) }),
  },
  read: {
    input: z.object({ path: z.string().startsWith("/") }),
    output: z.object({ content: z.string() }),
  },
  write: {
    input: z.object({ path: z.string().startsWith("/"), content: z.string(), expected: z.string() }),
    output: z.null(),
  },
  warm: {
    input: z.object({ root: z.string().startsWith("/"), paths: z.array(z.string().startsWith("/")) }),
    output: z.null(),
  },
  watch: {
    input: z.object({ root: z.string().startsWith("/") }),
    output: z.null(),
  },
});

export const changedPayload = z.object({ root: z.string() });
export const hostSignals = { changed: { payload: changedPayload } };

const diffFile = z.object({
  path: z.string(),
  changeKind: z.string(),
  additions: z.number(),
  deletions: z.number(),
  oldText: z.string(),
  newText: z.string(),
});
export type DiffFile = z.infer<typeof diffFile>;

const diffTarget = z.union([z.enum(["all", "uncommitted"]), objectId]);

// Keep diagnostics JSON-only and bounded below KV's 256 KB limit.
const reportSetup = z.object({
  threadId: z.string().min(1).max(128),
  pluginVersion: z.string().max(64),
}).catchall(z.json()).refine((setup) => JSON.stringify(setup).length <= 64 * 1024, "Report is too large");
const report = z.object({ id: z.string(), createdAt: z.string(), threadId: z.string(), setup: reportSetup });
export type Report = z.infer<typeof report>;
const reportSummary = report.omit({ setup: true });

export const rpcContract = defineRpcContract({
  commits: {
    input: z.object({ threadId: z.string() }),
    output: recentCommits,
  },
  commit: {
    input: z.object({ threadId: z.string().min(1), push: z.boolean(), paths: commitPaths.optional() }),
    output: z.object({ threadId: z.string() }),
  },
  report: { input: reportSetup, output: reportSummary },
  reports: { input: z.null(), output: z.array(reportSummary).max(20) },
  getReport: { input: z.object({ id: z.string().min(1).max(80) }), output: report },
  fileAction: {
    input: fileAction.extend({ environmentId: z.string() }),
    output: z.null(),
  },
  assets: {
    input: z.null(),
    output: z.object({ baseUrl: z.string() }),
  },
  load: {
    input: z.object({ threadId: z.string(), target: diffTarget }),
    output: z.object({
      environmentId: z.string(),
      root: z.string(),
      baseBranch: z.string(),
      files: z.array(diffFile),
      skipped: z.array(z.string()),
    }),
  },
  definition: {
    input: position.extend({ environmentId: z.string(), content: z.string() }),
    output: z.object({ locations: z.array(location) }),
  },
  read: {
    input: z.object({ environmentId: z.string(), path: z.string().startsWith("/") }),
    output: z.object({ content: z.string() }),
  },
  write: {
    input: z.object({ environmentId: z.string(), path: z.string().startsWith("/"), content: z.string(), expected: z.string() }),
    output: z.null(),
  },
});
