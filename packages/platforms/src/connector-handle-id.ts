import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import stableStringify from "json-stable-stringify";

/**
 * Generates a deterministic ID for a connector handle from its identity tuple.
 * Same inputs always produce the same UUID, regardless of key ordering in event_args.
 */
export function connectorHandleId(
	serverName: string,
	eventName: string,
	eventArgs: Record<string, unknown>,
): string {
	const key = stableStringify({ server: serverName, event: eventName, args: eventArgs });
	// stableStringify returns string, typescript just doesn't infer it properly
	return deterministicUUID(BOUND_NAMESPACE, key as string);
}
