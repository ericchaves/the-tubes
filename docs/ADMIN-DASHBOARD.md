# Admin Dashboard

the tubes includes a built-in real-time dashboard served at `/tubes`. It is designed for developers and server operators who need to observe live tunnel traffic, diagnose delivery failures, and manage active sessions.

## Accessing the Dashboard

The dashboard is served by the same server that handles tunnel management (`--api-port` when configured, otherwise `--public-port`).

```
http://<server-host>:<api-port>/tubes
```

Examples:

```bash
# Local development (shared port)
tt serve --public-port 8080
# → http://localhost:8080/tubes

# Separate API port
tt serve --public-port 80 --api-port 9000
# → http://localhost:9000/tubes
```

Authentication is required. The token is auto-generated on first start and saved to `~/.tt/admin-token`. See [SECURITY.md — Admin Dashboard Token](./SECURITY.md#admin-dashboard-token).

To open the dashboard directly in a browser, navigate to `https://user:<token>@<host>:<port>/tubes` — the browser will prompt for credentials via BasicAuth. For API/scripting use, send `X-TT-Admin-Token: <token>` or `Authorization: Bearer <token>`.

---

## Server Dashboard — `/tubes`

Displays:

- **Active tunnels** — live list of all connected and disconnected-but-reserved expose sessions, with tunnel ID, connection state, creation time, port, and number of active pairs.
- **Server activity** — a rolling log of tunnel lifecycle, security, and server error events, updated in real time via SSE.
- **Blocklist** — link to `/tubes/blocklist` for IP management.
- **Server configuration** — all active settings except sensitive values (`hmacSecret`, `hmacSecretFile`, `adminToken`). Includes port, domain, reconnect window, max connections, HMAC status, rate limit settings, etc.

Clicking a tunnel ID navigates to its detail page.

---

## Blocklist Page — `/tubes/blocklist`

Displays and manages IP blocks at two levels:

- **Temporarily blocked** — IPs blocked by the in-process rate limiter. Shows IP and unblock time. Can be manually unblocked.
- **Permanently blocked** — IPs in the persistent blocklist (`blocklist.json`). Can be added or removed. Survives server restarts.

The page updates in real time via SSE as IPs are blocked/unblocked.

See [SECURITY.md — IP Blocklist](./SECURITY.md#ip-blocklist) for the API reference.

---

## Tunnel Detail Page — `/tubes/:tunnelId`

Displays a chronological log of every event for a single tunnel, with color coding:

| Color | Meaning |
|---|---|
| Green | Success — response complete, tunnel connected/reconnected |
| Red | Failure — request failed, WS failed, socket error |
| Orange | Aborted — response or WS interrupted mid-stream |
| Cyan | Delivered — socket obtained, forwarding started |
| Purple | WebSocket event |
| Gray | Received — request arrived at public port |

Each row shows timestamp, event type, and a summary of key fields (method, path, status, bytes, duration, reason).

A **Disconnect** button at the top destroys the tunnel immediately (equivalent to `POST /tubes/:tunnelId/disconnect`).

---

## Client Admin Dashboard

The expose client (`tt expose`) also has a built-in dashboard, served locally at `--admin-port`:

```bash
tt expose --local-port 3000 --admin-port 4040
# → http://localhost:4040
```

Displays:

- **Tunnel status** — public URL, tunnel ID, local address, max connections, uptime.
- **Health tracker** — total/recent failures, reconnect loop detection bar.
- **Flows** — list replay flows and trigger them manually.
- **Activity log** — live stream of all client-side events including auth errors.
- **Server Access** — update the HMAC secret used for tunnel creation without restarting.

### Server Access section

The Server Access section allows updating the token sent to the tt server at runtime (useful when the server rotates its admin token). The current token is masked by default; click 👁 to reveal or 📋 to copy.

---

## Real-Time Updates (SSE)

Both pages use [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events). The browser keeps a persistent HTTP connection open and receives events as they happen. No polling, no WebSocket setup required.

The dot indicator in the top-right corner of each page shows the SSE connection state:

- **Green dot** — connected, receiving events live
- **Gray dot** — connecting or reconnecting

---

## API Endpoints

The dashboard is backed by two SSE endpoints you can also consume programmatically (e.g. from a terminal with `curl`). All requests require the `X-TT-Admin-Token` header.

### Global event stream

```
GET /tubes/events
```

Sends a `server.state` event first (current config and tunnel list), then forwards tunnel lifecycle, security, and server error events in real time.

```bash
curl -N -H "X-TT-Admin-Token: $TOKEN" http://localhost:9000/tubes/events
```

### Per-tunnel event stream

```
GET /tubes/:tunnelId/events
```

Sends the full ring-buffer history (up to 500 events) immediately, then live events.

```bash
curl -N -H "X-TT-Admin-Token: $TOKEN" http://localhost:9000/tubes/bold-raven-a1b2c3/events
```

### Disconnect a tunnel

```
POST /tubes/:tunnelId/disconnect
```

Destroys the tunnel and closes all its TCP connections. The expose client will enter its reconnect window.

### Rotate admin token

```
POST /api/admin/rotate-token
```

Generates a new admin token, saves it to disk, and emits a `server.token_rotated` event. The response includes the new token. Subsequent requests must use the new token.

```bash
NEW_TOKEN=$(curl -s -X POST -H "X-TT-Admin-Token: $TOKEN" \
  http://localhost:9000/api/admin/rotate-token | jq -r .token)
```

---

## Event Reference

Every event has the shape:

```json
{ "seq": 42, "ts": "2026-04-15T14:22:03.412Z", "type": "...", "tunnelId": "bold-raven-a1b2c3", ...fields }
```

### Tunnel lifecycle

| Type | Fields | Meaning |
|---|---|---|
| `tunnel.created` | `port, maxConnections, reconnectWindowMs, sessionTokenPrefix` | expose session registered; TCP listener started |
| `tunnel.window_expired` | — | reconnect window elapsed; tunnel will be destroyed |
| `tunnel.destroyed` | — | tunnel fully removed |

### Control channel lifecycle

| Type | Fields | Meaning |
|---|---|---|
| `control.connected` | `controlId, remoteAddr, keptPairs, droppedPairs` | expose client connected (initial); control WS established |
| `control.resumed` | `controlId, previousControlId, remoteAddr, keptPairs, droppedPairs` | same session reconnected within the window; `keptPairs` inflight requests preserved |
| `control.disconnected` | `controlId, reason, durationMs, inflightPairs` | control WS dropped; reconnect window started |
| `control.heartbeat_timeout` | `controlId, lastPongAgoMs` | expose client stopped responding to pings |

### Pair lifecycle (server-side)

| Type | Fields | Meaning |
|---|---|---|
| `pair.requested` | `pairId, requestId, kind, method, path, remoteAddr` | `pair.open` sent to expose client; waiting for data socket |
| `pair.opened` | `pairId, requestId` | data socket received and preamble matched; proxying started |
| `pair.replaced` | `pairId, previousControlId` | WS reconnect: stale data socket replaced with new REPLACES socket |
| `pair.local_refused` | `pairId, requestId, reason` | expose client sent `pair.failed`; local service unreachable |
| `pair.closed` | `pairId, requestId, reason, bytesIn, bytesOut, durationMs` | expose client reported pair closed normally |

### Security events

These events have `tunnelId: '__global__'` and appear in the global stream at `/tubes/events`.

| Type | Fields | Meaning |
|---|---|---|
| `ip.blocked` | `ip, blockedUntil, reason` | IP temporarily blocked by rate limiter |
| `ip.unblocked` | `ip` | Temporary block lifted (expired or manually removed) |
| `ip.added_permanent` | `ip` | IP added to permanent blocklist |
| `ip.removed_permanent` | `ip` | IP removed from permanent blocklist |
| `server.request_blocked` | `ip, method, host` | Request rejected — IP is on permanent or temporary blocklist |
| `server.token_rotated` | — | Admin token was rotated via the dashboard or API |

### Server-level errors

| Type | Fields | Meaning |
|---|---|---|
| `server.error` | `reason, statusSent, method?, path?, host?, clientIp?, detail?` | The server rejected or failed to handle a request |

`server.error` reasons:

| Reason | Status | Cause |
|---|---|---|
| `tunnel_not_found` | 404 | Request arrived for a subdomain with no registered tunnel |
| `auth_rejected` | 400/401 | Missing or invalid session token, or HMAC verification failure |
| `bad_request` | 400 | Request body could not be read during tunnel creation |
| `internal_error` | 500 | Unexpected exception in the request or WS upgrade handler |

### HTTP requests

| Type | Fields | Meaning |
|---|---|---|
| `request.received` | `requestId, method, path, headers` | request arrived at public port (sensitive headers redacted) |
| `request.delivered` | `requestId, method, path, pairId` | data socket matched; forwarding started |
| `request.failed` | `requestId, method, path, reason, statusSent` | could not deliver — client gets 503 |
| `response.complete` | `requestId, method, path, status, bytesIn, bytesOut, durationMs` | response fully sent to requester |
| `response.aborted` | `requestId, method, path, reason, status, bytesIn, bytesOut, durationMs` | connection broken before response finished |

`request.failed` reasons: `no_control_channel` (expose not connected), `max_connections` (concurrent pair limit hit), `no_socket_available` (data socket not received within timeout).  
`response.aborted` reasons: `client_disconnected`, `socket_error`, `response_error`, `request_aborted`.

### WebSocket upgrades

| Type | Fields | Meaning |
|---|---|---|
| `ws.received` | `requestId, path, remoteAddr` | upgrade request arrived at public port |
| `ws.delivered` | `requestId, path, pairId` | data socket matched; proxying started |
| `ws.failed` | `requestId, path, reason` | could not establish pair; 503 sent |
| `ws.closed` | `requestId, path, reason, bytesIn, bytesOut, durationMs` | WebSocket session ended |

`ws.failed` reasons: `no_control_channel`, `max_connections`, `no_socket_available`.  
`ws.closed` reasons: `socket_closed`, `client_closed`, `socket_error`, `client_error`.

### Client-side events (expose client dashboard)

These events appear in the client dashboard activity log.

| Type | Fields | Meaning |
|---|---|---|
| `expose.started` | `serverUrl, localAddress, localPort, publicUrl` | tunnel opened |
| `tunnel.open` | `tunnelId, publicUrl, maxConnections` | first connection pool ready |
| `pair.open` | `pairId` | TCP connection to server established |
| `pair.dead` | `pairId, reason, kind, retriable` | TCP connection dropped |
| `failure.recorded` | `kind, totalFailures, recentFailures` | reconnect failure recorded |
| `reconnect.scheduled` | `delayMs` | backoff delay scheduled |
| `local.down` | `address, port` | local service stopped responding |
| `local.up` | `address, port` | local service came back online |
| `request` | `method, path, status` | HTTP request proxied |
| `capture.saved` | `captureId, file, method, path` | request/response written to capture file |
| `auth.rejected` | `code, reason` | server rejected tunnel creation (401 or 403) |
| `tunnel.token_missing` | `code, reason` | server requires HMAC authentication (401); check Server Access section |
| `server.token_updated` | `maskedToken` | server token updated via client admin UI |
| `expose.exit` | `code, reason` | client exiting |

---

## Diagnosing Common Scenarios

### Request arrived but expose client was offline

```
request.received  → request.failed  (reason: no_control_channel, statusSent: 503)
```

### Request delivered successfully

```
request.received  → pair.requested  → pair.opened  → request.delivered  → response.complete  (status: 200, durationMs: 45)
```

### Local service was unreachable (ECONNREFUSED)

```
request.received  → pair.requested  → pair.local_refused  → request.failed  (statusSent: 503)
```

### Expose client did not reconnect — tunnel removed

```
control.disconnected  (reason: ws_closed, inflightPairs: [])
tunnel.window_expired
tunnel.destroyed
```

### IP scanning — blocked by rate limiter

```
server.error  (reason: tunnel_not_found, clientIp: 1.2.3.4)  × N
ip.blocked    (ip: 1.2.3.4, blockedUntil: ..., reason: rate_limit_exceeded)
server.request_blocked  (ip: 1.2.3.4, ...)  × M
ip.unblocked  (ip: 1.2.3.4)
```

### Expose client failed to authenticate

```
auth.rejected       (code: 401, reason: "Invalid HMAC signature")
tunnel.token_missing  (code: 401, ...)
```
The client exits immediately. Open the Server Access section in the client dashboard and verify the HMAC secret matches the server's `--hmac-secret`.

---

## Security

Access to the admin dashboard is protected by an **admin token** (`X-TT-Admin-Token` header or `Authorization: Bearer <token>`). Unauthenticated requests to `/tubes/*` and `/api/*` receive a `401 Unauthorized` response.

Additional hardening recommendations:

- **Separate API port** — use `--api-port 9000` and block port 9000 from the public internet.
- **Localhost only** — set `--api-address 127.0.0.1` if the dashboard is only needed locally.
- **Token rotation** — rotate the admin token after deployment and store it in a secrets manager.

Request headers that arrive at the public port are logged with sensitive values redacted (`authorization`, `cookie`, `set-cookie`, `x-tt-auth`, `x-tt-session-token`, `x-hub-signature`, `x-hub-signature-256`, `x-api-key`, `x-amz-security-token`). Header names are preserved for diagnostics.

See [SECURITY.md](./SECURITY.md) for the full threat model.

---

## Ring Buffer

Each tunnel keeps the last **500 events** in memory. The global stream keeps the last **1 000 events** across all tunnels. On disconnect and reconnect, new SSE clients receive the full buffered history immediately before live updates begin.

Events are never written to disk.
