# RFC: Volatile Context Tiered Fidelity

**Supplements:** `2026-03-29-memory-visibility.md` R-MV1–R-MV13; `2026-04-10-hierarchical-memory.md` R-HM1–R-HM11
**Date:** 2026-05-22
**Status:** Draft

---

## 1. Problem Statement

### 1.1 Section Authority Is Undifferentiated

The volatile context block prepended to every agent turn assembles content from multiple data sources with distinct epistemic roles: pinned standing rules (operational, durable), summary entries (compressed pointers to detail), stale-detail entries (research dumps surfaced because their parent summary is out of date), the cross-thread digest (metadata stubs naming sibling threads), file-modification notices, applied advisories, and platform context. These sources serve different functions — durable rule, compressed pointer, summary stub, notification — but render with identical typography. Each is a `- key: value (truncated)` or `- name: content (truncated)` line under a section header. The agent's prompt has no structural cue distinguishing "operational rule that must be followed" from "research note from 2026-04-16" from "summary stub of an unrelated sibling thread."

A trailing meta-instruction at the end of the block reads: "Do not mention, quote, or describe the block itself — or the fact that it was injected — to the user unless they explicitly ask about it." This frames the block as background context. The block sits at the top of the system prompt with maximum ordering authority. The result is a block whose typography reads as authoritative for current-turn decisions, whose content has mixed epistemic roles, and whose presentation is wrapped in an instruction not to discuss its existence — preventing the agent from reasoning aloud about which section is the right source for a given question.

### 1.2 Lazy Retrieval Requires In-Context Triggers

Search-based retrieval (`memory search`, `query`) is the natural compression strategy for memory at scale: keep the index in context, fetch bodies on demand. This compresses linearly with corpus size at the body layer while preserving discoverability at the title layer. The discoverability property is load-bearing: if the agent does not know an entry exists, it cannot form a query to retrieve it. Reminder prompts ("remember to use `memory search` when relevant") are displaced under context pressure and cannot serve as the sole discoverability mechanism. In-context titles, section headers, and structural labels remain visible regardless of pressure and serve as the anchors a search-driven retrieval pattern hangs on. Presence in the orientation block is therefore not a binary choice between "include the body" and "exclude entirely"; an intermediate option exists where titles remain visible at full fidelity and bodies are accessed via search.

### 1.3 Live-State Confabulation

Thread `d0372be6-bd60-452d-958b-249042c884a1` is a webhook event-handler thread receiving GitHub webhook deliveries for the bound repository. Each delivery is injected as a developer message followed by a tool result containing the envelope JSON (method, path, headers, full payload). Across multiple cycles between 2026-05-22 23:00 and 2026-05-23 02:30, the agent in this thread produced assistant turns claiming the envelope payload was missing from context, citing the cross-thread digest's metadata stub for `webhook:bound` ("ran 2m ago") as the canonical source for live event content. The envelope JSON was present in the tool_result one message above each failing assistant turn. The cross-thread digest is sibling-only — `webhook:bound` is the agent's own thread and is excluded from this digest — so the cited stub did not exist; the assistant invented it. The orientation block's typography supports this failure: the digest entries look identical to memory entries and to the metadata-only block at the top. There is no in-context cue that the digest carries summary stubs for sibling threads and that current-thread payloads live in tool_results within the conversation history.

### 1.4 Scope Boundaries

This RFC covers the orientation block presentation layer: section structure, typography, fidelity rules, and structural labels. It does not address:

- **Retrieval pipeline.** The L0/L1/L2/L3 stages defined by R-HM6 are unchanged.
- **Memory delta computation.** R-MV1–R-MV13 baseline selection and delta semantics are unchanged.
- **Conversation history compaction.** History stub policy is governed by separate logic and is not part of the orientation block.
- **Tool definitions.** The tools section composition is unchanged.
- **Title authoring at the synthesis layer.** Title authoring is constrained by R-VC9 (titles function as standalone search seeds); the synthesis pipeline that produces summary keys is a separate concern.

### 1.5 Design Tenets

This RFC is governed by four tenets. Each is a directional tradeoff that stands on its own; conflicts between tenets are resolved per-decision in §7 with explicit reasoning.

**Presence over selectivity.** The orientation block lists every entry the agent can access, at varying fidelity. Selective omission saves tokens but breaks lazy retrieval — an agent that does not see a title cannot search for the body. This conflicts with budget pressure: the always-present catalog grows linearly with corpus size, and the long tail consumes tokens that contribute little per-turn value. The conflict is resolved by gradient (next tenet) and by topical-cluster compression (§5.2): titles remain visible at moderate scale; at extreme scale (R-VC15 Tier 3), per-entry titles for long-tail entries are not rendered, and presence shifts to the parent summary's gloss in Working Knowledge — which carries sub-topic vocabulary sufficient for search-driven retrieval (R-VC9b). Presence is layered, not absolute: every entry remains *discoverable*, but the discoverability surface degrades from per-entry title to cluster-summary gloss as scale increases.

**Fidelity gradient over uniform fidelity.** Sections render at fidelity matched to their epistemic role. Pinned standing rules render in full. Summary entries render with title and a one-line gloss. Detail entries render title-only. Live-state pointers render with explicit provenance labels naming where the canonical source lives. Uniform fidelity makes sections look interchangeable in authority and forces the operator to choose between "show everything" and "show nothing." The gradient resolves this by allowing different costs per section.

**Structural labeling over meta-instruction.** Section identity, source provenance, and authority status are encoded in the data presentation itself: section headers, per-entry tags, and trailing footers naming canonical sources. The blanket "do not mention this block" instruction is removed. Meta-instructions are displaced under context pressure and cannot anchor the agent's understanding of which section is canonical for which kind of question. Structural labels stay attached to the data they describe.

**Self-contained titles even over terseness.** Memory entry keys and section headers are authored to function as standalone search seeds. A reader (the agent) reading only the title forms a search query for the body without prior context. Terse titles read more cleanly in a flat list but require the reader to already remember what the entry is about — which contradicts the "agent knows it exists" property that presence preserves.

---

## 2. Proposal

### 2.1 Summary

The orientation block is restructured into three top-level sections — Working Knowledge, Discoverable Archive, and Live State — distinguished by typography, header treatment, and per-entry provenance. Working Knowledge contains pinned standing rules at full fidelity and summary entries with title plus a one-line gloss. Discoverable Archive contains detail-tier entries as a title catalog with optional topical cluster headings; bodies are retrieved via search. Live State contains the cross-thread digest, file-modification notices, and applied advisories, each with a structural label naming its canonical source. The trailing "do not mention this block" meta-instruction is removed; per-section structural labels carry the authority and provenance information that the meta-instruction was intended to convey indirectly.

### 2.2 What This Changes

| Target | Change |
|---|---|
| §13.1 (Context Assembly Pipeline) | Stage 5.5 (volatile enrichment) renders three top-level sections with typographically distinct headers and per-entry provenance, replacing the flat memory section + cross-thread digest + file-mod block layout. |
| `@bound/agent` volatile-context output | Section structure, header format, per-entry rendering, and trailing-instruction policy revised. The data fed by the retrieval pipeline (R-HM6) is unchanged; the rendering layer that consumes it is replaced. |
| R-MV1 (memory delta rendering) | Memory delta entries render under the Working Knowledge header with a delta marker (`[changed since last turn]`) on each line. The standalone memory delta callout is removed; deltas are flagged in place. |
| R-HM6 stage tags | Stage tags (`[pinned]`, `[summary]`, `[stale-detail]`, `[graph]`, `[recency]`) remain in the data layer and become the basis for fidelity dispatch in the rendering layer. The visible per-entry tag is replaced by the section assignment plus a per-section header. |
| Detail-tier rendering (R-HM6 stage 4 entries) | Detail-tier entries render as title-only catalog entries under the Discoverable Archive header. Body access is via `memory search` or `query`. R-HM7 stale-children handling is preserved: children load alongside their parent summary in Working Knowledge when stale. |
| Detail-tier retrieval (new R-VC4 sibling stage) | The Discoverable Archive's contents are populated by a new retrieval stage that enumerates `tier='detail' AND deleted IS NOT 1` directly via SELECT, independent of R-HM6's L0/L1/L2/L3 slot accounting. R-HM6 continues to drive Working Knowledge selection unchanged; the new stage runs alongside it and feeds the Discoverable Archive renderer. This is a data-layer addition, not a presentation-layer-only change. |
| Cross-thread digest (`buildCrossThreadDigest`) | Entries gain a fixed footer: `[summary stubs of sibling threads — current-thread event payloads live in your tool_results]`. The 300-character per-thread summary excerpt is removed; sibling-thread summary content is accessed via `query` against the threads table when relevant. |
| Trailing meta-instruction ("Do not mention…") | Removed. |
| Memory key authoring contract | Memory keys produced by the synthesis layer function as search seeds — see R-VC9. The synthesis pipeline is updated separately; this RFC defines the contract. |
| `semantic_memory` indexes | New partial index `idx_memory_detail_recency ON semantic_memory(last_accessed_at DESC) WHERE tier='detail' AND deleted=0` ships alongside the rendering change to support R-VC4's unbounded SELECT (§4.1). Existing indexes are unchanged. |
| `loadGraphEntries` tag emission | Normalized to a single `[graph]` tag at the loader boundary (`summary-extraction.ts:959`), replacing the prior `[seed]` and `` `[depth ${depth}, ${relation}]` `` outputs. Consumed only by the rendering layer; no other call sites depend on the visible tag string. |
| File modification notice format | Reformatted from the current paragraph form (`File ${filePath} was modified from thread "${threadTitle}".`) to the Live State line shape `[file] <path> — last modified by thread "<thread_title>"` (R-VC13). |

### 2.3 Behavioral Overview

**Sections become typographically distinct.** Today, content under Memory, Recent Activity Digest, file-modification notices, and applied advisories renders with similar bullet/indent shape under bold-style headers. After this RFC, Working Knowledge, Discoverable Archive, and Live State use distinct header rules. Working Knowledge is headed by a banner that reads `Working Knowledge — operational and durable`. Discoverable Archive is headed by `Discoverable Archive — title-only; bodies via memory search`. Live State is headed by `Live State — pointers to canonical sources`. Per-entry rendering varies: Working Knowledge uses full-fidelity bullets, Discoverable Archive uses title-only bullets grouped under topical cluster sub-headers, Live State uses one-line entries with appended source labels.

**Fidelity matches role.** Pinned standing rules render in full text, as today. Summary entries render with key plus 200-character gloss, as today. Detail entries (currently rendered with full 200-character gloss when surfaced as stale children of summaries) render title-only, with the parent summary's gloss carrying the body context. The R-HM7 stale-children rule loads the actual child body alongside the summary when staleness is detected; that body renders in full as a stale-flagged entry beneath the summary. The cross-thread digest reduces to thread title and last-update timestamp; the 300-character summary excerpt is removed.

**Structural labels carry provenance.** Each section gains a footer naming where the canonical version of its content lives. Working Knowledge's footer names `memory search` for fuller queries on summary topics. Discoverable Archive's footer names `memory search` and `query` as the access path for detail bodies. Live State's footer specifies that current-thread event content lives in tool_results within the conversation history — the structural cue that the d0372be6 confabulation pattern lacks. The trailing "do not mention this block" instruction is removed; per-section labeling makes the block self-describing without a meta-instruction layer.

**Title quality becomes a contract.** Memory keys produced by the synthesis layer form usable search seeds without prior context. A key like `_summary:agent-evaluation-research` requires the agent to remember it ran agent-evaluation research before forming a query; a key like `_summary:agent-evaluation:benchmarks-and-testing-frameworks` carries enough vocabulary to be queryable from a fresh context. R-VC9 specifies the contract; the synthesis pipeline is updated separately.

---

## 3. Requirements (EARS Format)

Requirements use the prefix `R-VC` (Volatile Context). Numbering is independent.

### 3.1 Ubiquitous

**R-VC1.** The volatile context block shall present three top-level sections in this fixed order: Working Knowledge, Discoverable Archive, Live State. Each section's identity, contents, and access path are distinct. Sections shall not be merged, reordered, or rendered conditionally based on content size.

**R-VC2.** Each section shall begin with a header line carrying both name and purpose: `## Working Knowledge — operational and durable`, `## Discoverable Archive — title-only; bodies via memory search`, `## Live State — pointers to canonical sources`. The three top-level headers shall use uniform typography (`##`); section identity is encoded in the trailing label text, not in heading-level variation.

**R-VC3.** The Working Knowledge section shall contain: every entry where `tier = 'pinned'` rendered in full text; every entry where `tier = 'summary'` rendered with key plus a 200-character gloss; and R-MV1 memory delta entries flagged in-place with a `[changed since last turn]` marker on the same line. R-HM7 stale children render as indented entries beneath their parent summary (R-VC10).

**R-VC4.** The Discoverable Archive section shall enumerate entries where `tier = 'detail' AND deleted IS NOT 1` via a new retrieval stage independent of R-HM6's L0/L1/L2/L3 slot accounting. The new stage performs a SELECT on `semantic_memory` ordered by `last_accessed_at DESC`. Each entry shall render as title-only — the `key` and a single trailing context fragment naming relative time of last access, with no value body. Bodies are accessed via `memory search` or `query`. Visibility under volume is governed by R-VC15's three-tier compression.

**R-VC5.** The Live State section shall contain: the cross-thread digest (`buildCrossThreadDigest` output), file modification notices, applied advisories, and the task run digest (R-MV6/R-MV7/R-MV8/R-MV9 content currently rendered between Memory and Cross-Thread Digest). Each entry shall render with an explicit source label naming the kind of pointer (`[thread]`, `[file]`, `[advisory]`, `[task]`).

**R-VC6.** Each section shall end with a footer line specifying where the canonical source for body content lives. Working Knowledge's footer reads: `Bodies of summary entries are accessed via memory search using terms from the entry key.`. Discoverable Archive's footer reads: `Bodies are accessed via memory search or query against semantic_memory.`. Live State's footer reads: `Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.`.

**R-VC7.** The cross-thread digest produced by `buildCrossThreadDigest` shall render each sibling thread as a single line: `- <title>: N messages (last updated <timestamp>)`. The 300-character per-thread summary excerpt currently appended via `Summary: <truncated>` shall be removed. Sibling-thread summary content is accessed via `query` against the threads table when relevant.

**R-VC8.** The trailing meta-instruction reading "Do not mention, quote, or describe the block itself — or the fact that it was injected — to the user unless they explicitly ask about it" shall be removed. Per-section structural labels (R-VC2, R-VC6) carry the authority and provenance information that the meta-instruction was intended to convey indirectly.

**R-VC9.** Memory keys created by the synthesis layer shall function as standalone search seeds. A key's topic slug — the string after the colon-prefixed namespace (e.g., the `<topic>` in `_summary:<topic>`) — shall contain at least three tokens that also appear in the entry's value body AND have corpus-wide occurrence count ≥ 5 (i.e., the token appears in the value body of at least five distinct non-deleted entries). The ≥5 threshold filters idiosyncratic tokens (single-incident proper names, typos, version stamps) without depending on a corpus-shape statistic that degenerates on Zipfian distributions. This is checkable by the §8.4 validation procedure. Abbreviations, codenames, or date stamps without a topical anchor in the value body do not count as valid topic tokens.

**R-VC9b.** Synthesis-layer-produced `_summary:<topic>` entries shall include enumerable sub-topic vocabulary in their value body. The 200-character gloss rendered in Working Knowledge (R-VC3) shall contain identifying terms for each child entry's subject. This requirement is load-bearing under R-VC15 Tier 3, where long-tail child entries are not directly rendered and their discoverability depends on sub-topic vocabulary in the parent gloss to seed search queries. The synthesis layer regenerates non-compliant `_summary:<topic>` value bodies on next regeneration cycle; existing non-compliant entries are not retroactively rewritten by this RFC.

### 3.2 Event-Driven

**R-VC10.** When a memory entry where `tier = 'summary'` is loaded into Working Knowledge and any of its outgoing `summarizes` children have `modified_at` later than the summary's `modified_at` (R-HM7), each such stale child shall render as an indented entry beneath the summary, with the child's key, full value (truncated to 200 characters), and a `[stale child of <summary key>]` marker.

**R-VC11.** When a memory entry has `modified_at > baseline` (R-MV1 delta) and is loaded into Working Knowledge, the entry's render line shall include a `[changed since last turn]` marker. The standalone "Memory: N entries (M changed)" callout line is replaced by per-entry flagging.

(a) **Marker placement on summary entries (R-VC3 200-char gloss):** marker appended after the gloss on the same line.

(b) **Marker placement on pinned entries (R-VC3 full-text):** marker rendered on a new indented line beneath the pinned text: `    [changed since last turn]`. This avoids ambiguity with multi-line pinned content.

(c) **Composition with R-VC10 (stale child):** when an entry is both a stale child and a delta — the most common case, since staleness implies recent modification — both markers shall render in the fixed order `[stale child of <summary key>] [changed since last turn]`.

(d) **R-MV5 preservation:** the marker computation is a delta-read; the implementation must not invoke any code path that updates `last_accessed_at` while building the marker.

**R-VC12.** When an advisory was applied (status = 'applied') within the prior 24 hours, the advisory shall render under Live State as `[advisory] <title> — applied <relative_time>`; the advisory body is accessed via `query` against the advisories table.

**R-VC13.** When a file modification notice is generated (R-E20), the notice shall render under Live State as `[file] <path> — last modified by thread "<thread_title>"`; the file body is accessed via `boundless_read` or equivalent.

### 3.3 State-Driven

**R-VC14.** While the context budget (§13.1 Stage 7) is critically constrained, the rendering layer shall apply tier-aware shedding without violating the presence invariant: Live State entries are reduced to the most recent 3 of each subsystem (cross-thread, file, advisory, task digest); Discoverable Archive entries continue to render as titles but their per-entry context fragment is dropped; Working Knowledge entries are preserved at full fidelity. The R-HM9 retrieval-layer shedding (recency-first, then graph) is the upstream control; this requirement governs presentation when the upstream output exceeds budget.

**Reconciliation with R-MV13.** R-MV13's "memory delta and task run digest truncated to 3 each" is superseded for the memory-delta case under this RFC. Deltas live in-place inside Working Knowledge (R-VC11), and Working Knowledge is preserved at full fidelity under budget pressure (presence invariant). Task-digest shedding under budget pressure remains governed by R-MV13 via R-VC14's Live State subsystem rule (3 most recent task entries).

**R-VC15.** The Discoverable Archive renders entries under a three-tier compression scheme based on entry count. Tunables: `BOUND_VC15_N` (default 1000), `BOUND_VC15_M` (default 20).

- **Tier 1 (≤200 entries):** flat title list, sorted by `last_accessed_at DESC`. No cluster headings.
- **Tier 2 (>200, ≤N entries):** cluster compression. Each cluster renders under `### <cluster_name> (<count> entries)` with all entry titles listed beneath, sorted by `last_accessed_at DESC` within cluster. Clusters sorted by entry count descending, ties broken by cluster name ascending. Cluster names are derived from `summarizes` edges: an entry whose parent summary is `_summary:<topic>` belongs to the `<topic>` cluster. Entries without a parent summary render under `### Uncategorized (<count> entries)`.
- **Tier 3 (>N entries):** cluster heading-only compression. Each cluster renders under `### <cluster_name> (<total_count> entries, showing M most recent)` with the M most recent entry titles (by `last_accessed_at DESC`) listed beneath. The long tail is not rendered. Discoverability for unrendered entries depends on R-VC9b sub-topic vocabulary in the parent summary's gloss in Working Knowledge.

When Tier 3 is active, the `Uncategorized` cluster surfaces a `[synthesis-backlog] {N} uncategorized detail entries` line in Live State if N exceeds 50, since uncategorized entries have no parent summary and their long-tail loss has no R-VC9b mitigation. The `[synthesis-backlog]` label distinguishes this synthetic line from `[advisory]` entries, which are backed by rows in the `advisories` table.

### 3.4 Optional / Deferred

**R-VC16 (deferred).** Per-section search-hint customization — alternate footer text per section for tooling integrations that expose different retrieval mechanisms — is deferred. The fixed footer text in R-VC6 is the initial deployment.

**R-VC17 (retired, folded into R-VC15).** Multi-level cluster compression was originally deferred. With R-VC15's three-tier compression specifying Tier 3 long-tail collapse, the original R-VC17 concern (cluster-level compression at higher scale) is addressed. Further cluster-of-clusters grouping at extreme scale (e.g., edge-graph community detection) remains deferred.

**R-VC18 (deferred).** Source-citation enrichment — appending document-level provenance tags to memory entries that originated from external sources (URLs, GitHub permalinks) — is deferred. The current per-entry source field (`semantic_memory.source`) remains the authority for provenance.

### 3.5 Unwanted Behavior

**R-VC19.** The volatile context block shall not include any meta-instruction directing the agent to suppress mention or description of the block itself. Section authority is encoded in section headers and footers (R-VC2, R-VC6), not in suppression instructions.

**R-VC20.** The Discoverable Archive section shall not render value bodies (truncated or otherwise) for any entry. Title-only is the contract; body access is via `memory search` or `query`.

**R-VC21.** The rendering layer shall not omit a memory entry's title from the volatile context based on budget pressure. Titles render at all budget levels; only fidelity (gloss vs. title-only vs. context fragment) varies. This preserves the presence invariant from §1.5.

**R-VC22.** The three top-level section headers (Working Knowledge, Discoverable Archive, Live State) shall not be rendered with typography that varies between sections. Typographic uniformity at the top-level header level prevents inadvertent authority gradients; differentiation lives in the trailing label text (R-VC2). Sub-cluster headings inside Discoverable Archive (R-VC15) are deeper-level headings (`###`) and are not subject to this rule.

**R-VC23.** The cross-thread digest shall not render any sibling thread's summary excerpt; only title, message count, and last-updated timestamp are rendered (R-VC7). This is the structural fix for the d0372be6 confabulation pattern (§1.3) — the typographic similarity between summary excerpts and ground-truth content is what enables the agent to mistake digest stubs for live state.

**R-VC24 (suffix-prefix split).** The volatile context block shall be partitioned at render time into a stable prefix and a varying tail, dispatched to the LLM driver across the cache boundary.

- **Stable prefix** (cacheable, sent on the `system` provider param): Working Knowledge bodies (pinned + summary entries, no markers), Discoverable Archive titles, and the active skill index.
- **Varying tail** (uncached, sent as a `developer`-role message after history): Working Knowledge update markers (`[changed since last turn]`, `[stale child of <parent>]`), the entire Live State section (cross-thread digest, task digest, file modifications, applied advisories, synthesis backlog), the User/Thread ID line, relay/platform/model context, retired-skill notifications, advisory feedback notifications, inactive-skill references, and any operator-supplied `system_prompt_addition`.

The split is structural: each renderer (`renderWorkingKnowledge`, `renderDiscoverableArchive`, `renderLiveState`) is responsible for emitting its content into the correct channel. `renderWorkingKnowledge` returns `{ stableLines, varyingLines }` where varying carries keyed update references (`- <key> [changed since last turn]`, `- <key>: <gloss> [stale child of <parent>]`); the stable side carries plain bodies. `renderDiscoverableArchive` is fully stable (titles only). `renderLiveState` is fully varying.

The contract holds across all three composer call sites: the primary cold-path (`buildVolatileContext`), the no-history task path, and the budget-pressure rebuild path. Under budget pressure (R-VC14), the rebuild rewrites only the varying tail; the stable prefix is preserved verbatim because it is bounded (full-fidelity Working Knowledge is finite per the presence invariant; Discoverable Archive titles are bounded by R-VC15 tunables) and editing systemPrompt mid-assembly is structurally infeasible.

**Why folded into systemPrompt rather than a pre-history developer message.** The bridge layer (`packages/llm/src/ai-sdk-bridge.ts`) merges `developer`-role messages into the next adjacent user message wrapped in `<system-context>`. A pre-history developer message would therefore alter the first user message's content and lose byte stability across threads, defeating cross-thread cache reuse. Folding stable lines into `systemParts` places them inside the existing system-level cache breakpoint, which the driver applies at the end of the `system` param. This delivers genuine cross-thread cache reuse: cron tasks running in the same TTL window over different threads share an identical cached prefix.

---

## 4. Data Model Changes

### 4.1 Schema

One additive index, no table-shape changes. The RFC is otherwise a presentation-layer revision and reuses existing data:

**New index (required by R-VC4):**

```sql
CREATE INDEX IF NOT EXISTS idx_memory_detail_recency
    ON semantic_memory(last_accessed_at DESC)
    WHERE tier = 'detail' AND deleted = 0;
```

R-VC4's SELECT (`tier='detail' AND deleted IS NOT 1 ORDER BY last_accessed_at DESC`) runs unbounded on every assembly. Existing indexes (`idx_memory_key`, `idx_memory_modified`, `idx_memory_tier`) do not support the ordering, so without this index the query degrades to a full tablescan + sort on each turn. The partial-index predicate matches the SELECT's WHERE clause exactly, keeping the index small and write-cost low. The index ships in the same migration as the rendering-layer change.

**Existing data reused:**

| Field | Source | Notes |
|---|---|---|
| `semantic_memory.tier` | R-HM1 | Drives section assignment: `pinned` and `summary` → Working Knowledge; `detail` → Discoverable Archive. |
| `memory_edges` (relation `summarizes`) | R-HM3 | Drives stale-child detection (R-HM7 / R-VC10) and topical-cluster grouping (R-VC15). |
| `semantic_memory.modified_at` | base spec | Drives R-MV1 delta flagging (R-VC11). |
| `threads.summary` | base spec | No longer rendered inline in the cross-thread digest (R-VC7). Accessed via `query` when relevant. |
| `advisories.status` | base spec | Drives Live State advisory rendering (R-VC12). |

### 4.2 Volatile Context Block Format

The volatile context block emitted by `buildVolatileContext` (`packages/agent/src/context-assembly.ts:164`) takes the following structure after this RFC. Section order is fixed per R-VC1. The example below shows the block at R-VC15 Tier 2 (200 < |detail entries| ≤ N); Tier 1 and Tier 3 variants are described in §5.2.

```
{platform context lines}
{current model line}

## Working Knowledge — operational and durable

- {pinned_key}: {full pinned text}
    [changed since last turn]
- {pinned_key}: {full pinned text}
...
- {summary_key}: {200-char gloss}
  - {stale_child_key}: {200-char child body} [stale child of {summary_key}] [changed since last turn]
- {summary_key}: {200-char gloss} [changed since last turn]
...

Bodies of summary entries are accessed via memory search using terms from the entry key.

## Discoverable Archive — title-only; bodies via memory search

### {topical_cluster_name} ({N} entries)
- {detail_key} (last accessed {relative_time})
- {detail_key} (last accessed {relative_time})
...

### Uncategorized ({N} entries)
- {detail_key} (last accessed {relative_time})
...

Bodies are accessed via memory search or query against semantic_memory.

## Live State — pointers to canonical sources

- [thread] {sibling_thread_title}: {N} messages (last updated {timestamp})
- [thread] {sibling_thread_title}: {N} messages (last updated {timestamp})
...
- [task] {task_id} ({task_type}): run_count={N}, last_run_at={timestamp}, status={status}
...
- [file] {path} — last modified by thread "{thread_title}"
...
- [advisory] {title} — applied {relative_time}
...

Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.
```

The block ends after the Live State footer. No trailing meta-instruction is appended (R-VC8).

---

## 5. Behavioral Descriptions

### 5.1 Working Knowledge Assembly

When `buildVolatileContext` assembles the orientation block:

1. Call `loadPinnedEntries(db)` (`packages/agent/src/summary-extraction.ts:747`). Render each entry on its own line with full text: `- {key}: {value}`. No truncation.
2. Call `loadSummaryEntries(db, exclusionSet)` (`:800`). For each summary entry, render `- {key}: {value, truncated to 200 chars}`. If the entry's `modified_at > baseline`, append ` [changed since last turn]`.
3. For each summary entry loaded in step 2, query outgoing `summarizes` edges. For each child where `child.modified_at > summary.modified_at` (R-HM7 staleness), render an indented child entry beneath the parent: `  - {child_key}: {child_value, truncated to 200 chars} [stale child of {summary_key}]`.
4. Append the section footer: `Bodies of summary entries are accessed via memory search using terms from the entry key.`

R-MV1 memory delta entries are not rendered as a standalone callout. The delta marker is applied per-entry in step 2.

### 5.2 Discoverable Archive Assembly

Detail-tier entries are produced by the new R-VC4 retrieval stage — a single SELECT statement independent of R-HM6's slot accounting. The SELECT is intentionally unbounded (no `LIMIT`); R-VC15's three-tier compression bounds the rendered output, not the underlying query. The rendering layer applies R-VC15's three-tier compression based on the entry count returned:

1. Execute `SELECT key, last_accessed_at FROM semantic_memory WHERE tier = 'detail' AND deleted IS NOT 1 ORDER BY last_accessed_at DESC`. The result count determines tier.
2. De-duplicate against R-HM7 stale children already routed to Working Knowledge (§6.4): for each key in the result set, drop the entry if it is also rendered as a stale child in Working Knowledge.
3. Apply tier-specific rendering:

**Tier 1 (≤200 entries):** Render the full result set as a flat title list. Each entry produces `- {key} (last accessed {relative_time})`. No cluster sub-headers.

**Tier 2 (>200, ≤N entries; N tunable, default 1000):** Apply topical clustering.
   a. For each entry, look up its parent summary via incoming `summarizes` edges. The parent's `_summary:<topic>` key yields the cluster name `<topic>`.
   b. Entries without a parent summary go to the `Uncategorized` cluster.
   c. Sort clusters by entry count descending, ties broken by cluster name ascending.
   d. Within each cluster, sort entries by `last_accessed_at DESC`.
   e. Render each cluster as `### {cluster_name} ({count} entries)`, followed by all entry titles.

**Tier 3 (>N entries; M tunable, default 20):** Apply heading-only compression.
   a. Same clustering and ordering as Tier 2.
   b. Within each cluster, render only the M most recent entries (by `last_accessed_at DESC`).
   c. Render each cluster as `### {cluster_name} ({total_count} entries, showing M most recent)`, followed by the M-entry tail.
   d. The long tail of each cluster is not rendered. Discoverability for unrendered entries depends on R-VC9b sub-topic vocabulary in the parent summary's gloss in Working Knowledge.
   e. If the `Uncategorized` cluster contains more than 50 entries, append `[synthesis-backlog] {N} uncategorized detail entries` to Live State (R-VC15 trailing rule). The label `[synthesis-backlog]` is distinct from `[advisory]` because the entry is computed inline from R-VC4 retrieval state and is not backed by a row in the `advisories` table.

4. Append the section footer: `Bodies are accessed via memory search or query against semantic_memory.`

Under critical budget pressure (R-VC14), the per-entry context fragment `(last accessed {relative_time})` is dropped at all tiers; entries render as `- {key}` only. Cluster sub-headers and entry counts are preserved.

Tunables `BOUND_VC15_N` and `BOUND_VC15_M` are read at assembly time. Test fixtures override via environment variables to exercise tier transitions deterministically.

### 5.3 Live State Assembly

The Live State section assembles four subsystems:

1. **Cross-thread digest.** Call `buildCrossThreadDigest(db, userId, currentThreadId)` (`packages/agent/src/summary-extraction.ts:364`). Render each returned thread as `- [thread] {title}: {messageCount} messages (last updated {last_message_at})`. The `Summary: <truncated>` line currently emitted at `:409` is removed (R-VC7, R-VC23).

2. **Task run digest.** Render the existing task-digest content (R-MV6/R-MV7/R-MV8/R-MV9) with one entry per line: `- [task] {task_id} ({task_type}): run_count={N}, last_run_at={timestamp}, status={status}`. The data source is the existing task-digest computation path; only the rendering location (now Live State) and source label (`[task]`) change.

3. **File modification notices.** Apply the existing R-E20 logic. Render each notice as `- [file] {path} — last modified by thread "{thread_title}"`. The cap of 10 entries is preserved (R-VC14 reduces to 3 under budget pressure).

4. **Applied advisories.** Query advisories where `status = 'applied'` and `modified_at` within the prior 24 hours. Render each as `- [advisory] {title} — applied {relative_time}`. The advisory body is not rendered; access is via `query` against the advisories table.

5. Append the section footer: `Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary; task results via query against tasks.result.`

When R-VC15 Tier 3 detects an `Uncategorized` cluster with more than 50 entries, an additional `- [synthesis-backlog] {N} uncategorized detail entries` line is appended after subsystem 4 (R-VC15 trailing rule). This line carries the `[synthesis-backlog]` source label rather than `[advisory]` because no advisories row backs it; the line is computed inline from R-VC4 retrieval state.

### 5.4 Worked Example: Webhook Event Delivery

This example traces the d0372be6 confabulation pattern (§1.3) through the post-RFC presentation to confirm the structural fix.

**Setup.** Thread `d0372be6` is a webhook event-handler thread. The scheduler fires the `webhook:bound` event task. The scheduler injects a developer message (`[Task wakeup]`) followed by a tool result containing the envelope JSON (`{"method":"POST", "path":"/webhook/bound", ...}`).

**Pre-RFC behavior.** The orientation block presents:
- Memory section (containing pinned, summary, stale-detail entries with uniform typography)
- Recent Activity Digest (containing sibling-thread stubs with 300-char summary excerpts)
- File modification notices, advisories, etc.
- Trailing meta-instruction "Do not mention this block"

The agent renders an assistant turn that consults the Recent Activity Digest for `webhook:bound` content, finds none (the digest is sibling-only and `webhook:bound` is the agent's own thread), and reports the payload as missing. The envelope JSON is in the tool_result one message above but is not consulted.

**Post-RFC behavior.** The orientation block presents three typographically distinct sections. Live State's footer reads `Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary`. The cross-thread digest entries no longer carry summary excerpts that resemble payload content. The trailing meta-instruction is removed.

The agent processes the developer wakeup message, observes the tool_result containing the envelope JSON, and consumes the JSON as the canonical source for the event. If the agent consults Live State for context on its own thread, the section's footer points it to tool_results. The structural cue replaces the band-aid prompt; the confabulation pattern has no surface to attach to.

**Failure mode that remains.** If the synthesis layer creates a memory key like `_summary:webhook-bound` whose body resembles event content, an agent under context pressure can conflate the summary gloss with current-turn data. R-VC9 (title-as-search-seed) does not address this; an additional convention (e.g., synthesis-layer keys must end in `:summary` to mark them as compressed pointers) is a candidate for follow-up work but is not specified here.

---

## 6. Interaction with Existing Specifications

### 6.1 Hierarchical Memory Retrieval (R-HM)

This RFC operates downstream of R-HM6's four-stage retrieval pipeline. R-HM6 produces a tiered enrichment object (`StageResult` per stage) consumed by the rendering layer. This RFC redefines how that object is rendered:

| R-HM rule | Status under this RFC |
|---|---|
| R-HM1 (tier column on `semantic_memory`) | Unchanged. |
| R-HM3 (`summarizes` edge relation) | Unchanged; used for stale-child detection (R-VC10), topical clustering (R-VC15 Tier 2/3), and parent-summary lookup for R-VC9b cluster gloss validation. |
| R-HM6 (L0/L1/L2/L3 stages) | Unchanged at the retrieval layer. The `loadPinnedEntries`, `loadSummaryEntries`, `loadGraphEntries`, `loadRecencyEntries` functions in `packages/agent/src/summary-extraction.ts` (`:747`, `:800`, `:898`, `:992`) continue to drive Working Knowledge selection. R-VC4 adds a new sibling retrieval stage that enumerates detail-tier entries directly via `SELECT ... WHERE tier='detail' AND deleted IS NOT 1 ORDER BY last_accessed_at DESC`, independent of R-HM6's slot accounting. The new stage produces Discoverable Archive content; R-HM6 produces Working Knowledge content. The two pipelines do not share slot budgets. |
| R-HM7 (stale children loaded with summary) | Preserved with new rendering: stale children render indented beneath their parent in Working Knowledge (R-VC10). When a stale child is also a delta (R-VC11), both markers render per the R-VC11(c) composition rule. |
| R-HM8 (stage tagging) | Preserved at the data layer, with one normalization. `loadGraphEntries` (`packages/agent/src/summary-extraction.ts:898`) currently emits `"[seed]"` or `` `[depth ${depth}, ${relation}]` `` (e.g. `[depth 2, informs]`) per `:959`; this is normalized to a single `"[graph]"` tag at the loader boundary so the §6.4 dispatch table can route on a flat tag set. The seed-vs-depth provenance is retrievable from the `memory_edges` graph if a future caller needs it; the visible string is dropped from rendered output regardless (section assignment carries the role). The other tags (`[pinned]` `:784`, `[summary]` `:837`, `[stale-detail]` `:881`, `[recency]` `:1051`) are unchanged. |
| R-HM9 (graceful degradation: shed recency first, then graph) | Preserved at the retrieval layer for R-HM6's pipeline. R-VC14 adds a presentation-layer shedding rule (drop per-entry context fragments before dropping titles) that runs after R-HM9 for Working Knowledge content. The R-VC4 sibling retrieval stage uses R-VC15's tier compression (Tier 1/2/3) for its own scaling, not R-HM9. |
| R-HM10 (`maxMemory` budget) | Unchanged for R-HM6's pipeline. The `maxMemory` parameter on `buildVolatileEnrichment` continues to bound stage 3 + stage 4 entry counts. R-VC4's sibling stage is bounded by R-VC15 tunables (`BOUND_VC15_N`, `BOUND_VC15_M`), not `maxMemory`. |

### 6.2 Memory & Task Visibility in Context Assembly (R-MV)

R-MV1's memory delta concept is preserved but rendered in-place rather than as a standalone callout. Two of the upstream rules cited in the prior draft were misattributed and have been corrected; rows for the actual task-digest requirements (R-MV6/R-MV7/R-MV8/R-MV9) are added.

| R-MV rule | Status under this RFC |
|---|---|
| R-MV1 (memory delta listing entries with `modified_at > baseline`) | Preserved at the data layer. Render changes from a standalone "Memory Delta" callout to a per-entry `[changed since last turn]` marker appended to the gloss in Working Knowledge (R-VC11). |
| R-MV2 (cap at 10 entries) | Preserved. The cap continues to govern how many delta entries surface; entries beyond the cap remain accessible via `query`. |
| R-MV3 (tombstoned entries render as `[forgotten]`) | Preserved. The forgotten-entry rendering produced by `formatMemoryEntry` (`:548–:557`) continues unchanged. |
| R-MV4 (baseline fallback chain) | Unchanged. |
| R-MV5 (delta reads do not update `last_accessed_at`) | Unchanged. **Implementation note:** R-VC11's in-place delta flagging is a delta-read computation (R-VC11(d)); the implementation must not invoke any code path that updates `last_accessed_at` while building the marker, or R-MV5 is silently violated. |
| R-MV6 / R-MV7 / R-MV8 / R-MV9 (task run digest content: most-recent task runs with `run_count`, `last_run_at`, `status`, completion summary) | Preserved at the data layer. Per R-VC5, the task-run-digest content renders under the Live State section with `[task]` source labels, replacing its current physical location between Memory and Cross-Thread Digest. |
| R-MV12 (memory delta + task run digest computed from local DB state at assembly time; sync-dependent visibility) | Preserved unchanged. R-VC11 in-place delta flagging and the task-digest preservation in Live State (R-VC5) both inherit the local-DB-state semantics; cross-host visibility remains gated on changelog delivery. |
| R-MV13 (under critical budget, memory delta + task run digest truncated to 3 each before history truncation) | Superseded for the memory-delta case under this RFC. Per R-VC14 + R-VC11, deltas live in-place inside Working Knowledge, which is preserved at full fidelity under budget pressure (presence invariant). Task-digest shedding under budget pressure is governed by R-VC14's Live State subsystem rule (3 most recent task entries), which encodes R-MV13's task-digest half. |

### 6.3 Context Assembly Pipeline — `packages/agent/src/context-assembly.ts`

The `buildVolatileContext` function (`:164`) is the integration point. The current implementation:

- Constructs `suffixLines` accumulator (`:182`).
- Calls `buildVolatileEnrichment` at `:240` for the primary path and `:1793`, `:1954` for the no-history task path and the budget-pressure rebuild path.
- Pushes a `Memory: ${totalMemCount} entries (...)` header line at `:268`.
- Pushes the memory delta lines at `:270`.
- Pushes the task digest lines at `:273`.
- Calls `buildCrossThreadDigest` at `:281` and pushes its output at `:284`.
- Iterates file-modification notices at `:305`.
- Appends the trailing meta-instruction (which this RFC removes per R-VC8).

After this RFC:

- The `Memory:` header line and the rendering of pinned + summary + stale-children entries become the Working Knowledge section.
- Detail-tier entries surfaced via the new R-VC4 retrieval stage become the Discoverable Archive section under their own header, rendered title-only with R-VC15 tiered compression.
- The cross-thread digest output, file modification notices, applied advisories, and the task run digest all become subsystems of the Live State section.
- The trailing meta-instruction is removed. Each section ends with its own footer (R-VC6).
- The `rebuildWarmSections` path (`:2229`) follows the same section structure.

**Suffix-prefix split (R-VC24).** `composeVolatileSections` returns `{ stableLines, varyingLines, synthesisBacklogCount }`. `buildVolatileContext` accumulates separate `stableLines` and `varyingLines` buffers in addition to the legacy `suffixLines` (the union of both, retained for snapshot fixtures, debug accounting, and the budget-pressure splice). `assembleContext` defers building `systemPrompt` until after both Stage 5.5 (no-history) and Stage 6 (primary) have run, so the volatile stable subsection (Working Knowledge bodies + Discoverable Archive titles + skill index) can be appended to `systemParts` before serialization. The varying tail rides as a single developer-role message at the assembled tail. The driver receives `system: systemPrompt` and `messages: [...history, dev(varying)]`; the system-level cache breakpoint covers the stable prefix automatically.

The budget-pressure rebuild path (`applyReducedEnrichment`) uses the varying-only enrichment indices (`varyingEnrichmentStartIdx` / `varyingEnrichmentEndIdx`) into `allVaryingLines` to splice ONLY the varying tail. The stable prefix is not edited under budget pressure: it is bounded (Working Knowledge runs at full fidelity per the presence invariant; Discoverable Archive titles are bounded by R-VC15 tunables) and `systemPrompt` is already serialized by that stage.

### 6.4 Memory Rendering — `packages/agent/src/summary-extraction.ts`

`formatMemoryEntry` (`:542`) is replaced by three rendering helpers, one per section. The `tag` field on `StageEntry` (`:510`) drives the dispatch for R-HM6-sourced entries; the new R-VC4 retrieval stage produces its own entry list that bypasses `tag` dispatch entirely and routes directly to the Discoverable Archive renderer:

- `[pinned]` and `[summary]` tags route to the Working Knowledge renderer (full-text or 200-char-gloss output).
- `[stale-detail]` tag (R-HM7 stale children loaded alongside their parent summary) routes to the Working Knowledge renderer as an indented entry beneath the parent.
- `[graph]` and `[recency]` tags route to the Discoverable Archive renderer (title-only). `[graph]` is the normalized tag emitted by `loadGraphEntries` after this RFC; the prior `[seed]` / `[depth N, relation]` variants (`:959`) are folded into the single `[graph]` value as part of the §6.1 R-HM8 normalization.
- R-VC4 sibling-stage entries (`tier='detail' AND deleted IS NOT 1`) route to the Discoverable Archive renderer (title-only). De-duplication: when the same key appears in both R-HM7 stale-children output and R-VC4 sibling-stage output, the R-HM7 path wins (entry renders in Working Knowledge as indented stale child; R-VC4 path drops the duplicate).

`buildCrossThreadDigest` (`:364`) is modified at the body construction (`:391–:430`):

- The `Recent Activity Digest:` header line at `:391` is replaced by the Live State header (the cross-thread digest is one of three subsystems composing Live State — see §5.3).
- The `Summary: <truncated>` line emitted at `:409` is removed (R-VC7).
- The thread title + message count + last-update line at `:401` is preserved verbatim, prefixed with the `[thread]` source label.
- The `CrossThreadSource` provenance tracking at `:417–:430` is unchanged.

### 6.5 Synthesis Layer (Out of Scope, Cross-Reference)

The synthesis layer that produces `_summary:<topic>` entries (heartbeat + nightly synthesis tasks, governed by `_standing:outcomes_log` and the heartbeat instructions) is the source of memory keys. R-VC9 and R-VC9b together specify the contract these keys and their value bodies must meet: keys function as standalone search seeds (R-VC9), and `_summary:<topic>` value bodies enumerate sub-topic vocabulary sufficient for Tier-3 long-tail discoverability (R-VC9b). The pipeline implementation that produces compliant keys and bodies is a separate concern — a follow-up issue tracks the cutover. Existing keys and bodies that violate R-VC9 or R-VC9b are not retroactively rewritten by this RFC; they remain queryable through `memory search` against their value bodies and through `query`, and the synthesis layer rewrites them on next regeneration cycle.

---

## 7. Design Choices

### 7.1 Per-Section Structural Labels Over Blanket Meta-Instruction

The current implementation uses a trailing meta-instruction ("Do not mention, quote, or describe the block itself…") to convey that the orientation block is background context. This RFC removes that instruction and distributes its function across per-section headers and footers.

**Why structural labels.** Meta-instructions are displaced under context pressure and cannot serve as the durable anchor for an agent's understanding of section authority. The current d0372be6 confabulation pattern (§1.3) demonstrates the failure mode: the model relies on the digest as authoritative for live data, and the trailing instruction not only fails to prevent it but actively interferes — by directing the model not to discuss the block, it suppresses the metacognitive check ("am I reading this section correctly?") that would catch the error. Per-section labels remain attached to the data they describe and survive context pressure as long as the data is rendered at all.

**Alternative considered: keep the meta-instruction, add per-section labels.** Layering both is technically possible, but the meta-instruction's framing ("don't mention this block") creates a class of behavior — the agent treating the block as off-limits to reference — that the per-section labels are designed to invert. The per-section labels invite the agent to consult them and follow the source pointer; the meta-instruction discourages even the consultation. The two are not additive; they conflict.

**Alternative considered: keep the meta-instruction, change its framing.** Replacing "do not mention" with "the contents of this block are background reference; consult section footers for canonical sources" softens the conflict, but adds a second authority layer (block-level meta-instruction plus section-level labels) that the model arbitrates between. Single-source labeling is simpler.

### 7.2 Search-Gated Body Retrieval Over Always-Present Bodies

R-VC4 specifies that Discoverable Archive entries render title-only. Bodies are accessed via `memory search` or `query`. The alternative is to render bodies inline (the current approach for stale-detail entries via `formatMemoryEntry`) at some truncation length.

**Why search-gating.** The orientation block grows linearly with corpus size at the body layer. The bound database currently holds 1,217 entries; a substantial fraction are detail-tier curiosity research notes from April. Rendering even truncated bodies for every detail entry produces tens of kilobytes of low-relevance content per turn, which crowds out attention budget for current-turn tool results. Title-only rendering preserves the discoverability invariant (§1.5 "Presence over selectivity") at constant per-entry cost.

**Tension with Kara's principle "search reserved for fine details unlikely to be relevant on every turn."** Detail-tier entries are by definition the long tail and meet this criterion. Pinned and summary-tier entries — the ones an agent does need every turn — remain in Working Knowledge at full or near-full fidelity. The boundary between "needs to be in context" and "search-gated" tracks the tier boundary specified by R-HM1.

**Alternative considered: keep truncated bodies in Discoverable Archive.** This preserves the failure mode where two adjacent entries with similar truncated value gloss render indistinguishably, leading to the agent confusing one for the other. Title-only avoids the format-collision ambiguity entirely.

### 7.3 Title-Only Catalog Over Embedding-Based Retrieval

The Discoverable Archive renders entries as a title catalog rather than relying on embedding-based retrieval (vector similarity search) to surface relevant entries dynamically per turn.

**Why titles.** The invariant from §1.5 is "if it's not in context, the agent doesn't know to look." Embedding-based retrieval inverts this: relevance is computed on the fly, and only entries deemed relevant for the current turn surface. An agent that has never seen a title for an entry cannot decide to query for it during deliberation; the entry surfaces only when the embedding model judges it relevant. This works for systems where the agent is exposed to a stream of pre-screened content (RAG over documentation, for example) but fails for the case where the agent itself is making decisions about what to research and when.

**Alternative considered: hybrid (title catalog plus per-turn embedding hits).** A future RFC may add embedding-based retrieval as a supplement — entries the embedding model judges highly relevant for the current turn surface with their bodies in addition to the title catalog. This is deferred (R-VC18 area) and not part of this RFC; the title catalog is the foundation that embedding-based retrieval would layer on top of.

### 7.4 Three-Tier Compression Over Single-Threshold Clustering

R-VC15 specifies three rendering tiers indexed by detail-tier entry count: flat list (≤200), full-cluster grouping (200–N), and heading-only collapse with M most-recent entries per cluster (>N). The earlier draft used a single 200-entry threshold for clustering with no further compression at scale.

**Why three tiers, not two.** A two-tier scheme (flat + cluster) keeps every title in context indefinitely; the orientation block grows linearly with the detail corpus. At the projected 5-year scale (~25,000 entries × ~80 chars/title) this is ~2 MB per assembly. Beyond budget regardless of compression hardware. Three tiers introduce a hard ceiling: cluster heading + M titles per cluster bounds the rendered cost at `O(cluster_count × M)`, which scales sub-linearly with corpus size since cluster count is bounded by the synthesis pipeline's output rate, not by the curiosity-research input rate.

**Why a recency cap (M) over a recency window (e.g., "last 30 days").** A recency window's render cost is unbounded — a busy month produces hundreds of titles per cluster; a quiet month produces zero. A recency cap produces predictable cost (`cluster_count × M` lines) regardless of access pattern. The cost of a cap is that an entry not accessed in the last M cluster-internal accesses is not rendered, even if its access was recent in absolute time. The R-VC9b cluster-gloss path mitigates this: parent summaries are required to carry sub-topic vocabulary, so an entry's topic remains discoverable through search even when its title is collapsed.

**Why N=1000 and M=20 as defaults.** N=1000 is the inflection point where flat clustering (Tier 2) starts to dominate orientation tokens at typical entry sizes (≈80 chars/title × 1000 = ~80 KB without cluster grouping; clustering reduces to ~30 KB). M=20 keeps each cluster's tail rendering visually scannable (≤20 lines under a heading). Both are environment-overridable for tuning against actual corpus size and model context budget; tests override deterministically.

**Risk: cluster name vocabulary may not match the agent's search vocabulary.** R-VC9 (key-as-search-seed) addresses the per-entry case; R-VC15's cluster names inherit the same risk. If `_summary:transit-systems-and-routing` is the parent of `curiosity:tokyo-metro-graphviz:2026-04-01`, an agent searching for `tokyo metro` benefits from the cluster heading containing `transit systems`, but only weakly. R-VC9b extends the contract to cluster glosses: the parent summary's value body must enumerate sub-topics with vocabulary that matches likely search queries. The 200-entry threshold for Tier 1 is set high enough that flat listing remains the default for most clusters; compression activates only when the catalog scale makes flat listing harder to navigate than clustered listing.

**Why parent-summary-derived cluster names, not derived clusters.** The `summarizes` edges are already authored by the synthesis pipeline as part of R-HM3. Reusing them avoids introducing a separate clustering taxonomy with its own authoring discipline. Entries without a parent summary route to `Uncategorized`; growth in `Uncategorized` count is a synthesis-pipeline backlog signal surfaced as an advisory under R-VC15 (Tier 3 + count > 50).

### 7.5 Removing Sibling-Thread Summary Excerpts vs. Keeping With Stronger Labels

R-VC7 specifies that the cross-thread digest renders title + message count + last-updated only; the 300-character summary excerpt is removed.

**Why removal over re-labeling.** The d0372be6 confabulation pattern (§1.3) is driven in part by the typographic similarity between sibling-thread summary excerpts and ground-truth content. The summary excerpts were designed to give the agent peripheral awareness of sibling activity ("the agent has conversational context without needing to re-read history" — comment at `summary-extraction.ts:404–:405`); the d0372be6 pattern shows this peripheral awareness leaking into authoritative-treatment when the orientation typography has no structural cue distinguishing summary excerpt from ground-truth content. A stronger label ("[summary stub]") mitigates the confusion only weakly; the excerpt format itself resembles content. Removal is the structural fix.

**Cost: agent loses ~1,000 tokens of always-on sibling-thread summary context per turn.** Sibling-thread summaries remain accessible via `query` against the threads table. Agents that need to coordinate cross-thread state can fetch them on demand. The cost trades against the failure mode where the digest is read as ground truth — which the d0372be6 thread demonstrates is a real failure, recurring across many cycles.

**Alternative considered: structural label only, keep excerpts.** A label like `[sibling thread summary stub — not live state]` prepended to each digest entry could carry the structural information without removing the excerpt. The argument against: the d0372be6 thread received Kara's correction in its memory (`_feedback:correction:retrieve_task_reflex_below_deliberation_20260516:recurrence_20260519T1555`) and continued to confabulate across multiple cycles. A label is a weaker intervention than format removal. If recurrence persists with labels in place, the next intervention is removal anyway; jumping directly to removal saves a recurrence cycle.

---

## 8. Testing Strategy

### 8.1 Unit Tests: Section Assemblers

Three new assembly helpers are introduced — one per section — and each receives unit-test coverage in `packages/agent/src/__tests__/`:

- **Working Knowledge assembler.** Test cases: pinned-only input renders full text; pinned + summary input renders pinned full + summary glosses; summary with stale child renders the parent + indented child with `[stale child of <key>]` marker; memory delta entry renders with `[changed since last turn]` marker on the same line; empty input renders only the header and footer.
- **Discoverable Archive assembler.** Test cases: detail-tier input under threshold renders flat title list; detail-tier input above 200 entries renders clustered output with cluster sub-headers; entries without parent summary route to `Uncategorized`; cluster ordering respects entry-count descending then name ascending; budget-pressure mode drops per-entry context fragments and preserves cluster sub-headers.
- **Live State assembler.** Test cases: cross-thread digest entries render with `[thread]` source label, no summary excerpt; file modification notices render with `[file]` label and source thread title; applied advisories render with `[advisory]` label; empty subsystem outputs render only the header and footer.

### 8.2 Snapshot Tests: Rendered Output Format

The integration of the three assemblers into `buildVolatileContext` is covered by snapshot tests using fixtures that mirror real memory-state shapes. Snapshots assert the exact rendered output for representative scenarios:

- Empty memory state (cold-start agent).
- Memory state with 80 pinned + 50 summary + 30 detail entries (warm-start, R-VC15 Tier 1).
- Memory state with 80 pinned + 50 summary + 500 detail entries (R-VC15 Tier 2 cluster compression activated).
- Memory state with 80 pinned + 50 summary + 5000 detail entries (R-VC15 Tier 3 heading-only compression with M=20 cap).
- Memory state with critical budget pressure (R-VC14 active) and deltas inside Working Knowledge (verifying R-VC11 markers preserved while Live State and Discoverable Archive are shed).
- Memory state with stale-child triples (R-VC10 active) where one stale child is also a delta (R-VC11(c) composition: both markers in fixed order).
- Memory state with R-MV1 deltas spanning all three sections (verifying delta marker only appears on Working Knowledge entries, not on Discoverable Archive titles).
- Memory state with delta on a multi-line pinned entry (R-VC11(b): marker on indented new line beneath the pinned text).
- Memory state with R-VC15 Tier 3 active and `Uncategorized` cluster > 50 entries (verifying the synthesis-backlog advisory is surfaced under Live State).
- Memory state with R-VC15 Tier 3 active and a non-R-VC9b-compliant parent summary (a cluster gloss missing sub-topic vocabulary; verifying the rendering is structurally correct even though the discoverability path is degraded).
- Memory state with task digest entries rendering under Live State alongside cross-thread / file / advisory entries (verifying R-VC5's four subsystems render in their fixed order with correct source labels).

Snapshot fixtures live in `packages/agent/src/__tests__/fixtures/volatile-context/` with one `.snap.txt` per scenario. Snapshot updates require explicit reviewer approval. Tunables `BOUND_VC15_N` and `BOUND_VC15_M` are overridden per-fixture via environment variables to exercise tier transitions deterministically.

**Convention note.** The `packages/agent` test suite is currently assertion-based; this RFC introduces snapshot-style `.snap.txt` fixtures as a new convention. The choice is justified by the §8.2 contract being whole-rendered-block format equivalence — exactly what snapshot tests express cleanly. Per-rule unit tests (§8.1) remain assertion-based to keep failure messages localized when individual rules regress; snapshots cover composite behavior across rules. Snapshot files are committed to the repository; updating one is a deliberate review gate equivalent to changing user-visible prompt text.

### 8.3 Regression Test: d0372be6 Confabulation Pattern

A targeted regression test asserts the structural fix for §1.3:

1. Construct a webhook event-handler thread fixture with a tool_result message containing a representative envelope JSON (method, path, headers, payload).
2. Run `buildVolatileContext` against the fixture's database state.
3. Assert that the rendered output contains the Live State section with the footer text `Current-thread event payloads live in your tool_results below; sibling-thread content via query against threads.summary`.
4. Assert that the cross-thread digest entries do not include any `Summary:` line for any sibling thread (including the agent's own thread, which is correctly excluded by `excludeThreadId`).
5. Assert that no trailing meta-instruction containing the phrase "Do not mention" appears in the output (R-VC8, R-VC19).

This test does not exercise model behavior — it verifies the structural surface that the model consults. Behavioral verification (does an agent given this orientation block correctly retrieve envelope JSON from tool_results) lives at the integration-test layer and is tracked separately from this RFC's acceptance criteria.

### 8.4 Migration Validation: Title Compliance

R-VC9 specifies that memory keys function as standalone search seeds: a key's topic slug shall contain at least three tokens that appear in the entry's value body AND have corpus-wide occurrence count ≥ 5. This is checkable directly against the corpus without modeling agent search behavior. Existing keys are not retroactively rewritten by this RFC. A non-blocking validation check is added to the heartbeat task that runs once per day:

1. Build the corpus-wide token frequency table. For each token (lower-cased, alphanumeric runs of length ≥3 with ISO-8601 date stamps stripped) in `semantic_memory.value` across all rows where `deleted IS NOT 1`, count the number of distinct entries containing the token. Call this map `freq[token]`.
2. Sample 50 keys with `tier IN ('summary', 'detail')` and `modified_at` within the prior 7 days.
3. For each sampled key:
   a. Extract topic-slug tokens: split the key on the first colon, take the right-hand side, split on `-` and `_` and `:` and digit boundaries, lower-case, drop tokens shorter than 3 characters and drop ISO-8601 date stamps.
   b. Count how many slug tokens (i) appear in the entry's value body (case-insensitive substring match against `semantic_memory.value`) and (ii) have `freq[token] ≥ 5`.
   c. Pass condition: at least 3 slug tokens satisfy both (i) and (ii).
4. For sampled keys that fail the pass condition, log a `_validation:r-vc9-non-compliance` outcome entry naming the key, the extracted slug tokens, and which tokens failed (i) vs. (ii).
5. Additionally, for each sampled key with `tier='summary'` and key prefix `_summary:<topic>`, check R-VC9b. For each child entry surfaced by outgoing `summarizes` edges, extract subject tokens by applying the step 3a procedure to the child's key slug. Count children with at least one extracted subject token appearing (case-insensitive substring match) in the parent's value body. Pass condition: ≥80% of children with non-empty extracted subject tokens satisfy this. Fail entries log `_validation:r-vc9b-non-compliance` outcome entries naming the parent key, the failing child keys, and the absent subject tokens.

This validation surfaces non-compliant titles and cluster glosses for synthesis-layer rewrite without breaking access to existing entries. The validation is advisory; non-compliant keys remain queryable via direct `query` against `semantic_memory.value`. The synthesis layer rewrites non-compliant keys and bodies on next regeneration cycle (§6.5).

### 8.5 Acceptance Criteria

- [ ] All §3 requirements implemented and covered by §8.1 and §8.2 tests.
- [ ] §8.3 regression test passes (structural surface).
- [ ] §8.4 validation check runs cleanly (no test failures; surfaced non-compliance is informational).
- [ ] §8.6 behavioral probe passes: post-RFC orientation block produces envelope-content-referencing assistant turns at ≥80% of N=10 trials, while pre-RFC orientation block produces disclaimer turns at ≥80% of N=10 trials (control).
- [ ] Snapshot tests pass for all eleven scenarios in §8.2.
- [ ] No reduction in agent task-completion rate observed in the 7-day window after rollout, measured via task `consecutive_failures` aggregation. Baseline: mean `consecutive_failures` across the 7 days preceding rollout. Threshold: post-rollout mean ≤ 1.2× baseline mean.

### 8.6 Integration Probe: d0372be6 Behavioral Regression

The §8.3 regression test verifies the structural surface only. The d0372be6 confabulation was a model-behavior failure: the envelope JSON was already in the tool_result one message above the failing assistant turn; the agent failed despite that structural availability. The structural changes (per-section labels, removed meta-instruction, removed summary excerpts) are a *bet* that the new presentation will route the model toward consulting tool_results instead of hallucinating digest stubs. Whether they do is a behavioral question that §8.3 cannot answer.

**Probe procedure:**

1. Construct a webhook event-handler thread fixture (interface=webhook) with a single tool_result containing a representative envelope JSON: `{"method":"POST","path":"/webhook/<repo>","headers":{"x-github-event":"issues","x-github-delivery":"<uuid>"},"body":{"action":"opened","repository":{"full_name":"<owner>/<repo>"},"sender":{"login":"<user>"},"issue":{"number":N,"title":"<title>"}}}`. The envelope is the only tool_result in the fixture's conversation history.

2. Inject a developer message preceding the tool_result: `[Task wakeup] Scheduled webhook task <task_id> triggered.`

3. Run a real agent loop with the lowest-cost available model (typically a fast Anthropic, Bedrock, or open-weights model). Repeat for N=10 trials with deterministic temperature (T=0.3). The N=10 / 80–20 thresholds + the existing "between 0.5 and 0.8 → revisit" clause handle sampling variance without requiring a fixed RNG seed (which most production LLM APIs do not expose). For borderline outcomes (post-RFC `content_pct` in [0.6, 0.8]), the probe re-runs at N=20 before declaring partial success.

4. Score each trial's first assistant turn against two predicates:
   a. **Content-referencing:** the assistant text contains the envelope's `action`, the repository `full_name`, AND the sender `login` (case-insensitive substring match).
   b. **Disclaimer:** the assistant text contains a phrase from `["no payload", "no envelope", "payload appears to be missing", "can't see the payload", "event details not visible", "summary stub", "recent activity digest"]` (case-insensitive substring match).

5. Report two metrics: `content_pct = (count of content-referencing trials) / 10`, `disclaimer_pct = (count of disclaimer trials) / 10`. A trial may be both, neither, or one of the two; metrics are independent counts.

6. **Run the probe twice:** once with the pre-RFC orientation block (control), once with the post-RFC orientation block (test). The pre-RFC variant is constructed by reverting the in-place revisions of `buildVolatileContext` and `buildCrossThreadDigest` for the duration of the test only.

**Acceptance:**
- Pre-RFC `disclaimer_pct ≥ 0.8` (control: confirms the bug reproduces under the prior orientation).
- Post-RFC `content_pct ≥ 0.8` (treatment: confirms the structural revision routes the model toward the tool_result).
- Post-RFC `disclaimer_pct ≤ 0.2` (treatment: confirms the disclaimer pattern does not re-emerge).

**Why probability thresholds, not boolean assertions.** Model-behavior tests are inherently probabilistic. A single-trial assertion would be flaky regardless of whether the structural fix worked. The 80/20 thresholds are tuned to the observed pre-RFC failure rate (4/4 disclaimer turns in d0372be6 across 23:30, 02:11, 02:14, 02:14:55 — effectively 100%) and a generous 20% slack on the post-RFC bet. If the post-RFC `content_pct` falls between 0.5 and 0.8, the structural fix is partial; the RFC needs revisiting before merge.

**Why this lives in §8.6, not §8.3.** §8.3 is structural and runs in the unit-test budget. §8.6 spawns a real agent loop and consumes inference budget; it lives in the integration-test pipeline, not the per-PR unit-test suite. CI runs §8.6 on a schedule (weekly or per-release), not per-commit.
