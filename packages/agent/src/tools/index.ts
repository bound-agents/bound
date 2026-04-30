import type { RegisteredTool, ToolContext } from "../types.js";
import { createAdvisoryTool } from "./advisory.js";
import { createArchiveTool } from "./archive.js";
import { createAwaitEventTool } from "./await-event.js";
import { createCancelTool } from "./cancel.js";
import { createEmitTool } from "./emit.js";
import { createHostinfoTool } from "./hostinfo.js";
import { createMemoryTool } from "./memory.js";
import { createModelHintTool } from "./model-hint.js";
import { createNotifyTool } from "./notify.js";
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
		createNotifyTool(ctx),
		createArchiveTool(ctx),
		createModelHintTool(ctx),
		createHostinfoTool(ctx),
		createMemoryTool(ctx),
	];
}

export { createScheduleTool } from "./schedule.js";
export { createQueryTool } from "./query.js";
export { createCancelTool } from "./cancel.js";
export { createEmitTool } from "./emit.js";
export { createAwaitEventTool } from "./await-event.js";
export { createPurgeTool } from "./purge.js";
export { createAdvisoryTool } from "./advisory.js";
export { createNotifyTool } from "./notify.js";
export { createArchiveTool } from "./archive.js";
export { createModelHintTool } from "./model-hint.js";
export { createHostinfoTool } from "./hostinfo.js";
export { createMemoryTool } from "./memory.js";
