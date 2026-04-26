/**
 * Route AI SDK warnings through bound's pino-based Logger instead of the
 * SDK's default `console.warn` fallback.
 *
 * The AI SDK (`ai`) checks `globalThis.AI_SDK_LOG_WARNINGS` for each call:
 *   - `false`      → warnings silenced
 *   - function     → called with `{ provider, model, warnings: Warning[] }`
 *   - anything else → console.warn fallback
 *
 * By default bound installs nothing, so the SDK emits directly to stderr and
 * those entries never land in `logs/bound.log` nor in any database table.
 * This helper installs a function bridge so warnings flow through our
 * structured logger (both the pretty stderr stream AND the file stream).
 *
 * See `SharedV3Warning` from `@ai-sdk/provider` for the warning shape:
 *   { type: "unsupported",   feature: string, details?: string }
 *   | { type: "compatibility", feature: string, details?: string }
 *   | { type: "other",         message: string }
 *
 * We do NOT silence the SDK's "to turn off warning logging set
 * AI_SDK_LOG_WARNINGS=false" info message — that fires on the first
 * console path ONLY, which we're replacing. Installing our hook makes
 * the first-time notice irrelevant.
 */

import type { Logger } from "@bound/shared";

type SdkWarning =
	| { type: "unsupported"; feature: string; details?: string }
	| { type: "compatibility"; feature: string; details?: string }
	| { type: "other"; message: string };

interface SdkLogOptions {
	provider: string;
	model: string;
	warnings: SdkWarning[];
}

interface GlobalWithAiSdkHook {
	AI_SDK_LOG_WARNINGS?: ((opts: SdkLogOptions) => void) | false;
}

function formatMessage(w: SdkWarning, provider: string, model: string): string {
	const prefix = `AI SDK Warning (${provider} / ${model}):`;
	switch (w.type) {
		case "unsupported": {
			const tail = w.details ? ` ${w.details}` : "";
			return `${prefix} The feature "${w.feature}" is not supported.${tail}`;
		}
		case "compatibility": {
			const tail = w.details ? ` ${w.details}` : "";
			return `${prefix} The feature "${w.feature}" is used in a compatibility mode.${tail}`;
		}
		case "other":
			return `${prefix} ${w.message}`;
	}
}

function toContext(w: SdkWarning, provider: string, model: string): Record<string, unknown> {
	const base: Record<string, unknown> = { provider, model, type: w.type };
	if (w.type === "unsupported" || w.type === "compatibility") {
		base.feature = w.feature;
		if (w.details !== undefined) base.details = w.details;
	}
	// 'other' warnings embed their text in the formatted message — no extra
	// structured field beyond type.
	return base;
}

/**
 * Install the warning routing hook on `globalThis`. Idempotent: replaces any
 * prior hook (including `false`) with a fresh bound logger callback.
 */
export function installAiSdkWarningHook(logger: Logger): void {
	const g = globalThis as GlobalWithAiSdkHook;
	g.AI_SDK_LOG_WARNINGS = ({ provider, model, warnings }: SdkLogOptions) => {
		for (const w of warnings) {
			logger.warn(formatMessage(w, provider, model), toContext(w, provider, model));
		}
	};
}

/**
 * Remove the warning routing hook. Mostly useful for tests; in production the
 * hook is installed once at startup and stays until the process exits.
 */
export function uninstallAiSdkWarningHook(): void {
	const g = globalThis as GlobalWithAiSdkHook;
	g.AI_SDK_LOG_WARNINGS = undefined;
}
