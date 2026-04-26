import type { BoundClient } from "@bound/client";
import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { ActionBar, ModalOverlay, SelectList, Spinner } from "../components";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { formatThreadPickerLabel } from "./picker-label";

export type PickerMode = "thread" | "model";

export interface PickerViewProps {
	mode: PickerMode;
	client: BoundClient | null;
	onSelect: (value: string) => void;
	onCancel: () => void;
}

interface PickerItem {
	id: string;
	label: string;
}

/**
 * PickerView: Reusable modal for selecting threads or models.
 *
 * Implements AC9.5 (/model picker), AC9.6 (/attach picker)
 */
export function PickerView({
	mode,
	client,
	onSelect,
	onCancel,
}: PickerViewProps): React.ReactElement {
	const [items, setItems] = useState<PickerItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { columns: termColumns } = useTerminalSize();
	// Leave room for the "› " cursor prefix (2 cols) and the modal's padding
	// + border (paddingX=1 + 2 border cols on each side = 4 cols).
	const labelColumns = Math.max(20, termColumns - 6);

	useEffect(() => {
		if (!client) {
			setError("Client not connected");
			setLoading(false);
			return;
		}

		const loadItems = async () => {
			try {
				if (mode === "thread") {
					const threads = await client.listThreads();
					setItems(
						// Collapse any newlines in the title and truncate so
						// the row stays a single line. The full thread id is
						// kept whenever possible so users can still copy it
						// for `--attach`.
						threads.map((t) => ({
							id: t.id,
							label: formatThreadPickerLabel(t.title, t.id, labelColumns),
						})),
					);
				} else if (mode === "model") {
					const response = await client.listModels();
					setItems(
						response.models.map((m) => ({
							id: m.id,
							label: m.id,
						})),
					);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to load items");
			} finally {
				setLoading(false);
			}
		};

		loadItems();
	}, [client, mode, labelColumns]);

	const title = mode === "thread" ? "Select Thread" : "Select Model";

	return (
		<ModalOverlay onDismiss={onCancel}>
			<Box flexDirection="column">
				<Text bold>{title}</Text>
				{loading && (
					<Box marginTop={1}>
						<Spinner />
						<Text> Loading...</Text>
					</Box>
				)}
				{error && <Text color="red">Error: {error}</Text>}
				{!loading && !error && items.length === 0 && <Text color="yellow">No items available</Text>}
				{!loading && !error && items.length > 0 && (
					<Box marginTop={1}>
						<SelectList
							items={items}
							onSelect={(item) => onSelect(item.id)}
							onCancel={onCancel}
							renderItem={(item, selected) => (
								<Text>
									<Text color="cyan">{selected ? "› " : "  "}</Text>
									{item.label}
								</Text>
							)}
						/>
					</Box>
				)}
				<Box marginTop={1}>
					<ActionBar
						actions={[
							{ keys: "Return", label: "select" },
							{ keys: "Esc", label: "cancel" },
						]}
					/>
				</Box>
			</Box>
		</ModalOverlay>
	);
}
