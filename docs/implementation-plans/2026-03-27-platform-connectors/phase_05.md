# Platform Connectors Implementation Plan — Phase 5: AbortSignal Wiring

**Goal:** Enable genuine HTTP-level cancellation of in-flight LLM inference by adding `signal?: AbortSignal` to `ChatParams` and forwarding it through all four LLM drivers (Anthropic, Bedrock, OpenAI-compatible, Ollama). `relay-processor.ts` then passes `abortController.signal` to `backend.chat()`.

**Architecture:** One type change in `packages/llm/src/types.ts`. Four driver modifications (add `signal` to `fetch()` options or AWS SDK `send()` options). One change in `relay-processor.ts` at line ~714 to pass the signal. The existing abort-checking loop in `relay-processor.ts` (which checks `abortController.signal.aborted` after each chunk) remains — the new signal wiring is additive, enabling HTTP-level cancellation in addition to the existing loop-level check.

**Tech Stack:** Web AbortSignal API, AWS SDK v3 `client.send(command, { abortSignal })`, fetch() `signal` option

**Scope:** Phase 5 of 7 from docs/design-plans/2026-03-27-platform-connectors.md

**Codebase verified:** 2026-03-27

---

## Acceptance Criteria Coverage

### platform-connectors.AC8: AbortSignal wiring in LLM drivers
- **platform-connectors.AC8.1 Success:** Anthropic driver terminates stream when `AbortSignal` is aborted mid-stream
- **platform-connectors.AC8.2 Success:** Bedrock driver terminates stream when `AbortSignal` is aborted mid-stream
- **platform-connectors.AC8.3 Success:** OpenAI-compatible driver terminates stream when `AbortSignal` is aborted mid-stream
- **platform-connectors.AC8.4 Success:** Ollama driver terminates stream when `AbortSignal` is aborted mid-stream
- **platform-connectors.AC8.5 Success:** `relay-processor.ts` passes `abortController.signal` to `backend.chat()`

---

<!-- START_SUBCOMPONENT_A (tasks 1-6) -->

<!-- START_TASK_1 -->
### Task 1: Add `signal` to `ChatParams`

**Verifies:** (structural — enables all AC8.x via TypeScript)

**Files:**
- Modify: `packages/llm/src/types.ts`

**Implementation:**

Add `signal?: AbortSignal` to the `ChatParams` interface (currently lines 6–14):

```typescript
export interface ChatParams {
  model: string;
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  system?: string;
  cache_breakpoints?: number[];
  signal?: AbortSignal;   // ← add this field
}
```

**Verification:**

Run: `tsc -p packages/llm --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: add signal?: AbortSignal to ChatParams`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Wire AbortSignal in Anthropic driver

**Verifies:** platform-connectors.AC8.1

**Files:**
- Modify: `packages/llm/src/anthropic-driver.ts`

**Implementation:**

In the `chat()` method, the `ChatParams` are received as a parameter. Pass `params.signal` (or the local variable holding `ChatParams`) to the `fetch()` call at lines ~320–342.

The fetch call currently looks like:

```typescript
res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "x-api-key": this.apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    ...request,
    stream: true,
  }),
});
```

Add `signal: params.signal` to the fetch options object:

```typescript
res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "x-api-key": this.apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    ...request,
    stream: true,
  }),
  signal: params.signal,  // ← add this
});
```

**`withRetry` and AbortError — no change needed.** When the signal is aborted, `fetch()` throws a `DOMException` with `name === "AbortError"`. The `withRetry` implementation in `packages/llm/src/retry.ts` only retries `LLMError` instances (rate limits and connection errors). A `DOMException` is not an `LLMError`, so it falls through to the "all other errors: re-throw immediately" path. No change to `retry.ts` is needed — `AbortError` is never retried.

**Verification:**

Run: `tsc -p packages/llm --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: forward AbortSignal to fetch() in Anthropic driver (AC8.1)`
<!-- END_TASK_2 -->

<!-- START_TASK_3 -->
### Task 3: Wire AbortSignal in OpenAI-compatible driver

**Verifies:** platform-connectors.AC8.3

**Files:**
- Modify: `packages/llm/src/openai-driver.ts`

**Implementation:**

In `packages/llm/src/openai-driver.ts`, the fetch call at lines ~263–281 currently looks like:

```typescript
res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${this.apiKey}`,
  },
  body: JSON.stringify(request),
});
```

Add `signal: params.signal`:

```typescript
res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${this.apiKey}`,
  },
  body: JSON.stringify(request),
  signal: params.signal,  // ← add this
});
```

No `withRetry` guard needed — `AbortError` is not an `LLMError` and is never retried (see Task 2 note).

**Verification:**

Run: `tsc -p packages/llm --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: forward AbortSignal to fetch() in OpenAI-compatible driver (AC8.3)`
<!-- END_TASK_3 -->

<!-- START_TASK_4 -->
### Task 4: Wire AbortSignal in Ollama driver

**Verifies:** platform-connectors.AC8.4

**Files:**
- Modify: `packages/llm/src/ollama-driver.ts`

**Implementation:**

In `packages/llm/src/ollama-driver.ts`, the fetch call at lines ~210–227 currently looks like:

```typescript
res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(request),
});
```

Add `signal: params.signal`:

```typescript
res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(request),
  signal: params.signal,  // ← add this
});
```

No `withRetry` guard needed — `AbortError` is not an `LLMError` and is never retried (see Task 2 note).

**Verification:**

Run: `tsc -p packages/llm --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: forward AbortSignal to fetch() in Ollama driver (AC8.4)`
<!-- END_TASK_4 -->

<!-- START_TASK_5 -->
### Task 5: Wire AbortSignal in Bedrock driver

**Verifies:** platform-connectors.AC8.2

**Files:**
- Modify: `packages/llm/src/bedrock-driver.ts`

**Implementation:**

The Bedrock driver uses the AWS SDK v3 `BedrockRuntimeClient`. AWS SDK v3 supports aborting requests by passing `abortSignal` as an option to `client.send()`.

In `packages/llm/src/bedrock-driver.ts`, the SDK call at lines ~163–174 currently looks like:

```typescript
const command = new ConverseStreamCommand({
  modelId,
  messages,
  ...(systemBlocks && { system: systemBlocks }),
  ...(toolConfig && { toolConfig }),
  ...(inferenceConfig && { inferenceConfig }),
});

const response = await withRetry(async () => {
  let res: ConverseStreamCommandOutput;
  try {
    res = await this.client.send(command);
  } catch (error) {
    // ... error handling
  }
  // ...
});
```

Update `this.client.send(command)` to pass the abort signal as the second argument:

```typescript
res = await this.client.send(command, {
  abortSignal: params.signal,  // ← add this (AWS SDK v3 abort API)
});
```

AWS SDK v3 throws an `AbortError` when the signal is aborted. No `withRetry` guard needed — `AbortError` is not an `LLMError` and is never retried (see Task 2 note).

**Verification:**

Run: `tsc -p packages/llm --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: forward AbortSignal to AWS SDK send() in Bedrock driver (AC8.2)`
<!-- END_TASK_5 -->

<!-- START_TASK_6 -->
### Task 6: Pass `abortController.signal` to `backend.chat()` in RelayProcessor

**Verifies:** platform-connectors.AC8.5

**Files:**
- Modify: `packages/agent/src/relay-processor.ts`

**Implementation:**

In `packages/agent/src/relay-processor.ts`, the `executeInference()` method calls `backend.chat()` at lines ~713–721 without passing the signal:

```typescript
const chatStream = backend.chat({
  model: payload.model,
  messages,
  tools: payload.tools,
  system: payload.system,
  max_tokens: payload.max_tokens,
  temperature: payload.temperature,
  cache_breakpoints: payload.cache_breakpoints,
});
```

The `abortController` is already in scope (created at line ~671 and stored in `this.activeInferenceStreams`). Add `signal: abortController.signal` to the `chat()` call:

```typescript
const chatStream = backend.chat({
  model: payload.model,
  messages,
  tools: payload.tools,
  system: payload.system,
  max_tokens: payload.max_tokens,
  temperature: payload.temperature,
  cache_breakpoints: payload.cache_breakpoints,
  signal: abortController.signal,  // ← add this (resolves existing TODO)
});
```

**Verification:**

Run: `tsc -p packages/agent --noEmit`
Expected: No TypeScript errors.

**Commit:** `feat: pass abortController.signal to backend.chat() in RelayProcessor (AC8.5)`
<!-- END_TASK_6 -->

<!-- END_SUBCOMPONENT_A -->

<!-- START_SUBCOMPONENT_B (tasks 7) -->

<!-- START_TASK_7 -->
### Task 7: Tests — AbortSignal for all four drivers

**Verifies:** platform-connectors.AC8.1, AC8.2, AC8.3, AC8.4, AC8.5

**Files:**
- Modify: `packages/llm/src/__tests__/anthropic-driver.test.ts`
- Modify: `packages/llm/src/__tests__/bedrock-driver.test.ts`
- Modify: `packages/llm/src/__tests__/openai-driver.test.ts`
- Modify: `packages/llm/src/__tests__/ollama-driver.test.ts`

**Testing:**

Follow the existing test patterns in each file: `bun:test`, `beforeEach`/`afterAll` save/restore `global.fetch`.

**Important note from existing codebase:** The Ollama driver tests mock `global.fetch` — MUST save and restore `global.fetch` in `afterAll` to avoid polluting other test suites. Apply the same save/restore pattern for all new fetch-mocking tests.

For fetch-based drivers (Anthropic, OpenAI, Ollama), the test strategy:
1. Create an `AbortController`
2. Mock `global.fetch` to return a streaming response that never resolves (or resolves slowly)
3. Start consuming the stream: `const gen = driver.chat({ ..., signal: controller.signal })`
4. Abort the controller: `controller.abort()`
5. Assert that iterating the generator throws or returns early (stream terminates)

Example pattern for fetch-based driver (use this for Anthropic, OpenAI, Ollama):

```typescript
it("AC8.x: aborts stream when AbortSignal is aborted mid-stream", async () => {
  const controller = new AbortController();

  // Mock fetch to return a never-ending stream that waits for abort
  const originalFetch = global.fetch;
  let abortDetected = false;
  global.fetch = async (_url, options) => {
    // Detect that signal is passed through
    if (options?.signal) {
      options.signal.addEventListener("abort", () => { abortDetected = true; });
    }
    // Return a streaming response that emits nothing (simulates slow inference)
    const stream = new ReadableStream({
      start(controller_) {
        // Do nothing — stream never ends until aborted
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  try {
    const gen = driver.chat({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });

    // Abort after starting the stream
    setTimeout(() => controller.abort(), 10);

    // Consuming the generator should terminate (not hang forever)
    const chunks: unknown[] = [];
    try {
      for await (const chunk of gen) {
        chunks.push(chunk);
      }
    } catch (err) {
      // AbortError is expected — test passes
    }

    expect(abortDetected).toBe(true);
  } finally {
    global.fetch = originalFetch;
  }
});
```

For the **Bedrock driver** (AC8.2), the mock strategy differs since it uses the AWS SDK:

```typescript
it("AC8.2: aborts stream when AbortSignal is aborted mid-stream", async () => {
  const controller = new AbortController();

  // Mock the BedrockRuntimeClient.send() to detect abortSignal
  let abortSignalReceived: AbortSignal | undefined;
  const mockSend = mock(async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
    abortSignalReceived = options?.abortSignal;
    // Return a never-ending async iterable as the stream
    return {
      stream: (async function* () {
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          yield {};
        }
      })(),
    };
  });

  // Replace the client's send method
  (driver as unknown as { client: { send: typeof mockSend } }).client.send = mockSend;

  const gen = driver.chat({
    model: "us.anthropic.claude-3-haiku-20240307-v1:0",
    messages: [{ role: "user", content: "hi" }],
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 10);

  try {
    for await (const _ of gen) { /* consume */ }
  } catch {
    // Expected
  }

  expect(abortSignalReceived).toBe(controller.signal);
});
```

**For AC8.5** (relay-processor), add a test in `packages/agent/src/__tests__/relay-processor.test.ts` that verifies `abortController.signal` is passed to `backend.chat()`. Since the relay-processor test already uses a `MockLLMBackend`, add a spy on the `chat()` method to capture the parameters and assert `signal` is included.

**Verification:**

Run: `bun test packages/llm`
Expected: All new abort signal tests pass for all four drivers.

Run: `bun test packages/agent/src/__tests__/relay-processor.test.ts`
Expected: AC8.5 test passes.

Run: `bun test packages/llm && bun test packages/agent`
Expected: Full test suites pass with no regressions.

**Commit:** `test: add AbortSignal cancellation tests for all LLM drivers (AC8.1–8.5)`
<!-- END_TASK_7 -->

<!-- END_SUBCOMPONENT_B -->
