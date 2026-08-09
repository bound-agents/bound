# Bound documentation style guide

This guide defines the project-specific rules for user-facing documentation in
`packages/docs`. For editorial questions it does not answer, follow the Google developer
documentation style guide.

## Audience

Write for people installing, operating, integrating, or evaluating Bound. Assume readers
can use a terminal and edit JSON, but do not assume they know Bound's architecture.

Explain required domain terms at first use. Link to concepts instead of repeating internal
implementation detail in task-focused pages.

## Information architecture

Every page has one primary purpose:

- **Tutorial:** A guided learning path that produces a working result. Tutorials may make
  choices for the reader and should verify the result.
- **How-to guide:** Steps for completing one practical task. State prerequisites and the
  expected outcome.
- **Concept:** An explanation of how or why the system behaves as it does. Concepts can
  link to related procedures but should not become command catalogs.
- **Reference:** Precise lookup material such as commands, fields, schemas, endpoints, and
  limits. Organize reference pages around the thing being described.

The sidebar category defines the page type. Use `tutorials/`, `guides/`, `concepts/`, and
`reference/` for new URLs when practical, but preserve an established public URL unless a
redirect is part of the same change. The site home page is the only type exception.

Do not combine several page types because they concern the same feature. Link between a
task page, its conceptual explanation, and its reference material.

## Voice and tone

- Address the reader as "you".
- Use active voice and present tense.
- Use imperative verbs for instructions: "Open", "Run", "Set", and "Select".
- Put the action before its explanation when the action is what the reader needs.
- Be direct and matter-of-fact. Do not use marketing claims or conversational filler.
- Avoid "easy", "simple", "simply", "obviously", and "just".
- State limitations and security consequences explicitly.
- Use contractions when they make a sentence sound natural.

## Product terminology

- Use **Bound** for the project, product, or system.
- Use `bound`, `boundctl`, and `boundless` for binaries and commands.
- Refer to `boundless` as "the `boundless` terminal client" on first use.
- Use "web UI", "multi-host", "filesystem", "WebSocket", "GitHub", "JavaScript",
  "OpenAI", "RSS feed", "MCP server", and "API".
- Spell out an uncommon abbreviation at first use.

Keep the terminology list small. Add a Vale rule only when a correction is objective and
repeated often enough to automate.

## Titles and headings

- Use sentence case.
- Use descriptive nouns for concepts and references.
- Start task headings with a verb when practical.
- Do not repeat the page title as an H1. Starlight renders the frontmatter `title` as the
  page H1.
- Do not skip heading levels.
- Keep headings short enough to scan in the table of contents.

## Page openings

The first paragraph must tell the reader what the page covers or what they will accomplish.
Do not start with a restatement of the title.

Tutorials and how-to guides should identify prerequisites before the first procedure. Add a
verification step when the result is not otherwise visible.

## Procedures

- Use a numbered list for ordered steps.
- Put one action in each step.
- Put optional actions after the required path.
- Introduce commands immediately before their code block.
- Explain placeholders before or after the command.
- Include expected output only when readers need it to recognize success.
- Put troubleshooting after the main successful path.

## Code, configuration, and UI text

- Use fenced code blocks with a language identifier.
- Use `text` for output or syntax that has no more specific language.
- Use inline code for commands, filenames, paths, environment variables, fields, endpoint
  paths, and literal values.
- Use bold text for visible UI labels.
- Write UI paths as **Connections > Webhooks > Create**.
- Do not put terminal prompts such as `$` in copyable command blocks.
- Use realistic but non-secret example values.

## Links

- Use descriptive link text; do not use "here" or repeat a raw URL.
- Link to the most specific relevant section.
- Internal site links use the deployed `/bound/` base path.
- Do not duplicate an explanation when a link gives the reader sufficient context.
- External links must point to authoritative project or vendor documentation.

## Frontmatter

Every page must define:

```yaml
---
title: A unique sentence-case title
description: One sentence, no more than 160 characters.
---
```

The description should say what the reader can learn or accomplish. Do not repeat the title
without adding information.

## Tables, callouts, and media

- Use tables for values readers compare or scan, not for sequential instructions.
- Keep table cells concise. Move multi-paragraph explanations below the table.
- Use notes for relevant context, cautions for possible loss or disruption, and danger
  callouts for security or irreversible consequences.
- Add screenshots only when spatial recognition is necessary. Prefer text for workflows
  that may change frequently.
- Give every meaningful image useful alternative text.

## Accessibility

- Do not rely on color alone.
- Use descriptive link text and sequential heading levels.
- Expand acronyms when readers may not know them.
- Avoid directional instructions such as "on the right" unless position is essential.
- Keep sentences and paragraphs focused on one idea.

## Automated checks

Run the full documentation check from this package:

```bash
bun run check
```

The blocking checks validate Markdown structure, frontmatter, sidebar coverage, internal
links, fragments, and the production Astro build. Vale reports narrow prose and terminology
suggestions in CI; its advisory findings do not block a pull request.

## Review checklist

- The page has one primary documentation type.
- The opening states the reader's goal or the page's scope.
- Commands and UI labels use the correct formatting.
- Terminology matches this guide.
- Internal links resolve and new pages appear in the sidebar.
- Examples match current behavior.
- `bun run check` passes.
