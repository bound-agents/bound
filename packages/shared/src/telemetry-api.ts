import {
	type Counter,
	type Histogram,
	type Meter,
	type MetricOptions,
	type UpDownCounter,
	metrics,
} from "@opentelemetry/api";

const meters = new Map<string, Meter>();
const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const upDownCounters = new Map<string, UpDownCounter>();

function lateBoundCounter(name: string, options?: MetricOptions): Counter {
	let delegate: Counter | undefined;
	return {
		add(value, attributes, ctx) {
			delegate ??= metrics.getMeter("bound").createCounter(name, options);
			delegate.add(value, attributes, ctx);
		},
	};
}

function lateBoundHistogram(name: string, options?: MetricOptions): Histogram {
	let delegate: Histogram | undefined;
	return {
		record(value, attributes, ctx) {
			delegate ??= metrics.getMeter("bound").createHistogram(name, options);
			delegate.record(value, attributes, ctx);
		},
	};
}

function lateBoundUpDownCounter(name: string, options?: MetricOptions): UpDownCounter {
	let delegate: UpDownCounter | undefined;
	return {
		add(value, attributes, ctx) {
			delegate ??= metrics.getMeter("bound").createUpDownCounter(name, options);
			delegate.add(value, attributes, ctx);
		},
	};
}

export function meter(name = "bound"): Meter {
	let instrument = meters.get(name);
	if (!instrument) {
		instrument = metrics.getMeter(name);
		meters.set(name, instrument);
	}
	return instrument;
}

export function counter(name: string, options?: MetricOptions): Counter {
	let instrument = counters.get(name);
	if (!instrument) {
		instrument = lateBoundCounter(name, options);
		counters.set(name, instrument);
	}
	return instrument;
}

export function histogram(name: string, options?: MetricOptions): Histogram {
	let instrument = histograms.get(name);
	if (!instrument) {
		instrument = lateBoundHistogram(name, options);
		histograms.set(name, instrument);
	}
	return instrument;
}

export function upDownCounter(name: string, options?: MetricOptions): UpDownCounter {
	let instrument = upDownCounters.get(name);
	if (!instrument) {
		instrument = lateBoundUpDownCounter(name, options);
		upDownCounters.set(name, instrument);
	}
	return instrument;
}

export function clearTelemetryInstrumentCaches(): void {
	meters.clear();
	counters.clear();
	histograms.clear();
	upDownCounters.clear();
}
