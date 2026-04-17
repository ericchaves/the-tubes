# Security

## Threat Model

the tubes is a TCP reverse proxy. The public server forwards HTTP/WS traffic to local services through persistent TCP tunnels. The key trust boundaries are:

1. **Who can create a tunnel?** — only clients that can reach the admin API (restricted by firewall/Security Group) and, optionally, that possess the HMAC secret.
2. **Who can reclaim a subdomain?** — only the same session token (within the reconnect window).
3. **Can traffic be replayed?** — no, when HMAC is enabled.
4. **Can tunnels be hijacked?** — no, session token mismatch → 409.
5. **Can an attacker enumerate tunnel IDs?** — impractical: each ID is `adjective-noun-xxxxxx` with a 6-char random hex suffix (~26 billion combinations).

---

## Session Tokens

Every expose session must provide an `X-TT-Session-Token`. This token:

- Is the **sole identity** for the session. IP addresses are never used for identity.
- Must be `[a-zA-Z0-9_-]{1,256}`.
- Should be at least 128 bits of entropy (the auto-generated token is 128 bits / 32 hex chars).
- Is stored in `~/.tt/session` (chmod 600) on the expose client.
- Is **never logged in full** — only the first 8 characters appear in debug output.

The token grants the ability to:
- Create a tunnel
- Reclaim the same tunnel ID within the reconnect window

A token does NOT grant access to: the traffic of other sessions, admin operations, or subdomain hijacking.

---

## HMAC Authentication

When `--hmac-secret` is set on the server, all tunnel creation requests must include a valid `X-TT-Auth` header.

### How it works

```
sig = HMAC-SHA256(secret, METHOD + "\n" + PATH + "\n" + TS + "\n" + NONCE + "\n" + BODY_SHA256_HEX)
X-TT-Auth: base64(JSON{ "ts": <epoch_ms>, "nonce": "<random>", "sig": "<hex>" })
```

The server verifies:
1. **Signature** — timing-safe compare (prevents timing oracle attacks)
2. **Timestamp** — must be within `±clockSkewToleranceS` seconds (default 60)
3. **Nonce** — must not have been seen before (TTL = `clockSkewToleranceS × 4`)

### When to use HMAC

- Any public-facing tt server
- Production deployments where you want to restrict who can open tunnels

### Secret management

Prefer `--hmac-secret-file` in Docker/Kubernetes environments:

```bash
# In Kubernetes:
kubectl create secret generic the-tubes-hmac --from-literal=secret="$(openssl rand -hex 32)"

# In docker-compose:
secrets:
  hmac_secret:
    file: ./secrets/hmac.txt
```

Set `TT_HMAC_SECRET_FILE` to the file path. the tubes reads it at startup.

### Secret requirements

- Minimum 32 characters
- Use `openssl rand -hex 32` or similar to generate
- Never commit secrets to version control

---

## Admin Dashboard Token

The admin dashboard (`/tubes`) is protected by a token. Three authentication methods are accepted:

- `X-TT-Admin-Token: <token>` header (API clients, curl)
- `Authorization: Bearer <token>` header
- `Authorization: Basic <base64(user:token)>` — username is ignored; password must equal the token. Triggers the browser's native login dialog when accessing `/tubes` directly.

### Auto-generation

If `TT_ADMIN_TOKEN` is not set, the server auto-generates a 64-char hex token on first start and saves it to `~/.tt/admin-token`. On subsequent starts the file is re-read. The token is printed to stdout once on first generation.

### Manual provisioning

```bash
# Generate a strong token
openssl rand -hex 32

# Set in docker-compose / .env
TT_ADMIN_TOKEN=<generated-value>
```

### Token rotation

From the dashboard (`/tubes` → Configuration section → 🔄 button), the token can be rotated at runtime without restarting the server. The new token is saved to disk immediately.

---

## Rate Limiting

Requests to unregistered tunnel subdomains (IPs scanning for active tunnels) are rate-limited at two independent layers:

### Layer 1 — Traefik (network level)

Configured via Traefik middleware labels in `compose.prod.yml` and the CloudFormation template:

| Parameter | Default |
|---|---|
| Average rate | 100 req/min per IP |
| Burst | 50 requests |
| Window | 1 minute |

Applies to all wildcard subdomain traffic (`*.tt.example.com`).

### Layer 2 — In-process (application level)

The `RateLimiter` module runs inside the tt server process and provides a second line of defense, with tighter limits aimed at probe/scan traffic:

| Parameter | Env var | Default |
|---|---|---|
| Window | `TT_RATE_LIMIT_WINDOW_MS` | 60 000 ms |
| Max hits | `TT_RATE_LIMIT_MAX_HITS` | 30 |
| Block duration | `TT_RATE_LIMIT_BLOCK_DURATION_MS` | 300 000 ms (5 min) |

When an IP exceeds `maxHits` tunnel-not-found probes within the window it is temporarily blocked (HTTP 429 / WS 429). Blocked IPs are visible in the admin dashboard and can be manually unblocked.

---

## IP Blocklist

The server maintains a **permanent blocklist** stored in `~/.tt/blocklist.json`. IPs on this list are rejected before any tunnel lookup (HTTP 403 / WS 403).

### Managing the blocklist

Via the admin dashboard at `/tubes/blocklist`:

- View temporarily blocked IPs (rate limiter) and permanently blocked IPs
- Add an IP to the permanent blocklist
- Remove an IP from either list

Via the REST API:

```bash
# List permanent blocklist
curl -H "X-TT-Admin-Token: $TOKEN" http://localhost:9000/api/blocklist/permanent

# Block an IP permanently
curl -X POST -H "X-TT-Admin-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ip":"1.2.3.4"}' \
  http://localhost:9000/api/blocklist/permanent

# Remove from permanent blocklist
curl -X DELETE -H "X-TT-Admin-Token: $TOKEN" \
  http://localhost:9000/api/blocklist/permanent/1.2.3.4

# Unblock a temporarily blocked IP
curl -X DELETE -H "X-TT-Admin-Token: $TOKEN" \
  http://localhost:9000/api/blocklist/temp/1.2.3.4
```

### IPv6 normalization

All IP addresses are normalized before being stored or checked:
- IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is canonicalized to `1.2.3.4`
- Zone IDs (`fe80::1%eth0`) are stripped
- Bracket notation (`[::1]`) is stripped

---

## Tunnel ID Space

Tunnel IDs follow the format `adjective-noun-xxxxxx` where `xxxxxx` is 6 hex characters drawn from `crypto.randomBytes`. This gives approximately **26 billion** unique combinations, making enumeration attacks impractical.

Previous versions used `adjective-noun` (about 1 600 combinations), which was trivially enumerable.

---

## Capture Files

Capture files may contain sensitive data (auth tokens, API keys in headers/bodies). They are:

- Stored locally on the expose machine
- Never sent to any third party by the tubes
- Excluded from `.gitignore` by default (`*.req.yaml`, `*.res.yaml` under captures/)

Be careful when sharing capture files. Redact sensitive headers before committing or sharing.

---

## Network Security

- Tunnel TCP connections are **plain TCP** — the tubes does not add encryption between expose client and server.
- For production: run the tunnel server behind HTTPS (Nginx/Traefik terminating TLS) and use `--public-https`.
- Local service connections: use `--local-tls` if the local service speaks HTTPS.
- The public server adds `X-TT-Source: server` to its own error responses (503, 404) so the expose client can skip capturing them.
- Ports 80 and 443 accept both IPv4 and IPv6 traffic in the CloudFormation and compose.prod.yml configurations. Restrict other ports (admin API, dashboard, tunnel TCP range) to known client IP ranges.
