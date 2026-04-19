# the-tubes/1.0 Protocol

## Tunnel Creation

```
POST /api/tunnels           → random subdomain
POST /api/tunnels/:subdomain → specific subdomain
```

### Required Headers

| Header | Value | Notes |
|--------|-------|-------|
| `X-TT-Session-Token` | `[a-zA-Z0-9_-]{1,256}` | Always required |
| `X-TT-Auth` | base64(JSON) | Required when server has HMAC enabled |

### HMAC Authentication (`X-TT-Auth`)

The auth header is a base64-encoded JSON object:

```json
{ "ts": 1713192123412, "nonce": "abc123def456...", "sig": "sha256hex..." }
```

The signature covers:
```
METHOD\nPATH\nTS\nNONCE\nBODY_SHA256_HEX
```

Where `BODY_SHA256_HEX` is the SHA-256 hex digest of the request body (or the SHA-256 of an empty string if no body).

The server verifies:
- Signature validity (timing-safe compare)
- Timestamp within `±clockSkewToleranceS` seconds
- Nonce not seen before (anti-replay, TTL = `clockSkewToleranceS × 4`)

### Success Response (200)

```json
{
  "protocol": "the-tubes/1.0",
  "tunnelId": "fast-whale",
  "tunnelHost": "tunnel.example.com",
  "tunnelPort": 10042,
  "publicUrl": "https://fast-whale.tunnel.example.com",
  "maxConnections": 10,
  "reconnectWindowMs": 30000,
  "createdAt": "2026-04-15T14:22:03.412Z"
}
```

After receiving this, the expose process opens a WebSocket control channel (see below) and waits for the server to instruct it to open data sockets on demand.

### Error Responses

| Status | Condition |
|--------|-----------|
| 400 | Missing or malformed `X-TT-Session-Token` |
| 401 | HMAC authentication failed |
| 403 | Invalid subdomain format |
| 409 | Subdomain reserved by a different session (within reconnect window) |
| 503 | No ports available in range |

---

## WebSocket Control Channel

After tunnel creation, the expose process opens a persistent WebSocket connection:

```
GET /api/tunnels/:id/control
Upgrade: websocket
X-TT-Session-Token: <token>
```

This channel carries all pair lifecycle messages for the duration of the session.

### Message format

All messages are JSON frames:

```json
{ "type": "<type>", ...fields }
```

### Server → Client messages

| Type | Fields | Description |
|------|--------|-------------|
| `hello.ack` | `tunnelId, keep[], drop[]` | Sent after the client's `hello`. `keep` lists inflight pairs to reattach; `drop` lists pairs to abandon. |
| `pair.open` | `pairId, requestId, kind, method, path, remoteAddr` | Instructs the client to open a data socket for a pending request. |
| `pair.close` | `pairId, reason` | Server is closing the pair (e.g. request timeout, tunnel destroyed). |
| `ping` | — | Heartbeat; client must respond with `pong`. |

### Client → Server messages

| Type | Fields | Description |
|------|--------|-------------|
| `hello` | `controlId, resumeControlId?, inflightPairs[]` | Sent once on connect. `resumeControlId` identifies the previous session during a reconnect. |
| `pair.failed` | `pairId, reason` | Local service refused or failed to connect. Server returns 502/503 to the external client. |
| `pair.closed` | `pairId, reason, bytesIn, bytesOut, durationMs` | Pair completed normally. Used for accounting and dashboard events. |
| `pong` | — | Heartbeat response. |

---

## Data Socket

For each `pair.open` received, the expose client:

1. Connects to `tunnelHost:tunnelPort` (raw TCP, `allowHalfOpen: true`).
2. Writes the preamble as the first bytes: `TT/1 PAIR <pairId>\r\n`
   - During WS reconnect: `TT/1 PAIR <pairId> REPLACES <previousControlId>\r\n`
3. The server matches the preamble to the pending request and begins bidirectional proxying.

If the local service is unreachable (`ECONNREFUSED`), the client sends `pair.failed` instead of opening a data socket.

`maxConnections` limits the number of concurrent pairs. The server rejects new `pair.open` requests with `EMAXCONN` once this limit is reached.

---

## Public Tunnel Proxy Responses

When a request arrives on the public server for an active tunnel, the server may return these responses directly:

| Status | Condition | Notable Headers |
|--------|-----------|-----------------|
| 503 | Expose client not connected (no control channel) | `Retry-After` |
| 503 | Max concurrent pairs reached | `Retry-After` |
| 503 | Data socket not received within timeout | `Retry-After` |
| 429 | IP rate-limited (too many requests to unknown tunnels) | — |
| 404 | No active tunnel for the requested subdomain | — |

These responses include `X-TT-Source: server` and `X-TT-Proto: the-tubes/1.0`. Expose clients skip capturing them.

---

## Reconnect Window

When the expose process disconnects, the server holds the tunnel reservation for `reconnectWindowMs`. If the same `sessionToken` reconnects within that window, it reclaims the same `tunnelId`. Inflight pairs with active external connections are preserved and reattached via `hello.ack keep[]`. A different token gets a 409.

---

## Other Endpoints

### `GET /healthz` — never requires auth

```json
{ "status": "ok", "uptime": 42, "tunnels": 3 }
```

### `GET /api/status` — never requires auth

```json
{
  "protocol": "the-tubes/1.0",
  "uptime": 42,
  "tunnels": [
    { "tunnelId": "fast-whale", "connected": true, "port": 10042, "createdAt": "...", "pairsActive": 2 }
  ]
}
```

### `GET /api/tunnels/:id` — never requires auth

Returns the same shape as the tunnel creation response (current state).

---

## Response Headers

All responses include `X-TT-Proto: the-tubes/1.0`. Server-generated error responses (503, 404 for unknown tunnels) also include `X-TT-Source: server` — the expose client skips capturing these.

---

## curl Examples

```bash
# Create tunnel (no HMAC)
curl -s -X POST http://localhost:8080/api/tunnels \
  -H 'X-TT-Session-Token: my-dev-token'

# Create named tunnel
curl -s -X POST http://localhost:8080/api/tunnels/my-webhook \
  -H 'X-TT-Session-Token: my-dev-token'

# Health check
curl -s http://localhost:8080/healthz

# Status
curl -s http://localhost:8080/api/status | jq .
```
