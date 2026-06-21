import type { Logger } from "@bound/shared";
import { type MapChunksOptions, mapChunks, mapError } from "./ai-sdk-bridge";
import { createLoggingFetch } from "./fetch-logger";
import type { StreamChunk } from "./types";

export interface ProviderFetchConfig {
	fetch?: typeof fetch;
	logger?: Logger;
	connectTimeoutMs?: number;
}

export function resolveProviderFetch(
	providerName: string,
	config: ProviderFetchConfig,
): typeof fetch | undefined {
	return (
		config.fetch ??
		(config.logger
			? createLoggingFetch(config.logger, providerName, config.connectTimeoutMs)
			: undefined)
	);
}

export interface ProviderStreamParams {
	providerName: string;
	stream: () => AsyncIterable<unknown>;
	map?: Omit<MapChunksOptions, "providerName">;
}

export async function* mapProviderStream(params: ProviderStreamParams): AsyncIterable<StreamChunk> {
	try {
		yield* mapChunks(params.stream(), {
			...params.map,
			providerName: params.providerName,
		});
	} catch (err) {
		throw mapError(err, params.providerName);
	}
}

export async function* runProviderStream(params: ProviderStreamParams): AsyncIterable<StreamChunk> {
	yield { type: "heartbeat" };
	yield* mapProviderStream(params);
}
