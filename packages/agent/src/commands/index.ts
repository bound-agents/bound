import type { CommandDefinition } from "@bound/sandbox";
import { awaitCmd } from "./await-cmd";
import { cancel } from "./cancel";
import { emit } from "./emit";
import { forget } from "./forget";
import { memorize } from "./memorize";
import { purge } from "./purge";
import { query } from "./query";
import { schedule } from "./schedule";

export function getAllCommands(): CommandDefinition[] {
	return [query, memorize, forget, schedule, cancel, emit, purge, awaitCmd];
}

export { query, memorize, forget, schedule, cancel, emit, purge, awaitCmd };
