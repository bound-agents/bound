/**
 * Varying-prefix builder.
 *
 * Pure function over the per-thread / per-turn identifiers, relay
 * routing info, platform-silence-semantics block, and model-name line
 * that historically opened the volatile-tail varying half before any
 * Working-Knowledge / Live-State enrichment.
 *
 * Lives in the **varying** half of the R-VC24 split — the User/Thread
 * ID line is per-thread, relay routing differs by host pair, the
 * platform block is per-thread, and `currentModel` can switch turn-to-
 * turn via `model_hint`. None of this can ride the cache breakpoint.
 *
 * Contract pinned by `__tests__/build.property.test.ts`:
 *
 *   V1 Determinism — same inputs produce byte-equal output.
 *   V2 First line — always `User ID: <userId>, Thread ID: <threadId>`.
 *   V3 Order — user/thread, relay, platform, current model (any subset).
 *   V4 Platform-tool fallback — empty `toolNames` -> "the platform send tool".
 *   V5 Platform-tool join — multiple names joined " or ", each backticked.
 *   V6 Discord formatting block — present iff platform is discord or
 *      discord-interaction.
 *   V7 Optional fields absent -> their lines absent.
 */

export interface RelayInfo {
	remoteHost: string;
	localHost: string;
	model: string;
	provider: string;
}

export interface PlatformContext {
	platform: string;
	toolNames?: string[];
}

export interface BuildVaryingPrefixParams {
	userId: string;
	threadId: string;
	relayInfo?: RelayInfo;
	platformContext?: PlatformContext;
	currentModel?: string;
}

const DISCORD_FORMATTING_NOTE =
	"Discord formatting: **bold**, *italic*, __underline__, ~~strikethrough~~, " +
	"`inline code`, ```code blocks```, > block quotes, >>> multi-line quotes, " +
	"# ## ### headers, -# subtext, [masked links](url), ||spoilers||, " +
	"- bulleted lists (2-space indent to nest). " +
	"Tables do NOT render — use lists or code blocks instead. " +
	"Messages over 2000 characters are rejected; split long content across multiple calls.";

export function buildVaryingPrefix(params: BuildVaryingPrefixParams): string[] {
	const lines: string[] = [];

	lines.push(`User ID: ${params.userId}, Thread ID: ${params.threadId}`);

	if (params.relayInfo) {
		lines.push(
			`You are: ${params.relayInfo.model} (via ${params.relayInfo.provider} on host ${params.relayInfo.remoteHost}, relayed from ${params.relayInfo.localHost})`,
		);
	}

	if (params.platformContext) {
		const toolRef =
			params.platformContext.toolNames && params.platformContext.toolNames.length > 0
				? params.platformContext.toolNames.map((n) => `\`${n}\``).join(" or ")
				: "the platform send tool";

		lines.push("");
		lines.push(`## Platform Context: ${params.platformContext.platform}`);
		lines.push(
			"The user of this conversation is on an external platform and cannot see your responses directly.",
		);
		lines.push(
			`To send a message to the user, call ${toolRef}. If you do not call it, the user sees nothing (silence).`,
		);
		lines.push(
			"Each call to the tool produces one separate message to the user. " +
				"Multiple calls are allowed and delivered in order.",
		);

		if (
			params.platformContext.platform === "discord" ||
			params.platformContext.platform === "discord-interaction"
		) {
			lines.push(DISCORD_FORMATTING_NOTE);
		}
	}

	if (params.currentModel) {
		lines.push(`Current Model: ${params.currentModel}`);
	}

	return lines;
}
