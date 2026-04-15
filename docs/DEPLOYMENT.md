# Deployment

## Docker Compose (Quickstart)

```bash
cp .env.example .env
# edit .env with your domain and secrets

docker compose -f compose.yml up --build
```

This starts:
- `tt-server` on port 8080 (public) and 9000 (admin)
- `tt-expose` pointing at `fake-app` as a demo
- `fake-app` (traefik/whoami — echoes request headers and metadata)

## Production: Behind Nginx

### Nginx config

```nginx
# Wildcard DNS: *.tunnel.example.com → this server

server {
    listen 80;
    server_name *.tunnel.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name *.tunnel.example.com;

    ssl_certificate /etc/letsencrypt/live/tunnel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tunnel.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}

# Admin API — firewall to private network only
server {
    listen 9000;
    server_name tunnel-admin.internal;

    location / {
        proxy_pass http://localhost:9000;
    }
}
```

### tt serve flags for this setup

```bash
tt serve \
  --public-port 8080 \
  --public-domain tunnel.example.com \
  --public-https \
  --external-https-port 443 \
  --api-port 9000 \
  --trust-forward-headers \
  --tunnel-port-start 10000 \
  --tunnel-port-end 10200 \
  --hmac-secret "$TT_HMAC_SECRET"
```

## Production: Behind Traefik

```yaml
# traefik labels on tt-server container (Traefik v3 regex syntax)
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.tt.rule=HostRegexp(`^[a-z0-9-]+[.]tunnel\\.example\\.com$`)"
  - "traefik.http.routers.tt.entrypoints=websecure"
  - "traefik.http.routers.tt.tls.certresolver=letsencrypt"
  - "traefik.http.services.tt.loadbalancer.server.port=8080"
```

## systemd

```ini
[Unit]
Description=tt server
After=network.target

[Service]
Type=simple
User=thetubes
WorkingDirectory=/opt/tt
EnvironmentFile=/opt/tt/.env
ExecStart=/usr/local/bin/node /opt/tt/bin/tt.js serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Firewall

Only these ports need to be public:
- `--public-port` (80/443) — HTTP/HTTPS tunnel traffic
- Keep `--api-port` (9000) **private** (expose client → server, not internet-facing)
- `--tunnel-port-start` to `--tunnel-port-end` — expose client connections (private network only)

```bash
# UFW example
ufw allow 80/tcp
ufw allow 443/tcp
# 9000 and 10000-10200 should only be accessible from your expose clients
```

## DNS

You need a wildcard DNS record:

```
*.tunnel.example.com.  A  <server-ip>
```

For local testing with `/etc/hosts`:
```
127.0.0.1  fast-whale.tt.localhost
127.0.0.1  my-webhook.tt.localhost
```

Or use a wildcard resolver like `*.tt.localhost → 127.0.0.1` via dnsmasq.
