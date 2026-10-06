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

export const hostContract = defineRpcContract({
  definition: {
    input: position.extend({ root: z.string().startsWith("/") }),
    output: z.object({ locations: z.array(location) }),
  },
  read: {
    input: z.object({ path: z.string().startsWith("/") }),
    output: z.object({ content: z.string() }),
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

const diffTarget = z.enum(["all", "uncommitted"]);
export type DiffTarget = z.infer<typeof diffTarget>;

export const rpcContract = defineRpcContract({
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
    input: position.extend({ environmentId: z.string() }),
    output: z.object({ locations: z.array(location) }),
  },
  read: {
    input: z.object({ environmentId: z.string(), path: z.string().startsWith("/") }),
    output: z.object({ content: z.string() }),
  },
});
