# Deployment with Traefik + Let's Encrypt

This guide covers running tt server in production with Traefik as a reverse proxy, using Let's Encrypt for wildcard TLS certificates via DNS challenge.

## Architecture

```
Internet
   │
   ├── :80  (HTTP)   ─── Traefik ──► https-redirect middleware
   ├── :443 (HTTPS)  ─── Traefik ──► the tubes public server (:3000)
   └── :9000 (admin) ─── Traefik ──► the tubes API server (:9000)

DNS:
  tunnel.example.com      → server IP   (admin API)
  *.tunnel.example.com    → server IP   (public tunnels)
```

The tunnel TCP port range (e.g. 10000–10100) is exposed directly — not via Traefik — because expose clients open raw TCP connections to it.

## Prerequisites

- A domain with wildcard DNS support (`tunnel.example.com` and `*.tunnel.example.com` → server IP)
- A DNS provider supported by Traefik's ACME DNS challenge (see [Traefik ACME providers](https://doc.traefik.io/traefik/https/acme/#providers))
- Docker + Docker Compose on the server
- Firewall rules (see below)

## Setup

### 1. Create the environment file

The `compose.prod.yml` file ships in the repository with no sensitive values — all secrets and site-specific settings are read from environment variables at startup. Compose will refuse to start and print a clear error message if any required variable is missing.

Create `.env.prod` on the server (never commit this file):

```dotenv
# ── Required ────────────────────────────────────────────────────────────────

# Base domain for tunnels — wildcard cert *.DOMAIN will be issued
TT_PUBLIC_DOMAIN=tunnel.example.com

# Shared HMAC secret — must match on server and all expose clients
# Generate: openssl rand -hex 32
TT_HMAC_SECRET=<64-char-hex>

# Let's Encrypt — expiry notification address
ACME_EMAIL=ops@example.com

# DNS challenge credentials (Route 53 — change for other providers, see below)
AWS_HOSTED_ZONE_ID=<zone-id>
AWS_REGION=<region>

# ── Optional ─────────────────────────────────────────────────────────────────

# Image coordinates — defaults shown
# REGISTRY=ghcr.io
# ORG=ericchaves
# TAG=latest
```

### 2. Publish the image

```bash
# From your development machine
task docker:publish tag=1.0.0
# defaults: REGISTRY=ghcr.io, ORG=ericchaves, TAG=latest

# Override registry or org if needed
task docker:publish tag=1.0.0 registry=docker.io ORG=myorg
```

### 3. Start the stack

```bash
docker compose -f compose.prod.yml --env-file .env.prod up -d
```

If a required variable is missing, Compose exits immediately with an error identifying which variable needs to be set.

### 4. Verify

```bash
# Health check — admin entrypoint is :9000, not :443
curl https://tunnel.example.com:9000/healthz

# Create a test tunnel (from any machine with the same HMAC secret)
tt expose \
  --local-port 3000 \
  --server-url https://tunnel.example.com:9000 \
  --hmac-secret <your-secret>
```

## Environment Variable Reference

### Required

| Variable | Description |
|----------|-------------|
| `TT_PUBLIC_DOMAIN` | Base domain. Tunnels become `<id>.DOMAIN`. Wildcard cert covers `*.DOMAIN`. |
| `TT_HMAC_SECRET` | Shared HMAC secret, min 32 chars. Generate: `openssl rand -hex 32` |
| `ACME_EMAIL` | Email for Let's Encrypt expiry notifications |
| `AWS_HOSTED_ZONE_ID` | Route 53 hosted zone ID (replace with provider-specific vars if not using Route 53) |
| `AWS_REGION` | AWS region of the hosted zone |

### Optional (defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `REGISTRY` | `ghcr.io` | Container registry |
| `ORG` | `ericchaves` | Registry organisation/user |
| `TAG` | `latest` | Image tag to deploy |

All tt server variables are documented in [SERVE.md](./SERVE.md).

## Firewall Rules

Only these ports should be reachable from the public internet:

| Port | Access | Purpose |
|------|--------|---------|
| 80 | public | HTTP → HTTPS redirect |
| 443 | public | HTTPS tunnel traffic |
| 9000 | **private** | the tubes admin API — expose clients only |
| 8080 | **private** | Traefik dashboard |
| 10000–10100 | **private** | Tunnel TCP connections — expose clients only |

The admin API (`:9000`) must be reachable from expose clients but not from the open internet. Restrict it at the firewall or VPC security group level.

Example with `ufw`:

```bash
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow from <expose-client-cidr> to any port 9000
ufw allow from <expose-client-cidr> to any port 10000:10100 proto tcp
```

## Changing the DNS Provider

`compose.prod.yml` uses AWS Route 53 by default. To switch providers:

1. Replace `route53` with your provider's name in the `traefik` command block.
2. Replace `AWS_HOSTED_ZONE_ID` / `AWS_REGION` with the variables required by that provider.
3. Update your `.env.prod` accordingly.

Example for Cloudflare:

```yaml
# In compose.prod.yml — traefik command block:
- "--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare"

# In traefik environment block:
CF_API_TOKEN: "${CF_API_TOKEN:?CF_API_TOKEN is required}"
```

```dotenv
# In .env.prod:
CF_API_TOKEN=<your-cloudflare-api-token>
```

Full provider list: https://doc.traefik.io/traefik/https/acme/#providers

## Updating the tubes

```bash
# Pull new image and restart only the the tubes container
docker compose -f compose.prod.yml --env-file .env.prod pull the-tubes
docker compose -f compose.prod.yml --env-file .env.prod up -d the-tubes
```

Traefik does not need to restart for the tubes updates.

## Migration from localtunnel

If replacing a `localtunnel-server` deployment, see [MIGRATION-FROM-LOCALTUNNEL.md](./MIGRATION-FROM-LOCALTUNNEL.md) for the full variable mapping.

Key differences relevant to this compose:

| Old (`LT_*`) | New (`TT_*`) | Notes |
|---|---|---|
| `LT_PORT=3000` | `TT_PUBLIC_PORT=3000` | Unchanged |
| `LT_ADMIN_PORT=9000` | `TT_API_PORT=9000` | Unchanged |
| `LT_GRACE_PERIOD=180000` | `TT_RECONNECT_WINDOW_MS=180000` | Unchanged |
| `LT_MAX_GRACE_PERIOD=300000` | (removed) | Hardcoded cap: 300 000 ms |
| `LT_IP_VALIDATION_STRICT=true` | (removed) | Identity is always by session token |
| `LT_TRUST_PROXY=true` | `TT_TRUST_FORWARD_HEADERS=true` | Same effect |
| `LT_HMAC_NONCE_THRESHOLD=3600` | (derived) | = `TT_HMAC_CLOCK_SKEW_TOLERANCE_S` × 2 |
| `LT_HMAC_NONCE_CACHE_TTL=7200` | (derived) | = `TT_HMAC_CLOCK_SKEW_TOLERANCE_S` × 4 |
| `LT_NONCE_CLEANUP_INTERVAL` | (internal) | Not configurable |
| `LT_SOCKET_CHECK_INTERVAL` | (internal) | Not configurable |
| `DEBUG=localtunnel*` | `NODE_DEBUG=tt:*` | Same pattern |
