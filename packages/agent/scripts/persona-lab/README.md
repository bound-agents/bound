# persona-lab

Fast, reliable persona-iteration harness. Edit `persona.md`, run `compare.ts`,
read a side-by-side across models. Each case runs through the real `AgentLoop`,
so production retry / backoff / empty-completion handling is on the actual path.

## Setup

The working files are gitignored — the repo carries only generic `.example`
templates. Copy the ones you want to edit:

```sh
cd packages/agent/scripts/persona-lab
cp persona.example.md persona.md       # the persona under iteration
cp prompts.example.json prompts.json   # the prompts to run (optional)
cp seed.example.json seed.json         # the conversation context (optional)
# edit persona.md
```

`compare.ts` resolves a working copy if present, else falls back to the
`.example`, so a fresh checkout runs immediately off the templates. The working
copies are gitignored on purpose: they're under active iteration, so keep them
local and edit freely without committing on every tweak.

## Run

`--models` is required — pass backend ids from your `model_backends.json`:

```sh
bun run packages/agent/scripts/persona-lab/compare.ts --models opus,gpt-5.5
bun run packages/agent/scripts/persona-lab/compare.ts --models opus --prompts colleague-debug
bun run packages/agent/scripts/persona-lab/compare.ts --models opus --persona /tmp/alt.md --out /tmp/run.md
```

Flags:

- `--models` (required) — comma list of backend ids
- `--prompts` — comma list of prompt names to run (default: all)
- `--persona` — persona file path (default: `./persona.md`, else `.example`)
- `--seed` — seed transcript json (default: `./seed.json`, else `.example`)
- `--prompts-file` — prompts json (default: `./prompts.json`, else `.example`)
- `--config-dir` — bound config dir holding `model_backends.json`
  (default: `$BOUND_CONFIG_DIR`, else `~/bound/config`)
- `--out` — also write the markdown report to this path

## Reliability guards

- Asserts a **new** assistant row was written; never reports a stale seed reply
  as model output (`wroteNew=false` is shown explicitly when a turn faults).
- Optionally warns before a run if estimated input lands in a model's known
  fault band — copy `fault-bands.example.json` to `fault-bands.json` (gitignored)
  and fill in your own `{ "<backend-id>": [low, high] }` token windows. Absent
  file = no warnings; the committed tool ships with no model-specific data.
- Deterministic synthetic seed — no dependency on a live thread or real
  conversation log.

## Files

Committed (generic, no operational data):

- `compare.ts` — the runner
- `persona.example.md` — stub / instructions
- `prompts.example.json` — generic prompt templates with a self-documenting comment
- `seed.example.json` — fictional conversation context with a self-documenting comment
- `fault-bands.example.json` — optional fault-band format reference

Gitignored (yours, local — copy from the `.example` to use):

- `persona.md` — your working persona draft
- `prompts.json` — your prompts
- `seed.json` — your conversation context
- `fault-bands.json` — your fault-band windows (optional)
