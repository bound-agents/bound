/**
 * Varying-prefix builder.
 *
 * Pure function over the per-thread / per-turn identifiers, relay
 * routing info, and model-name line that open the volatile-tail varying
 * half before any Working-Knowledge / Live-State enrichment.
 *
 * Lives in the **varying** half of the R-VC24 split — the User/Thread
 * ID line is per-thread, relay routing differs by host pair, and
 * `currentModel` can switch turn-to-turn via `model_hint`. None of this
 * can ride the cache breakpoint.
 *
 * Contract pinned by `__tests__/build.property.test.ts`:
 *
 *   V1 Determinism — same inputs produce byte-equal output.
 *   V2 First line — always `User ID: <userId>, Thread ID: <threadId>`.
 *   V3 Order — user/thread, relay, current model (any subset).
 *   V7 Optional fields absent -> their lines absent.
 *   V8 No embedded newlines in any single emitted line.
 */

export interface RelayInfo {
	remoteHost: string;
	localHost: string;
	model: string;
	provider: string;
}

export interface BuildVaryingPrefixParams {
	userId: string;
	threadId: string;
	relayInfo?: RelayInfo;
	currentModel?: string;
}

export function buildVaryingPrefix(params: BuildVaryingPrefixParams): string[] {
	const lines: string[] = [];

	lines.push(`User ID: ${params.userId}, Thread ID: ${params.threadId}`);

	if (params.relayInfo) {
		lines.push(
			`You are: ${params.relayInfo.model} (via ${params.relayInfo.provider} on host ${params.relayInfo.remoteHost}, relayed from ${params.relayInfo.localHost})`,
		);
	}

	if (params.currentModel) {
		lines.push(`Current Model: ${params.currentModel}`);
	}

	return lines;
}
