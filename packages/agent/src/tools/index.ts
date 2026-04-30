import type { RegisteredTool, ToolContext } from "../types.js";
import { createCancelTool } from "./cancel.js";
import { createQueryTool } from "./query.js";
import { createScheduleTool } from "./schedule.js";

export function createAgentTools(ctx: ToolContext): RegisteredTool[] {
	return [createScheduleTool(ctx), createQueryTool(ctx), createCancelTool(ctx)];
}

export { createScheduleTool } from "./schedule.js";
export { createQueryTool } from "./query.js";
export { createCancelTool } from "./cancel.js";
