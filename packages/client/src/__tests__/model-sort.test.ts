import { describe, expect, it } from "bun:test";
import { sortClusterModelsById } from "../model-sort";
import type { ClusterModelInfo } from "../types";

const model = (id: string, host = "host"): ClusterModelInfo => ({
	id,
	host,
	provider: "test",
	via: "local",
	status: "local",
});

describe("sortClusterModelsById", () => {
	it("matches ACP's descending lexical model-id order", () => {
		const input = [model("claude-opus"), model("gpt-5.6"), model("fable")];
		expect(sortClusterModelsById(input).map((m) => m.id)).toEqual([
			"gpt-5.6",
			"fable",
			"claude-opus",
		]);
	});

	it("does not mutate the API response array", () => {
		const input = [model("a"), model("z")];
		sortClusterModelsById(input);
		expect(input.map((m) => m.id)).toEqual(["a", "z"]);
	});

	it("uses host as a deterministic duplicate-id tie-breaker", () => {
		const input = [model("same", "z-host"), model("same", "a-host")];
		expect(sortClusterModelsById(input).map((m) => m.host)).toEqual(["a-host", "z-host"]);
	});
});
