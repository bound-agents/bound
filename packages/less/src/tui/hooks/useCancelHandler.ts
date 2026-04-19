import type { BoundClient } from "@bound/client";
import { useApp, useInput } from "ink";
import { useCallback, useEffect, useRef } from "react";
import { CancelStateMachine } from "../../session/cancel";

export interface UseCancelHandlerOptions {
	client: BoundClient | null;
	threadId: string;
	abortAll: () => void;
	dismissModal: () => boolean;
	showHint: (message: string) => void;
	onGracefulExit?: () => Promise<void>;
}

export interface UseCancelHandlerResult {
	/** The state machine instance, for external state updates (turnActive, modalOpen, etc.) */
	stateMachine: CancelStateMachine;
}

/**
 * Hook that wires Ctrl-C to the CancelStateMachine and tracks turn-active state
 * via thread:status events from the BoundClient.
 */
export function useCancelHandler({
	client,
	threadId,
	abortAll,
	dismissModal,
	showHint,
	onGracefulExit,
}: UseCancelHandlerOptions): UseCancelHandlerResult {
	const { exit } = useApp();

	const smRef = useRef<CancelStateMachine | null>(null);

	if (!smRef.current) {
		smRef.current = new CancelStateMachine(threadId, {
			cancelThread: async (tid: string) => {
				if (client) {
					await client.cancelThread(tid);
				}
			},
			abortInFlightTools: abortAll,
			gracefulExit: async () => {
				if (onGracefulExit) {
					await onGracefulExit();
				}
				exit();
			},
			dismissModal,
			showHint,
		});
	}

	// Keep threadId in sync
	useEffect(() => {
		smRef.current?.setThreadId(threadId);
	}, [threadId]);

	// Track turn-active state via thread:status events
	useEffect(() => {
		if (!client) return;

		const handler = (data: { thread_id: string; active: boolean }) => {
			if (!smRef.current) return;
			if (data.thread_id === threadId) {
				if (data.active) {
					smRef.current.turnActive = true;
				} else {
					smRef.current.resetTurn();
				}
			}
		};

		client.on("thread:status", handler);
		return () => {
			client.off("thread:status", handler);
		};
	}, [client, threadId]);

	// Ctrl-C handler
	const handleCtrlC = useCallback(() => {
		smRef.current?.onCtrlC();
	}, []);

	useInput((input, key) => {
		if (key.ctrl && input === "c") {
			handleCtrlC();
		}
	});

	// biome-ignore lint/style/noNonNullAssertion: smRef.current is always set by the time we return
	return { stateMachine: smRef.current! };
}
