# #253 hub-side CONSUMER leg trace @ 1c88f745

Transport healed (spoke->hub SPOOL_TRANSFER inserts+acks; hub->spoke delivers dispatch rows). Discord tools/list from the spoke still times out; zero response:% rows arrive back. The break is on the hub, AFTER handleSpoolTransfer inserts a self-targeted platform_request row.

## The consumer chain, file:line

handleSpoolTransfer (packages/sync/src/ws-transport.ts:1788). For a self-targeted row (entry.target_site_id === siteId, line 1861):
- insertDurableWork (1825): row pending, target=hub, kind=platform_request, source_site=spoke
- emits relay:inbox (1862) to wake the local lane
- acks the entry to the spoke (1870) -- THIS IS THE ACK YOU SEE. It proves INSERT, not consumption.

Consumer = RelayProcessor durable lane:
1. Tick RelayProcessor.start() (packages/agent/src/relay-processor.ts:276). merge(tick$, wakeup$) (287): tick$=interval(500ms) (DEFAULT_POLL_INTERVAL_MS=500, line 121), wakeup$=fromEventBus("relay:outbox-written") (285). Each tick -> processPendingEntries (291) -> processPendingDurableWork (464).
2. Claim processPendingDurableWork (464): skips non-relay/response kinds (467), claimLocalDurableWork(db, siteId, "platform_request") (470). Query: SELECT * FROM durable_work WHERE target_site_id=? AND kind=? AND claim_state='pending' -> UPDATE claim_state='processing' (packages/core/src/durable-work.ts:209-257). platform_request is a sync-dispatch relay kind, target=hub=siteId -> matches, claimed.
3. source_site guard (515): writesResponse = dispatch==='sync' -> true. If claimed.source_site missing, DEAD-LETTER immediately (517), log "Dead-lettered durable relay row missing source_site".
4. Dispatch dispatchDurableEntry (549) -> handler platform_request: executePlatformRequest (215/1390).
5. Execute executePlatformRequest (1390): needs platformMcpRegistry (1391 throws "Platform MCP registry not available on this host"), getClient(server_name) (1394 throws "Platform server '...' not found on this host"), client.request (1403).
6. Response write writeResponse(entry,"result",payload) (1476) -> routeRelayResponse(db, {targetSiteId: spoke, kind:"result", idempotencyKey:"response:<reqId>"}) (1491).
7. Response routing decision routeRelayResponse (packages/agent/src/relay-router.ts:644) -> shouldRouteRelayDurable(db, {targetSiteId: spoke, localSiteId: hub, topologyRole}) (648). durable -> insertDurableWork peer-targeted at spoke, pending (657); durable_work:written transport listener (ws-transport.ts:442) then sendDurableWorkToPeer(spoke,id). NOT durable -> writeOutbox into legacy relay_outbox (683).
8. Requester await spoke remotePlatformRequest (packages/cli/src/commands/start/server.ts:136-179) polls readInboxByRefId for 15s / awaits durable response union. Never arrives -> "Timeout waiting for platform_request response".

## Silent failure points, ranked

The lane poll floor (500ms interval, independent of the wakeup event) STRUCTURALLY RULES OUT "lane never runs" -- the tick fires regardless of the relay:inbox/relay:outbox-written mismatch (see #4). Break is at execute or response-routing.

### #1 -- Response gate routes into legacy relay_outbox, which never reaches the spoke (MOST LIKELY)
shouldRouteRelayDurable for the RESPONSE (target=spoke) requires the HUB to advertise the SPOKE as work_spool_capable (relay-router.ts:490, !advertises(targetSiteId) -> return false). advertises reads the hub's local hosts row for the spoke (findHostWorkSpoolCapabilityById, packages/core/src/repositories/hosts.ts:377). If that row has work_spool_capable=0 on the hub, the response falls to legacy relay_outbox (683). On the hub that either throws (if hub dropped legacy tables, post-4E) or writes a relay_outbox row with NO drain to the spoke.
ASYMMETRY IS THE TELL: requests flow (spoke->hub; hub is capable, spoke advertised capable since requests transfer), responses don't (hub->spoke; hub's VIEW of spoke capability). Matches evidence exactly: request consumed, response written to a dead store, zero response:% rows.

### #2 -- platformMcpRegistry null / discord client not found (execution wedged)
executePlatformRequest throws if registry null (1391) or getClient("discord") miss (1395). setPlatformMcpRegistry IS wired at hub startup (server.ts:1506, outside the connectors.length>0 branch), so NOT the holder-class omission. If discord not in registry, execution throws -> caught at 558 -> row stays processing, retried, dead-lettered after DURABLE_RELAY_MAX_ATTEMPTS.
DISCRIMINATOR: row in processing / rising attempt_count, then dead-letter. NOT pending, NOT consumed-with-no-response.

### #3 -- Row dead-lettered for missing source_site
lines 515-528 dead-letter BEFORE execution. DISCRIMINATOR: terminal claim_state, last_error="missing source_site".

### #4 -- Wakeup-event mismatch (NON-fatal, latent defect)
handleSpoolTransfer emits relay:inbox (ws-transport.ts:1862) but the tick's wakeup$ subscribes to relay:outbox-written (relay-processor.ts:285). The self-targeted spool insert does NOT nudge the lane -- only the 500ms poll picks it up. Comment at ws-transport.ts:1857-1860 claims "the 4D-A lane runs on the relay-processor tick, nudged by relay:inbox" -- the lane does NOT listen on relay:inbox. Same CLASS as the holder bug (emit into a listener that isn't there), masked by the poll fallback. Fix regardless; not the cause of permanent silence.

### #5 -- Response inserted, wrong siteId
Would show as response:% durable_work row with target_site_id != spoke. Low: writeResponse sets targetSiteId=source_site_id (1481).

## Hub DB probe -- exact queries

Container DB path /app/data/bound.db (Dockerfile:30-31, VOLUME ["/app/config","/app/data"]).

(A) platform_request row states:
docker exec <hub> sqlite3 /app/data/bound.db "SELECT id, claim_state, attempt_count, source_site, substr(last_error,1,80) AS err, created_at FROM durable_work WHERE kind='platform_request' ORDER BY created_at DESC LIMIT 20;"
- pending forever -> lane not running (should be impossible w/ poll floor; check "[relay] Relay processor started")
- processing/rising attempt_count -> execution wedged -> #2
- consumed, NO matching response:% row (query C) -> response leg broken -> #1
- dead-letter, err="missing source_site" -> #3

(B) Does hub advertise SPOKE as capable? (THE #1 discriminator)
docker exec <hub> sqlite3 /app/data/bound.db "SELECT site_id, host_name, work_spool_capable, online_at FROM hosts WHERE deleted=0;"
Spoke row work_spool_capable=0 (or absent) -> #1 CONFIRMED.

(C) Response row written, targeted where?
docker exec <hub> sqlite3 /app/data/bound.db "SELECT id, kind, target_site_id, claim_state, idempotency_key, created_at FROM durable_work WHERE idempotency_key LIKE 'response:%' ORDER BY created_at DESC LIMIT 20;"
- none AND requests consumed -> #1 (legacy) or #2/#3 (no response produced)
- rows target=spoke stuck pending -> transport not transferring (different bug)
- rows target != spoke -> #5

(D) Legacy outbox catch (confirms #1):
docker exec <hub> sqlite3 /app/data/bound.db "SELECT COUNT(*), kind, target_site_id FROM relay_outbox WHERE kind IN ('result','error') GROUP BY kind, target_site_id;"
- "no such table" -> hub dropped legacy (post-4E) -> #1's legacy write THROWS; grep for the exception
- undelivered result rows target=spoke -> #1 CONFIRMED

## Logging present at each hop (post-1c88f745)

(a) Lane claiming the row: NO dedicated per-claim log. claimLocalDurableWork runs under instrument("claim",kind) (metric span, durable-work.ts:214) -- trace only, not greppable. Nearest failure logs: "Lost durable relay claim before acknowledgement" (554), "Durable relay processing failed before dispatch completion" (563). A SUCCESSFUL claim+dispatch of platform_request logs NOTHING at info. Real observability hole for this incident.

(b) Discord tools/list executing: NO log inside executePlatformRequest (1390-1414). Registry-null / client-miss surfaces only as thrown Error string, reaching the caller's error response and (durable path) the dispatch catch "Durable relay processing failed before dispatch completion".

(c) Response inserted/sent: routeRelayResponse logs NOTHING. A durable response transfer logs "WsTransport spool received" on the SPOKE (you'd see it if it transferred -- you don't). Dead-letters log "Dead-lettered durable relay row missing source_site" (523). Startup liveness: "[relay] Relay processor started" (packages/cli/src/commands/start/relay.ts:77), "[platforms-mcp] Relay processor wired" (server.ts:1507).

Grep set for the hub:
grep -E "Relay processor started|Relay processor wired|Platform server .* not found|Platform MCP registry not available|failed before dispatch completion|Dead-lettered durable relay row missing source_site|WsTransport spool received" <hub-log>

If NONE of the failure lines fire and requests sit consumed with no response row, the silence is #1 (routing to a dead store, which logs nothing). The hole at (a)/(c) is precisely why this incident is invisible.

## Minimal fix shape for #1 (most likely)

The response leg's capability gate is ASYMMETRIC with the request leg. Request spoke->hub works because the spoke sees the hub as capable (hub advertises itself). Response hub->spoke fails because the hub's hosts row for the spoke has work_spool_capable=0 -- the hub never learned the spoke is capable, routes the response to legacy, which on a spool-only hub goes nowhere.

Two candidate fixes, narrowest first:

1. DATA FIX (if spoke genuinely capable but hub's hosts row stale): the spoke must advertise work_spool_capable in its heartbeat/host announcement and the hub must persist it. Probe (B) tells you. If capability advertisement isn't propagating spoke->hub, that's the root fix (mirror of how the hub's capability reached the spoke).

2. CODE FIX (if legacy is a genuine dead-end for a hub->spoke response): on a post-4E/spool-only hub, a response that can't route durable must not silently write into a relay_outbox that never drains. routeRelayResponse's legacy branch (relay-router.ts:670-684) should, when the local host has dropped legacy tables (hasDroppedLegacyRelayTables), either (a) still write durable peer-targeted (the spoke drains it on its own reconnect/poll even if the hub's capability view is stale -- the receiver fence makes it safe), or (b) raise a loud dead-letter/advisory instead of a silent legacy write. Option (a) is the forward-fix: treat a dropped-legacy host as unconditionally durable-routing for responses, since it has no working legacy transport to fall back to. Removes the asymmetry -- the response rides the same spool the request rode in on.

Confirm with (A)+(B)+(C)+(D) before choosing: (B) shows data-propagation gap (fix 1) vs genuine routing dead-end (fix 2).
