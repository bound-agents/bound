/**
 * Varying-prefix builder.
 *
 * Pure function over the per-thread / per-turn identifiers, relay
 * routing info, and model-name line that open the volatile-tail varying
 * half before any Working-Knowledge / Live-State enrichment.
 *
 * Lives in the **varying** half of the R-VC24 split — the identity
 * element is per-thread, relay routing differs by host pair, and
 * `currentModel` can switch turn-to-turn via `model_hint`. None of this
 * can ride the cache breakpoint.
 *
 * Contract pinned by `__tests__/build.property.test.ts`:
 *
 *   V1 Determinism — same inputs produce byte-equal output.
 *   V2 First line — always `<identity user-id="…" thread-id="…"/>`.
 *   V3 Order — identity, relay, current model (any subset).
 *   V7 Optional fields absent -> their lines absent.
 *   V8 No embedded newlines in any single emitted line.
 */

import { escapeXmlAttr } from "@bound/shared";

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

	// String() coercion mirrors the pre-XML template-literal behavior: some
	// no-history/task callers assemble without a userId, which used to render
	// the literal "undefined" — keep that tolerance rather than throwing inside
	// escapeXmlAttr.
	lines.push(
		`<identity user-id="${escapeXmlAttr(String(params.userId))}" thread-id="${escapeXmlAttr(String(params.threadId))}"/>`,
	);

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
