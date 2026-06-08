# persona-lab

Fast, reliable persona-iteration harness. Edit `persona.md`, run `compare.ts`,
read a side-by-side across models. Each case runs through the real `AgentLoop`,
so production retry / backoff / empty-completion handling is on the actual path.

## Setup

```sh
cp packages/agent/scripts/persona-lab/persona.example.md \
   packages/agent/scripts/persona-lab/persona.md
# edit persona.md
```

`persona.md` is gitignored on purpose: it's the thing under active iteration, so
keep it local and edit freely without committing on every tweak.

## Run

```sh
bun run packages/agent/scripts/persona-lab/compare.ts
bun run packages/agent/scripts/persona-lab/compare.ts --models opus,gpt-5.5 --prompts colleague-acp
bun run packages/agent/scripts/persona-lab/compare.ts --persona /tmp/alt.md --out /tmp/run.md
```

Flags: `--models`, `--prompts`, `--persona`, `--seed`, `--prompts-file`, `--out`.

## Reliability guards

- Asserts a **new** assistant row was written; never reports a stale seed reply
  as model output (`wroteNew=false` is shown explicitly).
- Warns before a run if estimated input lands in a model's known fault band
  (e.g. GPT-5.5 on Mantle reliably faults ~7k-18k input tokens).
- Deterministic synthetic seed (`seed.json`) - no dependency on a live thread.

## Files

- `compare.ts`   - the runner
- `persona.md`   - your working persona draft (gitignored)
- `persona.example.md` - stub / instructions
- `prompts.json` - named prompts to run
- `seed.json`    - synthetic conversation context (non-sensitive, public-substance)
