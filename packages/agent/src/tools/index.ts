import type { RegisteredTool, ToolContext } from "../types.js";
import { createAdvisoryTool } from "./advisory.js";
import { createArchiveTool } from "./archive.js";
import { createAuxTool } from "./auxiliary.js";
import { createCancelTool } from "./cancel.js";
import { createHostinfoTool } from "./hostinfo.js";
import { createIntrospectTool } from "./introspect.js";
import { createMemoryTool } from "./memory.js";
import { createModelHintTool } from "./model-hint.js";
import { createNotifyTool } from "./notify.js";
import { createPurgeTool } from "./purge.js";
import { createQueryTool } from "./query.js";
import { createSkillTool } from "./skill.js";
import { createTaskTool } from "./task.js";
import { createYardTool } from "./yard.js";

export function createAgentTools(ctx: ToolContext): RegisteredTool[] {
	return [
		// Standalone (Phase 2)
		createTaskTool(ctx),
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
		createAuxTool(ctx),
		// Yard (actionless QuickJS orchestration)
		createYardTool(ctx),
	];
}
