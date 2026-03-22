import type { CommandDefinition } from "@bound/sandbox";
import { archive } from "./archive";
import { awaitCmd } from "./await-cmd";
import { cacheEvict } from "./cache-evict";
import { cachePin } from "./cache-pin";
import { cacheUnpin } from "./cache-unpin";
import { cacheWarm } from "./cache-warm";
import { cancel } from "./cancel";
import { emit } from "./emit";
import { forget } from "./forget";
import { memorize } from "./memorize";
import { modelHint } from "./model-hint";
import { purge } from "./purge";
import { query } from "./query";
import { schedule } from "./schedule";

export function getAllCommands(): CommandDefinition[] {
	return [
		query,
		memorize,
		forget,
		schedule,
		cancel,
		emit,
		purge,
		awaitCmd,
		cacheWarm,
		cachePin,
		cacheUnpin,
		cacheEvict,
		modelHint,
		archive,
	];
}

export {
	query,
	memorize,
	forget,
	schedule,
	cancel,
	emit,
	purge,
	awaitCmd,
	cacheWarm,
	cachePin,
	cacheUnpin,
	cacheEvict,
	modelHint,
	archive,
};
