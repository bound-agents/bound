---
title: Manage skills
description: Import, inspect, activate, deactivate, delete, and restore reusable agent instructions.
---

This guide shows how to manage a skill artifact and activate it for one thread. Importing a skill adds it to the catalog; it does not activate the skill.

## Prerequisites

Before you begin, make sure you have:

- A running Bound instance.
- A valid skill directory containing a `SKILL.md` file.
- `boundctl` on your `PATH` for the command-line steps.

## Expected outcome

You will import a reusable skill, inspect it, activate and deactivate it for a single thread, delete it, and restore it when needed.

## Import a skill

### Import in the web UI

1. Open **Connections > Skills > Import**.
2. Select the directory that contains the skill's `SKILL.md` file.
3. Complete the import.

For details about the skill format, see [Skills](/bound/concepts/skills/).

### Import with the CLI

1. Open a terminal.
2. Import the skill directory:

```bash
boundctl skill import <path>
```

For additional command-line guidance, see [CLI operations](/bound/guides/cli-operations/).

## Inspect a skill

1. List the skills in the catalog:

```bash
boundctl skill list
```

1. View a specific skill:

```bash
boundctl skill view <name>
```

Use the displayed name in subsequent activation, deletion, and restore steps.

## Activate a skill for a thread

1. Open the thread where you want to use the skill.
2. Ask the agent:

```text
Activate the <name> skill for this thread.
```

Activation is per-thread. Importing a skill makes it available for activation, but does not activate it in any thread.

For related agent capabilities, see [Agent tools](/bound/reference/agent-tools/).

## Deactivate a skill for a thread

1. Stay in the thread where the skill is active.
2. Ask the agent:

```text
Deactivate the <name> skill for this thread.
```

Deactivation affects that thread only.

## Delete a skill

### Delete in the web UI

1. Open **Connections > Skills**.
2. Select the skill you want to remove.
3. Choose **Delete** and confirm the action.

### Delete with the CLI

1. Open a terminal.
2. Delete the skill:

```bash
boundctl skill delete <name>
```

Deletion soft-deletes the catalog artifact and its files. It does not make claims about context that may already have been assembled for an active turn.

## Restore a skill

1. Re-import the skill directory using the same skill name.
2. Activate it again in any thread where you need it.

## Verify the workflow

1. Confirm that the restored or imported skill appears in the catalog:

```bash
boundctl skill list
```

1. Inspect it to confirm its details:

```bash
boundctl skill view <name>
```

1. In a thread, ask the agent to use the skill and confirm that it follows the skill's instructions.
