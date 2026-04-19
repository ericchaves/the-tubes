# tt expose

Exposes a local port through a running tt server. Maintains persistent connections and handles reconnects automatically.

## Usage

```bash
tt expose --local-port <port> --server-url <url> [options]
```

## Flags & Environment Variables

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--local-port` | `TT_LOCAL_PORT` | **required** | Local port to expose |
| `--local-address` | `TT_LOCAL_ADDRESS` | localhost | Local host/IP to forward to |
| `--local-tls` | `TT_LOCAL_TLS` | false | Local service speaks HTTPS |
| `--local-tls-cert` | `TT_LOCAL_TLS_CERT` | — | PEM certificate for local TLS |
| `--local-tls-key` | `TT_LOCAL_TLS_KEY` | — | PEM key for local TLS |
| `--local-tls-ca` | `TT_LOCAL_TLS_CA` | — | PEM CA for local TLS (self-signed) |
| `--allow-insecure-local-tls` | `TT_ALLOW_INSECURE_LOCAL_TLS` | false | Skip local cert validation (dev only) |
| `--rewrite-host-header` | `TT_REWRITE_HOST_HEADER` | true | Rewrite `Host:` to local address |
| `--server-url` | `TT_SERVER_URL` | **required** | URL of the tt server API |
| `--tunnel-subdomain` | `TT_TUNNEL_SUBDOMAIN` | random | Desired tunnel subdomain |
| `--session-token` | `TT_SESSION_TOKEN` | auto | Identity token (auto-generated and persisted) |
| `--ephemeral` | `TT_EPHEMERAL` | false | Generate a fresh token each run (no persistence) |
| `--session-token-file` | `TT_SESSION_TOKEN_FILE` | `~/.tt/session` | Path to session token file |
| `--hmac-secret` | `TT_HMAC_SECRET` | — | Shared HMAC secret (must match server) |
| `--open-browser` | `TT_OPEN_BROWSER` | false | Open the tunnel URL in a browser |
| `--log-requests` | `TT_LOG_REQUESTS` | false | Log each proxied request |
| `--capture-dir` | `TT_CAPTURE_DIR` | — | Directory to save request/response YAML captures |
| `--capture` | `TT_CAPTURE_ENABLED` | false | Start capture enabled (requires `--capture-dir`) |
| `--capture-max-body-kb` | `TT_CAPTURE_MAX_BODY_KB` | 1024 | Max body size in KB for captures |
| `--reconnect-local` / `--no-reconnect-local` | `TT_RECONNECT_LOCAL` | true | Retry connection when local service closes |
| `--reconnect-loop-window-s` | `TT_RECONNECT_LOOP_WINDOW_S` | 60 | Sliding window for failure detection (seconds) |
| `--reconnect-loop-max` | `TT_RECONNECT_LOOP_MAX` | 10 | Max failures in window before giving up |

## Session Token

The session token is your expose session's identity. It determines:

- Which tunnel subdomain you reclaim after a disconnect (within the reconnect window)
- Authentication with the server (anti-spoofing)

If you don't provide `--session-token`, the tubes reads from `~/.tt/session`. If it doesn't exist, a new token is generated and saved. Subsequent runs reuse it automatically.

Use `--ephemeral` to force a fresh random token for each run (useful in CI).

Use `tt session reset` to generate a new persistent token.

## Examples

### Basic

```bash
tt expose --local-port 3000 --server-url http://localhost:8080
```

### Named subdomain

```bash
tt expose \
  --local-port 3000 \
  --server-url http://tunnel.example.com \
  --tunnel-subdomain my-app
# Public URL: http://my-app.tunnel.example.com
```

### With HMAC authentication

```bash
export TT_HMAC_SECRET="same-secret-as-server"
tt expose --local-port 3000 --server-url http://tunnel.example.com
```

### Capture webhook traffic for replay

`--capture-dir` sets where files are saved; `--capture` enables capture at startup. Without `--capture`, the inspector is created but paused — you can turn it on later from the client admin dashboard.

```bash
# Start with capture enabled immediately
tt expose \
  --local-port 3000 \
  --server-url http://tunnel.example.com \
  --capture-dir ./captures \
  --capture \
  --tunnel-subdomain my-webhook

# Start with capture paused (toggle on from the admin dashboard)
tt expose \
  --local-port 3000 \
  --server-url http://tunnel.example.com \
  --capture-dir ./captures \
  --tunnel-subdomain my-webhook
```

After capturing, replay the traffic with:
```bash
tt replay --manifest ./flows/onboarding.yaml
```

### Local HTTPS service (self-signed)

```bash
tt expose \
  --local-port 3000 \
  --local-tls \
  --allow-insecure-local-tls \
  --server-url http://tunnel.example.com
```

### Ephemeral (CI / one-shot)

```bash
tt expose \
  --local-port 3000 \
  --server-url http://tunnel.example.com \
  --ephemeral
```

## Reconnect Behavior

When the local service closes or crashes, `tt expose` distinguishes between two situations:

### Local app temporarily down (ECONNREFUSED)

`ECONNREFUSED` means the port is not listening — the local app is not running yet, is still starting, or was restarted. This is treated as a **wait-and-retry** condition:

- The expose client retries with exponential backoff: 1 s → 2 s → 4 s → 8 s → 16 s → 30 s (cap).
- ECONNREFUSED does **not** consume the failure budget (`--reconnect-loop-max`). The client waits indefinitely for the app to come back.
- When the local app restarts, the next retry reconnects automatically and a "local service reconnected" message is printed.
- A yellow warning is printed when unreachability is first detected.

### Local app connection dropped (ECONNRESET / clean close)

When a previously-established connection to the local app is dropped (e.g., the app crashed mid-request, or the container was killed):

- The failure **is** recorded against the reconnect budget.
- Retries use exponential backoff; `--reconnect-loop-max` failures within `--reconnect-loop-window-s` seconds triggers `reconnect_loop_detected` and exits.
- Each crash event counts **once** toward the budget — not twice — even though Node.js fires both `'error'` and `'close'` on the same socket.

### `--no-reconnect-local`

`tt expose` exits immediately on the first local connection failure, regardless of the error type.

### Summary

| Condition | Retriable | Counts toward budget | Default action |
|---|---|---|---|
| `ECONNREFUSED` (app down) | ✅ Yes | ❌ No | Wait with backoff |
| `ECONNRESET` / error drop | ✅ Yes | ✅ Yes | Retry; exit after N failures |
| Clean close (graceful) | ✅ Yes | ❌ No | Reconnect immediately |
| `--no-reconnect-local` | ❌ No | — | Exit on first failure |
