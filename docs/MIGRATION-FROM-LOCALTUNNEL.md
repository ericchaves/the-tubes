# Migration from LocalTunnel

the tubes is a complete replacement for the custom `localtunnel-server` and `localtunnel-client` forks. There is no protocol compatibility — both server and client must be updated together.

## Command Mapping

| Old | New |
|-----|-----|
| `lt --port 3000 --host http://server` | `tt expose --local-port 3000 --server-url http://server` |
| Start server | `tt serve` |
| `replay/replay.js` | `tt replay --manifest flows/onboarding.yaml` |

## Subcommand Names

| Old | New |
|-----|-----|
| `lt` (client binary) | `tt expose` |
| `server.js` | `tt serve` |
| `replay/replay.js` | `tt replay` |

No aliases: `tt server` and `the tubes client` do not exist.

## Flag Mapping — Expose (client)

| Old flag | New flag |
|----------|----------|
| `--port` | `--local-port` |
| `--host` | `--server-url` |
| `--subdomain` | `--tunnel-subdomain` |
| `--local-host` | `--local-address` |
| `--local-https` | `--local-tls` |
| `--local-cert` | `--local-tls-cert` |
| `--local-key` | `--local-tls-key` |
| `--local-ca` | `--local-tls-ca` |
| `--allow-invalid-cert` | `--allow-insecure-local-tls` |
| `--open` | `--open-browser` |
| `--print-requests` | `--log-requests` |
| `--dump-dir` | `--capture-dir` |
| (n/a) | `--reconnect-local` / `--no-reconnect-local` |

## Flag Mapping — Serve (server)

| Old flag/env | New flag | New env |
|--------------|----------|---------|
| `--port` | `--public-port` | `TT_PUBLIC_PORT` |
| `--address` | `--public-address` | `TT_PUBLIC_ADDRESS` |
| `--domain` | `--public-domain` | `TT_PUBLIC_DOMAIN` |
| `--secure` | `--public-https` | `TT_PUBLIC_HTTPS` |
| `--apiPort` / `--api-port` | `--api-port` | `TT_API_PORT` |
| `--max-sockets` | `--max-connections-per-tunnel` | `TT_MAX_CONNECTIONS_PER_TUNNEL` |
| `--hmac-secret` | `--hmac-secret` | `TT_HMAC_SECRET` |
| (n/a) | `--tunnel-port-start` / `--tunnel-port-end` | `TT_TUNNEL_PORT_START` / `TT_TUNNEL_PORT_END` |

## Environment Variable Mapping

| Old (`LT_*`) | New (`TT_*`) |
|--------------|--------------|
| `LT_HMAC_SECRET` | `TT_HMAC_SECRET` |
| `LT_SERVER_URL` | `TT_SERVER_URL` |
| `LT_LOCAL_PORT` | `TT_LOCAL_PORT` |
| `LT_SUBDOMAIN` | `TT_TUNNEL_SUBDOMAIN` |
| `LT_PUBLIC_PORT` | `TT_PUBLIC_PORT` |
| `LT_PUBLIC_DOMAIN` | `TT_PUBLIC_DOMAIN` |

All `LT_*` variables are **not supported**. Rename them in your `.env` files.

## Removed Features

| Feature | Reason |
|---------|--------|
| IP-based session identity | Replaced by `sessionToken` (stable across IP changes, CGNAT-safe) |
| `--allow-silent-fallback` | Removed — identity check is always strict |
| `--require-matching-identity` flag | Always required now, not a flag |
| `--log-level` | Use `NODE_DEBUG=tt:*` instead |
| `--reconnect-window-max-ms` | Upper bound hardcoded (5 minutes) |
| `--hmac-nonce-max-age-s` | Derived from `--hmac-clock-skew-tolerance-s` × 2 |
| `--hmac-nonce-cache-ttl-s` | Derived from `--hmac-clock-skew-tolerance-s` × 4 |
| `--tunnel-poll-interval-ms` | Hardcoded 100ms |
| `--local-retry-max` | Superseded by `--reconnect-loop-max` |
| `cached_url` in response | Unused field removed |
| `webhook` field in replay manifest | Still supported as a legacy alias for `target` |
| `sources` field in replay manifest | Still supported as a legacy alias for `steps` |

## Replay Manifest Migration

Old format (still supported):
```yaml
webhook: http://localhost:3000
sources:
  - request: ./captures/capture1.yaml
    idle: 100
```

New format:
```yaml
target: http://localhost:3000
steps:
  - capture: ./captures/capture1.req.yaml
    idleMs: 100
```

Both formats work. The new format is preferred.

## Protocol Breaking Changes

The wire protocol changed completely (`the-tubes/1.0` vs `localtunnel/1`):
- `X-TT-Session-Token` (new, required) vs `X-LT-Client-ID` (old)
- `X-TT-Auth` HMAC format changed
- Response JSON keys renamed (camelCase, new fields)
- `X-TT-Source` / `X-TT-Proto` response headers (new)

You cannot mix old localtunnel clients with tt server or vice versa.
