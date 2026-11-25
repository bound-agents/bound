import type { BoundClient } from "@bound/client";
import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { ActionBar, ModalOverlay, SelectList, Spinner } from "../components";
import { MODAL_LIST_RESERVED_ROWS } from "../components/SelectList";
import { useTerminalSize } from "../hooks/useTerminalSize";
import { tokens } from "../theme";
import { formatThreadPickerLabel } from "./picker-label";

export type PickerMode = "thread" | "model";

export interface PickerViewProps {
	mode: PickerMode;
	client: BoundClient | null;
	onSelect: (value: string) => void;
	onCancel: () => void;
	/** The currently-active value (model id or thread id). When provided and
	 *  mode === "model", the matching list item is annotated with "(active)"
	 *  so the user can see which model is currently in use at a glance. */
	currentValue?: string;
}

const ACTIVE_SUFFIX = " (active)";

/** Truncate to `max` columns with a trailing ellipsis. */
export function truncateLabel(label: string, max: number): string {
	const flat = label.replace(/\s+/g, " ").trim();
	if (max <= 0) return "";
	if (flat.length <= max) return flat;
	return max === 1 ? "…" : `${flat.slice(0, max - 1)}…`;
}

interface PickerItem {
	id: string;
	/** Model display name; for threads, the raw title (labels are computed at render). */
	label: string;
	/** Thread title (thread mode). Kept raw so a resize re-truncates without re-fetching. */
	title?: string | null;
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
	currentValue,
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
						threads.map((t) => ({ id: t.id, label: t.title ?? t.id, title: t.title })),
					);
				} else if (mode === "model") {
					const response = await client.listModels();
					const seen = new Set<string>();
					const modelItems: PickerItem[] = [];
					for (const m of response.models) {
						const id = m.logical_model ?? m.id;
						if (seen.has(id)) continue;
						seen.add(id);
						modelItems.push({ id, label: m.display_name ?? m.id });
					}
					// Alphabetical by display name, case-insensitive; never trust server order.
					modelItems.sort((a, b) =>
						a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
					);
					setItems(modelItems);
				}
			} catch (err) {
				setError(
					err instanceof Error
						? err.message
						: mode === "thread"
							? "Failed to load threads"
							: "Failed to load models",
				);
			} finally {
				setLoading(false);
			}
		};

		loadItems();
	}, [client, mode]);

	const title = mode === "thread" ? "Select Thread" : "Select Model";

	return (
		<ModalOverlay onDismiss={onCancel}>
			<Box flexDirection="column">
				<Text bold wrap="truncate-end">
					{title}
				</Text>
				{loading && (
					<Box marginTop={1}>
						<Spinner />
						<Text> Loading...</Text>
					</Box>
				)}
				{error && <Text color={tokens.bannerError}>Error: {error}</Text>}
				{!loading && !error && items.length === 0 && (
					<Text color={tokens.warningNotice}>
						{mode === "thread" ? "No threads available" : "No models available"}
					</Text>
				)}
				{!loading && !error && items.length > 0 && (
					<Box marginTop={1}>
						<SelectList
							items={items}
							onSelect={(item) => onSelect(item.id)}
							onCancel={onCancel}
							handleCancelKeys={false}
							reservedRows={MODAL_LIST_RESERVED_ROWS}
							renderItem={(item, selected) => {
								const active = mode === "model" && item.id === currentValue;
								const budget = labelColumns - (active ? ACTIVE_SUFFIX.length : 0);
								return (
									<Text wrap="truncate-end">
										<Text color={tokens.selectionCaret}>{selected ? "› " : "  "}</Text>
										{mode === "model"
											? truncateLabel(item.label, budget)
											: formatThreadPickerLabel(item.title ?? null, item.id, labelColumns)}
										{active && (
											<Text color={tokens.successIndicator} dimColor>
												{ACTIVE_SUFFIX}
											</Text>
										)}
									</Text>
								);
							}}
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
