# RFC: Hub-Vouched Relay Trust for Spoke-to-Spoke Inference

**Supplements:** 2026-04-03-sync-encryption.md
**Date:** 2026-06-02
**Status:** Draft

---

## 1. Problem Statement

### 1.1 Motivation

A host with no local model backend cannot serve inference. It must relay every inference request to a host that does. In a hub-and-spoke cluster where the hub itself carries no models, the only model-bearing host can be another spoke. When a modelless spoke relays an inference request to a model-bearing sibling spoke through the hub, the sibling rejects the request with `error` kind, `retriable: false`, and the message `Unknown source site: <site_id>`. The relay never completes; the modelless spoke is dead on arrival for every request it issues.

The rejection originates in the relay processor's requester-validation step. Before executing a relayed inference request, the processor checks that the request's `source_site_id` is present in the local keyring. The keyring is populated only along hub-and-spoke lines: a spoke learns the hub's identity at join, and the hub learns each spoke's identity as it joins. No mechanism distributes one spoke's identity to another spoke. So a sibling spoke's `source_site_id` is never in the local keyring, and the keyring check rejects it before any inference runs.

This is observable in production today. A modelless spoke issues a request; the model-bearing spoke writes `Unknown source site` back across the relay; the originating spoke surfaces the relay error to the user. The same failure recurs across the entire log history of the affected node, independent of restarts -- restarting either host repopulates the keyring along the same hub-and-spoke lines and changes nothing.

### 1.2 Context / Domain Framing

Sync and relay frames are encrypted hop-by-hop, not end-to-end. Each pair of directly-connected hosts derives a shared symmetric key from its own X25519 private key and the peer's published X25519 public key; frames between them are sealed with that per-peer key. A spoke connects only to the hub, so a spoke holds exactly one peer key: the hub's. When the hub forwards a relay entry from spoke A to spoke B, spoke B decrypts the frame with the hub's key -- not spoke A's. Spoke B never needs spoke A's key to receive, decrypt, or authenticate the delivered frame.

Successful frame decode is itself authentication of the delivering peer. A frame seals under exactly one per-peer symmetric key; a host can only produce a frame another host decrypts if both sides derived the same shared secret, which requires each holding the other's public key in the keyring. A spoke that decodes a frame has thereby established that the frame came from a keyring peer -- and a spoke's only keyring peer is the hub.

The hub stamps `source_site_id` on every relay entry it routes from its own authenticated view of the frame sender, not from any value carried in the request payload. When the hub forwards spoke A's entry to spoke B, the `source_site_id` spoke B sees is the hub's attestation that the frame arrived from spoke A. The field is therefore trustworthy precisely to the degree the hub is trusted -- and the hub is already in every spoke's trusted computing base, because the hub relays every host's change-log to every other host and each spoke accepts that replicated state on the hub's authority alone.

### 1.3 Design Tension

The keyring check on `source_site_id` looks like defense in depth: validate the origin of work before doing it. But the origin identity it validates is unreachable for legitimate spoke-to-spoke traffic, because the keyring is populated along connection lines and spokes do not connect to each other. The tension is between **a second, application-level authorization gate keyed on the work's origin** and **the transport-level authentication already discharged on the work's delivering peer**. The two diverge exactly in the hub-mediated spoke-to-spoke case: the delivering peer (the hub) is authenticated and trusted, while the origin (the sibling spoke) is authenticated by the hub but absent from the receiver's keyring. A gate that rejects on the origin dimension rejects legitimate, fully-authenticated traffic.

**Provenance.** The origin gate is not a deliberate boundary that this RFC overturns; it is peer-validation that drifted into origin-validation when the topology changed under it. The `keyringSiteIds.has(source_site_id)` check was introduced 2026-03-26 (commit `004641510`), a week before the sync-encryption spec (2026-04-03), in the original inference-relay feature. Its code comment reads `Validate requester (keyring check)` and the inference-relay design-plan frames it as "validate model availability and keyring" -- a requester-validation step, with no acceptance criterion calling for rejection on origin-keyring membership. At introduction the relay processor ran hub-side, where `source_site_id` always names a keyring member because the hub keyrings every spoke; "validate the requester is in my keyring" and "validate the peer who delivered this" were the same check on the same entity. The two diverge only on the spoke-to-spoke forwarding path, where the receiving spoke runs the same code but `source_site_id` is now a sibling spoke absent from its keyring while the delivering peer (the hub) is present. The check reads `source_site_id`, so it silently became an origin-check the moment relay gained a hop the validation was never revisited for.

### 1.4 Scope Boundaries

This RFC does not establish direct spoke-to-spoke connections. Spokes connect to the hub; relay between spokes is hub-mediated. A direct spoke-to-spoke link requires a host to authenticate a peer it has no keyring entry for, which needs a key-distribution or key-exchange mechanism this RFC does not define.

This RFC does not change which host a request routes to. Model resolution and target selection are unchanged; the only change is whether the selected target accepts the relayed request.

This RFC does not alter the encryption scheme, the keyring file format, or the hub-and-spoke topology. It changes the basis on which a received relay entry is authorized for processing.

This RFC's trust-basis change is kind-agnostic: the `source_site_id` gate is removed ahead of handler dispatch, so every relay request kind from a sibling spoke is admitted, not only `inference`. The `inference` kind -- the flow #50 reports -- carries its assembled prompt in the relay payload and needs no local copy of the originating thread on the target. Kinds that delegate a full agent loop on the target (the `process` kind) instead read thread history from the target's local database, and therefore depend on change-log sync having converged that thread to the target. That is a data-availability timing dependency, distinct from the trust gap this RFC closes, and is recorded as an accepted gap in §6.7.

### 1.5 Design Tenets

This RFC is governed by three tenets. Each is a directional tradeoff that stands on its own; they are not ranked. Where two tenets pull in opposite directions for a specific decision, the decision and its reasoning are captured in §7.

**Cluster reachability over origin self-sufficiency.** A modelless host is inert if it cannot reach a model, and the only model-bearing host can be a peer the receiver has no direct relationship with. The receiver processes relayed work without independently authenticating its origin, trusting instead the attestation of the peer that delivered it. This costs the receiver the ability to verify the origin against its own keyring; it gains the ability to serve any host the hub can reach.

**Trust-model uniformity even over defense-in-depth.** The cluster already extends transitive trust through the hub for all replicated state: a spoke accepts change-log rows on the hub's authority without independently verifying each originating host. Relay authorization adopts the same basis -- the authenticated delivering peer -- rather than maintaining a separate origin-keyring gate. The origin gate is removed even though a redundant layer has defensive appeal, because a layer that rejects fully-authenticated hub-mediated traffic is a fault, not a defense.

**Hub-mediated minimalism over a symmetric trust mesh.** Trust is modeled along the actual connection graph, not a hypothetical full mesh. No host learns keys for hosts it never connects to. This forecloses direct spoke-to-spoke relay absent a future key-exchange mechanism -- accepted, because no direct spoke-to-spoke connections exist, and a full mesh grows the trust surface to every pair of hosts to solve a problem the hub already mediates.

## 2. Proposal

### 2.1 Summary

Relay-entry authorization is discharged by transport-level authentication of the delivering peer, not by an application-level keyring check on the entry's `source_site_id`. A relay frame decodes only under the symmetric key shared with its delivering peer, so a successfully-received relay entry has already proven it came from a keyring peer. The hub stamps `source_site_id` from its authenticated view of the original sender, making the field a trustworthy attestation for response routing and audit rather than an authorization input. The two `source_site_id` keyring checks in the relay processor are removed; entries that reach the relay inbox are processed on the authority of the peer that delivered them.

### 2.2 What This Changes

| Target | Change |
|---|---|
| 2026-04-03-sync-encryption.md | Amended. That spec establishes per-peer (delivering-peer) authentication but is scoped spoke-to-hub and defers spoke-to-spoke payload handling (R-SE17), so it does not itself define relay authorization. This RFC defines relay authorization in terms of that per-peer authentication and records `source_site_id` as a hub-stamped attestation field, not an access-control input. |
| `@bound/agent` relay processor | Removes the two `source_site_id` keyring checks (inbound-processing path and request-validation path). Processing proceeds for any relay-inbox entry. |
| `@bound/sync` transport | No wire-format change. The existing per-peer frame authentication is the sole authorization gate for relay delivery; the delivering peer's identity is the trusted signal. |
| Relay error surface | `Unknown source site` is no longer emitted for hub-mediated sibling-spoke traffic. The error remains reachable only where a frame fails to authenticate, which is handled at the transport layer before relay processing. |

### 2.3 Behavioral Overview

Before this RFC, a relay request executes only if its `source_site_id` is in the receiver's keyring. After it, a relay request executes if it reached the receiver's relay inbox at all -- which it can only do by arriving over an authenticated connection to a keyring peer (a frame that fails to decode is dropped at the transport boundary and never becomes an inbox entry) or by being originated locally on the receiver. The origin of the work, recorded in `source_site_id`, no longer gates execution; it identifies where a response is routed and who the hub attests originated the request.

The observable change is narrow: a modelless spoke's inference requests, relayed through the hub to a model-bearing sibling spoke, now execute and return results instead of failing with `Unknown source site`. No other relay flow changes. Hub-originated requests, requests targeting the hub, and platform-intake rows behave as before.

## 3. Requirements (EARS Format)

### 3.1 Ubiquitous

**R-SR1.** The system shall authorize a received relay entry for local processing based on the site identity of the authenticated peer that delivered the containing frame, not on the entry's `source_site_id`.

**R-SR2.** The system shall treat `source_site_id` as informational metadata used for response correlation and audit, and shall not use it as an authorization input.

**R-SR3.** The system shall accept into the relay inbox only entries that arrive over an authenticated sync connection or are originated by the local host. Frames that fail per-peer authentication are rejected at the transport boundary and shall not produce relay-inbox entries.

### 3.2 Event-Driven

**R-SR4.** When a spoke resolves a model that no local backend serves and exactly one reachable host serves it, the spoke shall relay the inference request to that host through the hub, including when that host is another spoke.

**R-SR5.** When the relay target produces response entries (`stream_chunk`, `stream_end`, `result`, `error`, `status_forward`), the target shall route them toward the originating source by `ref_id` correlation through the hub, and shall not require the originating source's identity in the target's local keyring.

**R-SR6.** When the hub forwards or hub-locally ingests a relay entry, the hub shall stamp `source_site_id` from the authenticated identity of the frame sender, and shall not copy a source identity from a request payload field.

### 3.3 State-Driven

**R-SR7.** While a relay entry awaits processing in the relay inbox, its presence shall imply prior delivery-time authentication (R-SR3); the processing path shall not re-gate on `source_site_id`.

### 3.4 Optional / Deferred

**R-SR8.** Direct spoke-to-spoke sync connections are not established by this RFC. A future RFC may define a key-exchange mechanism enabling a host to authenticate a peer it connects to directly. Until then, authorization of spoke-originated relay work depends on hub mediation per R-SR1 and R-SR3.

### 3.5 Trust Attestation

**R-SR9.** A host shall derive the per-peer frame key from its own X25519 private key and the peer's published X25519 public key. A frame that decodes under a peer's derived key constitutes authentication of that peer as the delivering peer (R-SR1).

**R-SR10.** The hub's stamped `source_site_id` (R-SR6) shall be the receiver's basis for attributing a relayed request to its origin for response routing and audit. The receiver shall rely on this attestation rather than independently authenticating the origin.

### 3.6 Unwanted Behavior

**R-SR11.** A host shall not reject a relay entry solely because its `source_site_id` is absent from the local keyring when the entry was delivered by a keyring-trusted peer.

**R-SR12.** A host shall not process a relay entry that did not arrive over an authenticated connection to a keyring peer and was not locally originated, even when the entry's `source_site_id` names a keyring-trusted site. Authorization keys on the authenticated delivering peer, not on a claimed origin.

## 4. Data Model Changes

### 4.1 Schema

No schema change. The relay tables (`relay_inbox`, `relay_outbox`, `relay_cycles`) are local-only and unchanged. `relay_inbox.source_site_id` is retained with its existing meaning -- the hub's attestation of the originating host -- and is now consumed only for response correlation and audit, never for authorization.

### 4.2 Protocol

No wire-format change. The `relay_send`, `relay_deliver`, and `relay_ack` frames are unchanged in shape and field set. The change is which identity the receiver authorizes against: the authenticated delivering peer (established by per-peer frame decode) rather than the entry's `source_site_id`.

### 4.3 Affected Surfaces

Relay-entry intake on both hub and spoke. The two `source_site_id` keyring checks in the relay processor -- one in the request-validation step that precedes inference execution, one in the inbound-processing step -- are removed. The relay processor processes any entry present in its inbox; the authorization decision has already been made at the transport boundary that admitted the frame.

## 5. Behavioral Descriptions

### 5.1 Spoke-to-Spoke Inference Relay

This is the flow #50 reports as broken. A modelless spoke resolves a model served only by a sibling spoke, relays the request through the hub, and receives the result.

**Steps:**

1. The originating spoke resolves a model with no local backend. Model resolution identifies exactly one reachable host serving it: a sibling spoke.
2. The originating spoke writes a relay request (`kind: "inference"` or the applicable request kind) targeting the sibling spoke's site id and sends a `relay_send` frame to the hub over its authenticated hub connection.
3. The hub decodes the frame under the originating spoke's per-peer key, authenticating the sender. The hub stamps `source_site_id` from that authenticated identity (R-SR6) and forwards a `relay_deliver` frame to the target sibling spoke over the hub↔target per-peer connection.
4. The target spoke decodes the `relay_deliver` frame under the hub's per-peer key. Successful decode authenticates the hub as the delivering peer (R-SR9). The entry is admitted to the target's relay inbox (R-SR3).
5. The relay processor on the target spoke reads the inbox entry and executes inference. It does not check `source_site_id` against the keyring (R-SR7). The model alias in the payload is ignored in favor of the target's locally-configured model identifier (per the existing model-alias passthrough invariant).
6. The target spoke produces response entries (`stream_chunk`, then `stream_end`/`result`) and routes them back toward the originating spoke by `ref_id` correlation through the hub (R-SR5). The target does not require the originating spoke's identity in its keyring to send the response -- it sends to the hub, which forwards.
7. The hub forwards the response frames to the originating spoke, which assembles the result.

**Worked example:**

The cluster has three hosts: a modelless spoke (`spoke-M`, no local models), the hub (`hub-H`, no local models), and a model-bearing spoke (`spoke-G`, serves model alias `M`). The modelless spoke's keyring contains the hub only. The model-bearing spoke's keyring contains the hub only. The hub's keyring contains both spokes.

A user message lands on `spoke-M`. It resolves `M`, finds no local backend, and identifies `spoke-G` as the single reachable host serving `M`. `spoke-M` sends a `relay_send` to the hub. The hub decodes it under the `spoke-M`↔hub key, stamps `source_site_id = spoke-M`, and sends a `relay_deliver` to `spoke-G`. `spoke-G` decodes the frame under the hub↔`spoke-G` key -- the only key it shares -- and admits the entry. Its `source_site_id` reads `spoke-M`, which is absent from `spoke-G`'s keyring. Before this RFC, the request-validation step rejected here with `Unknown source site: spoke-M`. After it, the entry is processed: `spoke-G` runs `M` inference and streams `stream_chunk` entries back, correlated by `ref_id`, through the hub to `spoke-M`. `spoke-M` assembles the response.

**Error and edge cases:**

- If the target spoke is offline, the hub fast-fails a synchronous request kind back to `spoke-M` with `retriable: true` and `definitely_not_executed: true` (existing behavior, unchanged). Asynchronous kinds buffer in the hub's outbox for delivery on reconnect.
- If the target spoke is online but does not drain its relay inbox before the relay timeout elapses (for example, under inference load), the originating spoke surfaces a relay timeout rather than a result. This is a target-capacity condition distinct from the trust rejection this RFC removes; the timeout path is governed by the existing relay timeout and is unchanged here.
- If the model alias resolves to more than one reachable host, target selection is unchanged by this RFC.

### 5.2 Delivery-Boundary Authentication

The authorization that admits a relay entry is discharged when the receiving host decodes the frame. A relay frame is sealed with the symmetric key derived from the sender's and receiver's X25519 key pair (R-SR9); a host can decode it only if it holds the sender's public key in its keyring. A frame that fails to decode is dropped at the transport boundary and never becomes a relay-inbox entry (R-SR3). Therefore every relay-inbox entry on a host was either delivered by an authenticated keyring peer or originated locally on that host. Both are trusted; neither requires a `source_site_id` check.

No third path can introduce an inbox entry. The relay tables are not members of the synced-table set, so they are excluded from every cross-host state-transfer path -- the steady-state change-log outbox, the initial snapshot seeded to a newly-joining spoke, and backfill/restore reconciliation alike (§6.6). Hub-buffered asynchronous entries re-delivered on reconnect are re-delivered as `relay_deliver` frames and pass per-peer decode again on arrival, so they are the authenticated-delivery case, not an exception to it. The two-path enumeration is therefore exhaustive, which is what makes removing the origin check sound (R-SR3, R-SR7): an inbox entry's mere presence carries the delivery-time authentication that the removed check would otherwise re-assert.

**Worked example:** A frame arrives at `spoke-G` claiming, in an unauthenticated lower layer, to be from some site. The host attempts decode under each peer key it holds. The frame decodes under the hub key, so the delivering peer is the hub -- a keyring member. The entry is admitted. A hypothetical frame from a host whose key `spoke-G` does not hold cannot be produced in decodable form; it is discarded at decode without reaching relay logic (R-SR12).

### 5.3 Response Routing Without Origin Keyring Entry

When the target spoke finishes inference, it emits response entries targeting the originating source's site id. The target sends these to the hub -- its only connection -- over the authenticated hub connection. The hub matches the response to the originating source by `ref_id` and forwards it. The target never encrypts directly to the originating source and never needs the originating source's key (R-SR5). Correlation is by `ref_id`, not by a mutual keyring relationship.

### 5.4 Rejection of an Unauthenticated Frame

A frame that does not decode under any held peer key is not authenticated and is dropped before relay processing. No relay-inbox entry is created, no inference runs, and no `Unknown source site` application error is emitted -- the rejection is at the cryptographic transport boundary, not the application keyring check. This preserves the property that a host processes relay work only from peers it shares a key with (R-SR12), while removing the origin-keyring gate that rejected legitimate hub-forwarded traffic (R-SR11).

## 6. Interaction with Existing Specifications

### 6.1 2026-04-03-sync-encryption.md (Keyring and Per-Peer Encryption)

This RFC supplements the sync-encryption spec by defining relay-entry authorization in terms of the per-peer authentication that spec already establishes. The sync-encryption spec is scoped spoke-to-hub (§1.3) and defers spoke-to-spoke payload handling (R-SE17), so it establishes the per-peer authentication model but does not itself define how a relay entry's authorization is decided; this RFC fills that gap rather than overriding a prior decision. The keyring's role is unchanged: it holds the public keys of directly-connected peers and is populated along hub-and-spoke connection lines. What changes is the relay layer's reliance on it: the relay processor no longer treats keyring membership of the entry's origin as an authorization input. The cryptographic guarantee -- that a decodable frame proves the delivering peer is a keyring member -- is the authorization basis.

### 6.2 sync-protocol Relay (Package `@bound/agent`, `@bound/sync`, `@bound/core`)

The relay processor (`@bound/agent`) drops both `source_site_id` keyring checks. The sync transport (`@bound/sync`) is unchanged: it already authenticates the delivering peer by frame decode. The relay CRUD helpers (`@bound/core`) are unchanged; `relay_inbox` rows retain `source_site_id` for correlation and audit.

### 6.3 Inference Routing Invariants

Model-alias passthrough is preserved: the target executes against its locally-configured model, not the payload alias. Hub response-kind routing is preserved: response kinds targeting the hub go to the hub's relay inbox. Platform-intake affinity is preserved and orthogonal -- intake routing is by platform connector, not by model, and is unaffected by the trust-basis change.

### 6.4 Webhook Ingestion and Passive Relay Kinds

Webhook intake (`kind: "webhook_intake"`) enters the relay inbox by local HTTP ingestion on the receiving host, not by a peer frame. It is locally originated and therefore trusted under R-SR3. The relay processor already skips passive kinds; the scheduler is the consumer. This RFC does not change passive-kind handling.

### 6.5 Scheduler, Event Bus, Quiescence, Heartbeats

No interaction. The `relay:inbox` event still fires when an entry is admitted; the change is only that more entries are admitted (sibling-spoke-originated ones that were previously rejected). The scheduler, `lastUserInteractionAt`/quiescence, and heartbeats observe no new semantics.

### 6.6 Change Log and Sync

No interaction. The relay tables (`relay_inbox`, `relay_outbox`, `relay_cycles`) are local-only: they are not members of the synced-table set, so they are excluded from every cross-host state-transfer path -- not only the steady-state change-log outbox, but also the initial snapshot seeded to a newly-joining spoke and backfill/restore reconciliation. No mechanism writes a relay-inbox entry on a host except (a) the transport layer admitting a per-peer-decoded frame, or (b) local origination on that host. This is the load-bearing premise of R-SR3 and R-SR7: because no snapshot, backfill, or restore path can seed a relay-inbox row, an entry's presence in the inbox always implies prior delivery-time authentication or local origination -- there is no third seeding path by which an entry could appear without having passed per-peer frame decode. This RFC therefore introduces no change-log entries and no sync-reducer changes. A host on pre-fix code and a host on post-fix code differ only in whether they reject sibling-originated relay entries locally; they exchange no state that encodes this difference.

### 6.7 Accepted Gaps

Direct spoke-to-spoke connections remain unsupported (R-SR8). A host still cannot authenticate a peer it has no keyring entry for, so relay between two spokes depends on hub mediation. If the hub is offline, spoke-to-spoke relay is unavailable -- unchanged from today, where a spoke with no hub connection cannot relay at all.

A compromised hub can inject relay work into any spoke claiming any origin. This RFC does not expand the hub's power: a compromised hub already relays all replicated change-log state and is in the trusted computing base. Relay authorization keying on the delivering peer extends the same existing trust to inference dispatch.

Delegated-loop relay kinds depend on sync convergence at the target. The `inference` kind transports its full prompt context in the relay payload (inline, or by `messages_file_ref` for large prompts), so a sibling-spoke target serves it without needing the originating thread locally -- the #50 flow carries no such dependency. The `process` kind instead runs a delegated agent loop that reads the thread's history from the target's local database, which depends on change-log sync having propagated that thread's messages to the target. Because removing the origin gate newly admits sibling-spoke `process` entries, a `process` routed to a sibling spoke before that thread's latest messages have converged there would execute against whatever history has synced so far. This is a sync-convergence timing dependency rather than a trust gap, and it is distinct from the authorization change this RFC makes. This RFC does not add synchronization between relay dispatch and change-log propagation; gating delegated-loop dispatch on a sync watermark is deferred.

## 7. Design Choices

### 7.1 Why Authenticated-Delivering-Peer over `source_site_id` Keyring Membership

The rejected approach authorizes a relay entry by checking the entry's origin (`source_site_id`) against the local keyring. The chosen approach authorizes by the authenticated identity of the peer that delivered the frame. The origin check fails for legitimate spoke-to-spoke traffic because the keyring is populated along connection lines and spokes do not connect to each other -- the sibling's identity is never present. The delivering-peer check succeeds because the delivering peer (the hub) is always a keyring member by construction; a frame that decoded must have come from one. The delivering-peer basis is also cryptographically stronger: it is established by successful frame decode under a derived shared secret, not by string-set membership applied to a field. This choice follows the **trust-model uniformity** tenet -- relay adopts the same transitive-trust-through-the-hub basis the cluster already uses for replicated state.

### 7.2 Why Hub-Vouched Transitive Trust over Full-Mesh Keyring Distribution

The rejected alternative distributes every host's identity to every other host, producing a full keyring on each node and preserving the `source_site_id` check (which then passes because the sibling's identity is present). This approach works and enables direct spoke-to-spoke connections as a side effect. It is rejected because it grows the trust surface from O(n) hub-and-spoke relationships to O(n²) all-pairs relationships to solve a problem the hub already mediates, and it requires a new key-distribution mechanism (the hub serves peer keys, and spokes consume and trust them). Hub-vouched trust adds no mechanism: the hub already authenticates each spoke and already stamps the origin. This choice follows the **hub-mediated minimalism** tenet. The cost -- no direct spoke-to-spoke relay without future work (R-SR8) -- is accepted because no such connections exist.

### 7.3 Why Removing the Check over Rewriting It to Key on the Delivering Peer

A middle option keeps an explicit application-layer authorization check but keys it on the delivering peer rather than the origin -- for example, by recording the delivering peer on the inbox entry and validating it in the processor. This is rejected because the transport layer already performs exactly this authentication: a relay-inbox entry exists only because a frame decoded under a peer key. Re-checking the delivering peer in the application layer re-asserts a guarantee the transport already provides, and requires threading the delivering identity from the frame boundary into the inbox row for the processor to read. Removing the origin check and relying on transport authentication is simpler and strictly sufficient. This follows the **trust-model uniformity** tenet: one authentication seam, at the transport boundary, rather than two.

### 7.4 Why `source_site_id` Is Retained Rather than Removed

`source_site_id` stops being an authorization input but is not removed from the relay entry. It remains the hub's attestation of the originating host and is load-bearing for response correlation (routing results back to the right source) and audit (which host originated a given request). Removing it breaks response routing and erases audit provenance for a field that is cheap to retain. This follows the **cluster reachability** tenet: the receiver trusts the hub's attestation of origin for routing while declining to use it as a gate.

## 8. Testing Strategy

### 8.1 Unit Tests

- The relay processor processes an inbox entry whose `source_site_id` is absent from the local keyring, when the entry is present in the inbox (R-SR1, R-SR7, R-SR11). Assert inference executes and no `Unknown source site` error is produced.
- The relay processor processes an entry whose `source_site_id` is present in the keyring (regression: existing hub-originated and self-originated flows still work).
- The hub stamps `source_site_id` from the authenticated sender identity, not from a payload-supplied source field (R-SR6). Construct a request whose payload carries a conflicting source value; assert the stamped value is the authenticated sender.
- A frame that fails per-peer decode produces no relay-inbox entry (R-SR3, R-SR12). Assert the transport drops it and the processor never sees it.

### 8.2 Integration Tests

- Three-host topology (hub with no models, two spokes, one modelless, one serving a model). A user message on the modelless spoke triggers an inference relayed through the hub to the model-bearing spoke; assert the result returns to the modelless spoke and no `Unknown source site` error occurs (R-SR4, R-SR5, §5.1).
- Response routing: the model-bearing spoke emits `stream_chunk`/`stream_end`/`result`, and the modelless spoke assembles them by `ref_id` without any keyring entry for the model-bearing spoke (R-SR5, §5.3).
- Offline target: the model-bearing spoke is disconnected; assert the hub fast-fails a synchronous request with `retriable: true` (regression, §5.1 error cases).

### 8.3 Compatibility

- A spoke running pre-fix code in the same cluster still rejects sibling-originated relay entries locally; a spoke running post-fix code accepts them. Assert no cross-host state encodes the difference (relay tables are local-only, §6.6) and that mixed-version operation degrades only in which host can serve a given relay, not in correctness.
- No schema migration is required (§4.1); assert a node upgrading in place needs no relay-table migration.
