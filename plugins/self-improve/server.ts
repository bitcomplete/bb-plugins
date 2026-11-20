import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./src/contract.js";
import { createContext } from "./server/wiring.js";
import { registerRpc } from "./server/rpc.js";
import { registerAgents } from "./server/agents.js";
import { registerCli } from "./server/cli.js";

export { rpcContract };

/**
 * Self improve: finds recurring failures in BB threads, tests fixes for them and applies the ones that pass.
 * server/wiring.ts builds the services and background work; the other server/ modules register the
 * dashboard RPCs, the agent tools and turn configuration, and the CLI.
 */
export default async function plugin(bb: BbPluginApi): Promise<void> {
  const ctx = await createContext(bb);
  registerRpc(ctx);
  registerAgents(ctx);
  registerCli(ctx);
  ctx.changed();
}
