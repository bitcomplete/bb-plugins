import { randomUUID } from "node:crypto";
import { cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Stage } from "../src/domain/types.js";
import { listObjectives } from "../src/objectives.js";
import { STAGES } from "../src/services.js";
import { diagnostics, recentRuns } from "./dashboard.js";
import type { Context } from "./wiring.js";

const idSchema = z.string().min(1).max(200);
const externalCostSchema = z.object({ idempotencyKey: z.string().min(1).max(500), kind: z.enum(["charge","credit"]), basis: z.enum(["reported","estimated","unknown"]), amountMicros: z.number().int().nonnegative().nullable(), currency: z.string().regex(/^[A-Z]{3}$/), source: z.string().min(1).max(500), reference: z.string().min(1).max(500), scope: z.string().min(1).max(500), occurredAtMs: z.number().int().nonnegative(), runId: idSchema.optional(), solutionId: idSchema.optional(), attemptId: idSchema.optional(), appliesToId: idSchema.optional(), replacesId: idSchema.optional() }).strict();
const json = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value, null, 2) });

/** The owner's `bb self-improve` commands. */
export function registerCli(ctx: Context): void {
  const { bb, store } = ctx;
  const cli = defineCli({ name: "self-improve", summary: "Observe failures, test possible improvements and inspect their evidence", commands: {
    doctor: cliCommand({ summary: "Configuration, source coverage and adoption prerequisites", options: { "research-tools": { type: "boolean", description: "Discover the configured authenticated DAIR MCP tools" } }, run: async input => {
      const { config } = ctx;
      return json({ issues: diagnostics(ctx), execution: { providerId: config.providerId, model: config.model, permissionMode: config.permissionMode, projectId: config.projectId, environmentId: config.environmentId },
        nativeTasks: store.list("native-tasks").slice(-20), sourceCoverage: store.get("source-coverage", "latest"), runs: recentRuns(ctx),
        ...(input.options["research-tools"] ? { researchTools: await ctx.research.tools() } : {}) });
    } }),
    status: cliCommand({ summary: "Services, pending work and latest runs", run: async () => json({ enabled: ctx.values.enabled, pending: store.pending(), runs: recentRuns(ctx), issues: diagnostics(ctx) }) }),
    run: cliCommand({ summary: "Queue one service with a unique manual run key", options: { stage: { type: "enum", values: STAGES, required: true, description: "Service to run" } }, run: async input => json({ jobId: ctx.services.enqueue(input.options.stage as Stage, `manual:${randomUUID()}`) }) }),
    config: cliCommand({ summary: "Read or update public configuration; credentials use secret settings", options: { value: { type: "string", description: "Complete configuration JSON" } }, run: async input => {
      const value = input.options.value;
      if (value) await ctx.updateConfig(() => { try { return JSON.parse(value); } catch { throw new Error("Invalid configuration: not valid JSON"); } });
      return json(ctx.config);
    } }),
    problems: cliCommand({ summary: "Problem ledger and independent owner goals", run: async () => json({ problems: store.list("problems"), objectives: listObjectives(store) }) }),
    solutions: cliCommand({ summary: "Solution history and build ranking", run: async () => json({ solutions: store.entries("solutions"), ranking: store.get("solution-ranking", "latest") }) }),
    costs: cliCommand({ summary: "Charges, estimates, unknown attempts and reservations; record owner-reported invoices or infrastructure", options: { record: { type: "string", description: "ExternalCostInput JSON; never include credentials or private names" } }, run: async input => {
      if (input.options.record) {
        const charge = externalCostSchema.parse(JSON.parse(input.options.record));
        for (const text of [charge.source, charge.reference, charge.scope]) if (ctx.clean(text) !== text) throw new Error("Cost metadata must omit credentials and private identifiers");
        ctx.accounting.recordExternal(charge, { kind: "owner", id: "cost-cli" }); ctx.changed();
      }
      return json({ ...ctx.activity.summary(), access: store.list("access-costs") });
    } }),
    budgets: cliCommand({ summary: "Active cost and call limits", run: async () => json(ctx.config.budgets) }),
  } });
  bb.cli.register({ ...cli, run: async (argv, context) => {
    // Defense in depth: CLI context is advisory, not an authentication token.
    // This guards this plugin’s owner CLI; BB still owns other native capabilities.
    if (context.threadId && ctx.owns(context.threadId)) throw new Error("Self improve workers use bounded ledger tools, not owner CLI commands");
    return cli.run(argv, context);
  } });
}
