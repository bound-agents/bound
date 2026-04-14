import type { Task } from "@bound/shared";

export function extractDisplayName(task: Task): string {
	if (task.type === "heartbeat") {
		return "heartbeat";
	}

	if (task.type === "cron") {
		try {
			if (task.payload) {
				const parsed = JSON.parse(task.payload) as Record<string, unknown>;
				if (typeof parsed.name === "string") {
					return parsed.name;
				}
			}
		} catch {
			// Malformed payload, fall through to fallback
		}
	}

	if (task.type === "deferred") {
		try {
			if (task.payload) {
				const parsed = JSON.parse(task.payload) as Record<string, unknown>;
				if (typeof parsed.description === "string") {
					return parsed.description;
				}
			}
		} catch {
			// Malformed payload, fall through to fallback
		}
	}

	return `${task.type} ${task.id.slice(0, 8)}`;
}

export function extractSchedule(task: Task): string | null {
	if (task.type === "deferred") {
		return "one-time";
	}

	if (task.type === "event") {
		return "on-event";
	}

	if (task.type === "cron" || task.type === "heartbeat") {
		let spec = task.trigger_spec;
		if (!spec) {
			return null;
		}

		// trigger_spec may be a JSON string wrapping the cron expression
		if (spec.startsWith("{")) {
			try {
				const parsed = JSON.parse(spec) as Record<string, unknown>;
				if (typeof parsed.expression === "string") {
					spec = parsed.expression;
				} else if (typeof parsed.cron === "string") {
					spec = parsed.cron;
				} else if (typeof parsed.schedule === "string") {
					spec = parsed.schedule;
				}
			} catch {
				// Not valid JSON, treat as raw cron expression
			}
		}

		return humanReadableCron(spec);
	}

	return null;
}

function humanReadableCron(spec: string): string {
	const parts = spec.trim().split(/\s+/);
	if (parts.length !== 5) {
		return spec;
	}

	const [minute, hour, day, month, weekday] = parts;

	if (minute === "*/15" && hour === "*" && day === "*" && month === "*" && weekday === "*") {
		return "every 15m";
	}

	if (minute === "*/30" && hour === "*" && day === "*" && month === "*" && weekday === "*") {
		return "every 30m";
	}

	if (minute === "0" && hour === "*" && day === "*" && month === "*" && weekday === "*") {
		return "hourly";
	}

	if (minute === "*/5" && hour === "*" && day === "*" && month === "*" && weekday === "*") {
		return "every 5m";
	}

	if (minute === "*/10" && hour === "*" && day === "*" && month === "*" && weekday === "*") {
		return "every 10m";
	}

	if (minute === "0" && hour === "0" && day === "*" && month === "*" && weekday === "*") {
		return "daily";
	}

	if (minute === "0" && hour === "0" && day === "1" && month === "*" && weekday === "*") {
		return "monthly";
	}

	if (minute === "0" && hour === "0" && day === "*" && month === "*" && weekday === "1") {
		return "weekly";
	}

	return spec;
}
