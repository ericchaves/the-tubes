# Security

## Threat Model

the tubes is a TCP reverse proxy. The public server forwards HTTP/WS traffic to local services through persistent TCP tunnels. The key trust boundaries are:

1. **Who can create a tunnel?** — anyone who can reach the admin API.
2. **Who can reclaim a subdomain?** — only the same session token (within the reconnect window).
3. **Can traffic be replayed?** — no, when HMAC is enabled.
4. **Can tunnels be hijacked?** — no, session token mismatch → 409.

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
kubectl create secret generic the tubes-hmac --from-literal=secret="$(openssl rand -hex 32)"

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

## Capture Files

Capture files may contain sensitive data (auth tokens, API keys in headers/bodies). They are:

- Stored locally on the expose machine
- Never sent to any third party by the tubes
- Excluded from `.gitignore` by default (`*.req.yaml`, `*.res.yaml` under captures/)

Be careful when sharing capture files. Redact sensitive headers before committing or sharing.

## Network Security

- Tunnel TCP connections are **plain TCP** — the tubes does not add encryption between expose client and server.
- For production: run the tunnel server behind HTTPS (Nginx/Traefik terminating TLS) and use `--public-https`.
- Local service connections: use `--local-tls` if the local service speaks HTTPS.
- The public server adds `X-TT-Source: server` to its own error responses (503, 404) so the expose client can skip capturing them.
