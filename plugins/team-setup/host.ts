// The host entry for team-setup: the Figma step runs where Claude Code and its
// MCP config live, on the developer's machine. See figma.ts for the flow.
import { createFigmaHostEntry, createFigmaRunner } from "./figma.js";

export default createFigmaHostEntry({ runner: createFigmaRunner(), fetch });
