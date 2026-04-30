import type { RegisteredTool, ToolContext } from "../types.js";
import { createScheduleTool } from "./schedule.js";

export function createAgentTools(ctx: ToolContext): RegisteredTool[] {
	return [createScheduleTool(ctx)];
}

export { createScheduleTool } from "./schedule.js";
