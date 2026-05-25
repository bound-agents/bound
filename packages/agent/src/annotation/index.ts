/**
 * Stage 5 ANNOTATION — convert post-Stage-3 `Message` rows to
 * `LLMMessage` shape with model-switch markers, tool_use_id
 * propagation, and absolute-timestamp annotation on user messages.
 *
 * Properties pinned by `__tests__/annotate.property.test.ts`:
 *
 *   N1 Determinism — same `(messages, nowMs)` produces byte-equal output.
 *   N2 Non-LLM roles dropped — alert/purge/etc. never reach output.
 *   N3 Model-switch cap — at most MODEL_SWITCH_CAP `Model switched`
 *      developer messages emitted regardless of input.
 *   N4 No model-switch on first assistant — the first assistant
 *      message in a stream never produces a switch marker.
 *   N5 tool_use_id resolution — every `tool_result` in output has
 *      a non-null `tool_use_id`.
 *   N6 Timestamp annotation only on user messages.
 *   N7 Recent-user no-annotation — user messages newer than 60s
 *      do not get a timestamp prefix.
 *   N8 Empty input → empty output.
 */

export { annotateMessages, MODEL_SWITCH_CAP, type AnnotateMessagesParams } from "./annotate";
