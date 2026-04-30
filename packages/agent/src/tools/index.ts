import type { RegisteredTool, ToolContext } from "../types.js";
import { createQueryTool } from "./query.js";
import { createScheduleTool } from "./schedule.js";

export function createAgentTools(ctx: ToolContext): RegisteredTool[] {
	return [createScheduleTool(ctx), createQueryTool(ctx)];
}

export { createScheduleTool } from "./schedule.js";
export { createQueryTool } from "./query.js";
