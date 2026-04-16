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

No login is required. Access should be restricted at the network or firewall level (see [Security](#security)).

---

## Overview Page — `/tubes`

Displays:

- **Active tunnels** — live list of all connected and disconnected-but-reserved expose sessions, with tunnel ID, connection state, creation time, port, and available socket count.
- **Server activity** — a rolling log of tunnel lifecycle events, delivery failures, and server-level errors (`server.error`) across all tunnels, updated in real time via SSE. Normal traffic events (`request.received`, `request.delivered`, `response.complete`, `ws.*`) are not shown here — visit the tunnel detail page to see per-tunnel traffic.
- **Server configuration** — all active settings except sensitive values (`hmacSecret`, `hmacSecretFile`). Includes port, domain, reconnect window, max connections, HMAC status, etc.

Clicking a tunnel ID navigates to its detail page. To monitor full request/response traffic for a specific tunnel in real time, use `/tubes/:tunnelId`.

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

## Real-Time Updates (SSE)

Both pages use [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events). The browser keeps a persistent HTTP connection open and receives events as they happen. No polling, no WebSocket setup required.

The dot indicator in the top-right corner of each page shows the SSE connection state:

- **Green dot** — connected, receiving events live
- **Gray dot** — connecting or reconnecting

---

## API Endpoints

The dashboard is backed by two SSE endpoints you can also consume programmatically (e.g. from a terminal with `curl`):

### Global event stream

```
GET /tubes/events
```

Sends a `server.state` event first (current config and tunnel list), then forwards tunnel lifecycle, failure, and server error events in real time. Filtered to: `tunnel.created`, `tunnel.connected`, `tunnel.disconnected`, `tunnel.reconnected`, `tunnel.window_expired`, `tunnel.destroyed`, `request.failed`, `response.aborted`, `ws.failed`, `server.error`.

For the full unfiltered event stream of a specific tunnel, use `/tubes/:tunnelId/events`.

```bash
curl -N http://localhost:9000/tubes/events
```

### Per-tunnel event stream

```
GET /tubes/:tunnelId/events
```

Sends the full ring-buffer history (up to 500 events) immediately, then live events.

```bash
curl -N http://localhost:9000/tubes/bold-raven/events
```

### Disconnect a tunnel

```
POST /tubes/:tunnelId/disconnect
```

Destroys the tunnel and closes all its TCP connections. The expose client will enter its reconnect window.

```bash
curl -X POST http://localhost:9000/tubes/bold-raven/disconnect
```

---

## Event Reference

Every event has the shape:

```json
{ "seq": 42, "ts": "2026-04-15T14:22:03.412Z", "type": "...", "tunnelId": "bold-raven", ...fields }
```

### Tunnel lifecycle

| Type | Fields | Meaning |
|---|---|---|
| `tunnel.created` | `port, maxConnections, reconnectWindowMs, sessionTokenPrefix` | expose session registered; TCP listener started |
| `tunnel.connected` | `port, socketCount` | expose client connected (initial or after reconnect window) |
| `tunnel.disconnected` | `reconnectWindowMs` | expose client dropped; reservation held for `reconnectWindowMs` ms |
| `tunnel.reconnected` | `socketCount` | same session token reconnected within the window |
| `tunnel.window_expired` | — | reconnect window elapsed; tunnel will be destroyed |
| `tunnel.destroyed` | — | tunnel fully removed |

### Server-level errors

These events have `tunnelId: '__global__'` — they are not associated with any specific tunnel.

| Type | Fields | Meaning |
|---|---|---|
| `server.error` | `reason, statusSent, method?, path?, host?, detail?` | The server rejected or failed to handle a request at the infrastructure level |

`server.error` reasons:

| Reason | Status | Cause |
|---|---|---|
| `tunnel_not_found` | 404 | Request arrived for a subdomain with no registered tunnel |
| `auth_rejected` | 400/401 | Missing or invalid session token, or HMAC verification failure |
| `bad_request` | 400 | Request body could not be read during tunnel creation |
| `internal_error` | 500 | Unexpected exception in the request or WS upgrade handler |

---

### HTTP requests

| Type | Fields | Meaning |
|---|---|---|
| `request.received` | `requestId, method, path, headers` | request arrived at public port (sensitive headers redacted) |
| `request.waiting` | `requestId, method, path` | waiting for a tunnel socket (pool temporarily empty) |
| `request.delivered` | `requestId, method, path, socketPoolRemaining` | socket obtained; forwarding started |
| `request.failed` | `requestId, method, path, reason, statusSent` | could not deliver — client gets 503 |
| `response.complete` | `requestId, method, path, status, bytesIn, bytesOut, durationMs` | response fully sent to requester |
| `response.aborted` | `requestId, method, path, reason, status, bytesIn, bytesOut, durationMs` | connection broken before response finished |

`request.failed` reasons: `no_socket_available`, `null_socket`.  
`response.aborted` reasons: `client_disconnected`, `socket_error`, `response_error`, `request_aborted`.

### WebSocket upgrades

| Type | Fields | Meaning |
|---|---|---|
| `ws.received` | `requestId, path` | upgrade request arrived at public port |
| `ws.delivered` | `requestId, path, socketPoolRemaining` | tunnel socket obtained; proxying started |
| `ws.failed` | `requestId, path, reason` | could not establish tunnel socket; 503 sent |
| `ws.closed` | `requestId, path, reason, bytesIn, bytesOut, durationMs` | WebSocket session ended |

`ws.closed` reasons: `socket_closed`, `client_closed`, `socket_error`, `client_error`.

---

## Diagnosing Common Scenarios

### Request arrived but expose client was offline

```
request.received  → request.failed  (reason: no_socket_available, statusSent: 503)
```

The expose process was not connected when the request arrived. The requester received a 503. Check `tunnel.disconnected` in the preceding events to find when the client went offline.

### Request delivered successfully

```
request.received  → request.delivered  → response.complete  (status: 200, durationMs: 45)
```

Normal round-trip. `bytesIn` is the request body size, `bytesOut` is the response size including headers.

### Upstream disconnected before response finished (e.g. WhatsApp API timeout)

```
request.delivered  → response.aborted  (reason: client_disconnected, status: 200, bytesOut: 512)
```

The remote caller (upstream API, browser) closed the connection before the tubes finished forwarding the response. This is normal for long-polling or slow local services. `status` shows what your service responded; `bytesOut` shows how much was forwarded before the abort.

### WebSocket proxied then closed by local service

```
ws.received  → ws.delivered  → ws.closed  (reason: socket_closed, durationMs: 3200, bytesIn: 1024, bytesOut: 2048)
```

`socket_closed` means the local service ended the WebSocket. `client_closed` would mean the remote browser disconnected first.

### Expose client disconnected and reconnected within the window

```
tunnel.disconnected  (reconnectWindowMs: 30000)
tunnel.reconnected   (socketCount: 10)
```

The same session token reconnected before the window expired. The tunnel ID and public URL were preserved.

### Expose client did not reconnect — tunnel removed

```
tunnel.disconnected  (reconnectWindowMs: 30000)
tunnel.window_expired
tunnel.destroyed
```

No reconnect within the window. The next `tt expose` for the same session token will get a new tunnel ID.

---

## Security

The admin dashboard has **no built-in authentication**. It exposes server configuration, request metadata (paths, headers), and tunnel session token prefixes.

Restrict access at the network level:

- **Separate API port** — use `--api-port 9000` and block port 9000 from public internet (firewall rule, VPC security group). The public tunnel port (`:80`/`:443`) remains open.
- **Reverse proxy auth** — put the API port behind a proxy with HTTP Basic Auth or mTLS.
- **Localhost only** — set `--api-address 127.0.0.1` if the dashboard is only needed locally.

```bash
# API port visible only on loopback
tt serve \
  --public-port 80 \
  --api-port 9000 \
  --api-address 127.0.0.1

# Dashboard: http://127.0.0.1:9000/tubes
```

Request headers that arrive at the public port are logged with sensitive values redacted (`authorization`, `cookie`, `set-cookie`, `x-tt-auth`, `x-tt-session-token`, `x-hub-signature`, `x-hub-signature-256`, `x-api-key`, `x-amz-security-token`). Header names are preserved for diagnostics.

See [SECURITY.md](./SECURITY.md) for the full threat model.

---

## Ring Buffer

Each tunnel keeps the last **500 events** in memory. The global stream keeps the last **1 000 events** across all tunnels. On disconnect and reconnect, new SSE clients receive the full buffered history immediately before live updates begin.

Events are never written to disk.
