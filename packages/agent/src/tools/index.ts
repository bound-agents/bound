import type { RegisteredTool, ToolContext } from "../types.js";
import { createAdvisoryTool } from "./advisory.js";
import { createAwaitEventTool } from "./await-event.js";
import { createCancelTool } from "./cancel.js";
import { createEmitTool } from "./emit.js";
import { createPurgeTool } from "./purge.js";
import { createQueryTool } from "./query.js";
import { createScheduleTool } from "./schedule.js";

export function createAgentTools(ctx: ToolContext): RegisteredTool[] {
	return [
		createScheduleTool(ctx),
		createQueryTool(ctx),
		createCancelTool(ctx),
		createEmitTool(ctx),
		createAwaitEventTool(ctx),
		createPurgeTool(ctx),
		createAdvisoryTool(ctx),
	];
}

export { createScheduleTool } from "./schedule.js";
export { createQueryTool } from "./query.js";
export { createCancelTool } from "./cancel.js";
export { createEmitTool } from "./emit.js";
export { createAwaitEventTool } from "./await-event.js";
export { createPurgeTool } from "./purge.js";
export { createAdvisoryTool } from "./advisory.js";
