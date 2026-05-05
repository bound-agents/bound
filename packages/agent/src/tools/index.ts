import type { RegisteredTool, ToolContext } from "../types.js";
import { createAdvisoryTool } from "./advisory.js";
import { createArchiveTool } from "./archive.js";
import { createCancelTool } from "./cancel.js";
import { createHostinfoTool } from "./hostinfo.js";
import { createIntrospectTool } from "./introspect.js";
import { createMemoryTool } from "./memory.js";
import { createModelHintTool } from "./model-hint.js";
import { createNotifyTool } from "./notify.js";
import { createPurgeTool } from "./purge.js";
import { createQueryTool } from "./query.js";
import { createScheduleTool } from "./schedule.js";
import { createSkillTool } from "./skill.js";

export function createAgentTools(ctx: ToolContext): RegisteredTool[] {
	return [
		// Standalone (Phase 2)
		createScheduleTool(ctx),
		createCancelTool(ctx),
		createQueryTool(ctx),
		createPurgeTool(ctx),
		createAdvisoryTool(ctx),
		createNotifyTool(ctx),
		createIntrospectTool(ctx),
		createArchiveTool(ctx),
		createModelHintTool(ctx),
		createHostinfoTool(ctx),
		// Grouped (Phase 3)
		createMemoryTool(ctx),
		createSkillTool(ctx),
	];
}

export { createScheduleTool } from "./schedule.js";
export { createQueryTool } from "./query.js";
export { createCancelTool } from "./cancel.js";
export { createPurgeTool } from "./purge.js";
export { createAdvisoryTool } from "./advisory.js";
export { createNotifyTool } from "./notify.js";
export { createIntrospectTool } from "./introspect.js";
export { createArchiveTool } from "./archive.js";
export { createModelHintTool } from "./model-hint.js";
export { createHostinfoTool } from "./hostinfo.js";
export { createMemoryTool } from "./memory.js";
export { createSkillTool } from "./skill.js";
