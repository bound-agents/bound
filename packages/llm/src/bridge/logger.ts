import { type Logger, createLogger } from "@bound/shared";

// Lazily created, not at module scope: `createLogger()` materializes the pino
// root, which mkdirs `logs/` and opens `logs/bound.log` under process.cwd()
// synchronously. The bridge is reachable by just importing @bound/llm (which
// boundless does for image-budget constants) — an eager logger dropped a
// 0-byte logs/bound.log into whatever directory boundless ran from, even
// though boundless never logs through pino (it has its own AppLogger). The
// file only appears if this logger actually fires, which is exactly when a
// log file is warranted.
let logger: Logger | null = null;

export function getBridgeLogger(): Logger {
	if (logger === null) {
		logger = createLogger("llm", "ai-sdk-bridge");
	}
	return logger;
}
