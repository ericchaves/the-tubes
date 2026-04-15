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

After receiving this, the expose process opens `maxConnections` raw TCP connections to `tunnelHost:tunnelPort`. These raw sockets are held in the server's socket pool and used to forward HTTP/WS traffic.

### Error Responses

| Status | Condition |
|--------|-----------|
| 400 | Missing or malformed `X-TT-Session-Token` |
| 401 | HMAC authentication failed |
| 403 | Invalid subdomain format |
| 409 | Subdomain reserved by a different session (within reconnect window) |
| 503 | No ports available in range |

## Public Tunnel Proxy Responses

When a request arrives on the public server and is routed to an active tunnel, the server may return these responses directly (not from the local service):

| Status | Condition | Notable Headers |
|--------|-----------|-----------------|
| 429 | Tunnel connection pool exhausted — all sockets are in use and the wait timeout expired | `X-TT-Max-Connections`, `X-TT-Current-Connections`, `X-TT-Available-Connections`, `X-TT-Waiting-Requests` |
| 503 | No tunnel socket became available within the wait timeout | `Retry-After` |
| 404 | No active tunnel for the requested subdomain | — |

These responses include `X-TT-Source: server` and `X-TT-Proto: the-tubes/1.0`. Expose clients skip capturing them.

## Reconnect Window

When the expose process disconnects, the server holds the tunnel reservation for `reconnectWindowMs`. If the same `sessionToken` reconnects within that window, it reclaims the same `tunnelId`. A different token gets a 409.

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
    { "tunnelId": "fast-whale", "connected": true, "port": 10042, "createdAt": "...", "availableConnections": 8 }
  ]
}
```

### `GET /api/tunnels/:id` — never requires auth

Returns the same shape as the tunnel creation response (current state).

## Response Headers

All responses include `X-TT-Proto: the-tubes/1.0`. Server-generated error responses (503, 404 for unknown tunnels) also include `X-TT-Source: server` — the expose client skips capturing these.

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
