export default {
	globs: ["STYLE_GUIDE.md", "src/content/docs/**/*.md"],
	config: {
		default: true,
		// Starlight renders the frontmatter title as the page H1.
		MD025: false,
		MD041: false,
		// Reference tables and commands contain intentionally long lines.
		MD013: false,
		// Starlight directives are valid Markdown extensions.
		MD033: false,
		// Compact reference sections sometimes use bold labels.
		MD036: false,
		// Column-width alignment creates large diffs in long reference tables.
		MD060: false,
	},
};
