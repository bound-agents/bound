import { counter, histogram } from "../../telemetry.js";

const requests = counter("test.preinit.requests");
const duration = histogram("test.preinit.duration", { unit: "ms" });

export function recordPreinitMetrics(): void {
	requests.add(1);
	duration.record(2);
}
