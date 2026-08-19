import Parser from "tree-sitter";

const grammarSpecs = [
	["tree-sitter-kotlin", "0.3.8"],
	["tree-sitter-c", "0.24.1"],
	["tree-sitter-cpp", "0.23.4"],
	["tree-sitter-c-sharp", "0.23.5"],
	["tree-sitter-php", "0.24.2"],
	["tree-sitter-lua", "2.1.3"],
	["tree-sitter-sql", "0.1.0"],
] as const;

for (const [packageName, version] of grammarSpecs) {
	try {
		const module = await import(packageName);
		const parser = new Parser();
		parser.setLanguage(module.default);
		const tree = parser.parse("");
		console.log(
			JSON.stringify({ packageName, version, result: "ok", rootType: tree.rootNode.type }),
		);
	} catch (error) {
		console.log(
			JSON.stringify({
				packageName,
				version,
				result: "error",
				error: String(error).split("\n")[0],
			}),
		);
	}
}
