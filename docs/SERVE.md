# tt serve

Runs the tunnel server that accepts expose sessions and forwards public traffic.

## Usage

```bash
tt serve [options]
```

## Flags & Environment Variables

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--public-port` | `TT_PUBLIC_PORT` | 80 | Port for public HTTP/WS traffic |
| `--public-address` | `TT_PUBLIC_ADDRESS` | 0.0.0.0 | Bind address for public server |
| `--public-domain` | `TT_PUBLIC_DOMAIN` | — | Base domain; tunnels become `<id>.<domain>` |
| `--public-https` | `TT_PUBLIC_HTTPS` | false | Use `https://` scheme in generated URLs |
| `--external-http-port` | `TT_EXTERNAL_HTTP_PORT` | = public-port | Override port in publicUrl (reverse proxy) |
| `--external-https-port` | `TT_EXTERNAL_HTTPS_PORT` | = public-port | Override HTTPS port in publicUrl |
| `--landing-url` | `TT_LANDING_URL` | — | Redirect `GET /` to this URL |
| `--api-port` | `TT_API_PORT` | = public-port | Separate port for `/api/*` and admin routes. `/healthz` is also available on the public port (for load balancer probes). |
| `--api-address` | `TT_API_ADDRESS` | 0.0.0.0 | Bind address for API server |
| `--tunnel-port-start` | `TT_TUNNEL_PORT_START` | — | Start of TCP port range for tunnel connections |
| `--tunnel-port-end` | `TT_TUNNEL_PORT_END` | — | End of TCP port range |
| `--max-connections-per-tunnel` | `TT_MAX_CONNECTIONS_PER_TUNNEL` | 10 | Concurrent connections per expose session |
| `--reconnect-window-ms` | `TT_RECONNECT_WINDOW_MS` | 30000 | How long to hold a tunnel reservation after disconnect (ms) |
| `--trust-forward-headers` | `TT_TRUST_FORWARD_HEADERS` | false | Use `X-Forwarded-For` for client IP in logs |
| `--http-wait-timeout-ms` | `TT_HTTP_WAIT_TIMEOUT_MS` | 5000 | Timeout waiting for a tunnel socket for HTTP |
| `--websocket-wait-timeout-ms` | `TT_WEBSOCKET_WAIT_TIMEOUT_MS` | 10000 | Timeout waiting for a tunnel socket for WebSocket |
| `--retry-after-seconds` | `TT_RETRY_AFTER_SECONDS` | 5 | `Retry-After` header value in 503 responses |
| `--hmac-secret` | `TT_HMAC_SECRET` | — | Shared HMAC secret (≥32 chars). Enables auth. |
| `--hmac-secret-file` | `TT_HMAC_SECRET_FILE` | — | Read HMAC secret from file (Docker secrets) |
| `--hmac-clock-skew-tolerance-s` | `TT_HMAC_CLOCK_SKEW_TOLERANCE_S` | 60 | Clock skew tolerance in seconds |

## Examples

### Basic — localhost testing

```bash
tt serve --public-port 8080
# POST http://localhost:8080/api/tunnels to create tunnels
```

### With domain (requires DNS/hosts wildcard)

```bash
tt serve \
  --public-port 80 \
  --public-domain tunnel.example.com
# Tunnel URLs: http://fast-whale.tunnel.example.com
```

### With HMAC authentication

```bash
export TT_HMAC_SECRET="$(openssl rand -hex 32)"
tt serve --public-port 8080
# expose clients must also set TT_HMAC_SECRET to the same value
```

### Separate API port (firewall isolation)

```bash
tt serve \
  --public-port 80 \
  --api-port 9000 \
  --public-domain tunnel.example.com
# Public traffic: :80 (no /api/* access)
# Tunnel management: :9000 (firewall to private network)
```

### Port range for tunnels

```bash
tt serve \
  --public-port 8080 \
  --tunnel-port-start 10000 \
  --tunnel-port-end 10099
# At most 100 simultaneous expose sessions
```

### Behind Nginx/Traefik

```bash
tt serve \
  --public-port 8080 \
  --public-domain tunnel.example.com \
  --public-https \
  --external-https-port 443 \
  --trust-forward-headers
```

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full reverse proxy configuration.

## Admin Dashboard

The server exposes a real-time dashboard at `/admin` (and `/tubes/:tunnelId` for per-tunnel detail). It shows active tunnels, server configuration, and a live event stream of every request, response, and lifecycle event.

```bash
# Dashboard on the default port
tt serve --public-port 8080
# → http://localhost:8080/tubes

# Dashboard on a separate, firewall-restricted port
tt serve --public-port 80 --api-port 9000
# → http://localhost:9000/tubes
```

The dashboard has no built-in authentication — restrict access at the firewall or proxy layer. Use `--api-address 127.0.0.1` to bind the dashboard to loopback only.

See [ADMIN-DASHBOARD.md](./ADMIN-DASHBOARD.md) for the full reference including event types, failure scenario patterns, and security guidance.
