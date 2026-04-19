# the tubes
![The Tubes](./logo.png)
Expose local services to the world. Unified tunnel server, client, and webhook replay — single binary, zero runtime dependencies, Node.js 25+.

> **Intended use:** This project is designed to assist developers during development and testing in staging environments. It is not intended for production use or for exposing sensitive applications and data.

## Quickstart

```sh
# Start a tunnel server
node bin/tt.js serve --public-port 8000 --public-domain tt.localhost

# Expose a local service through it
node bin/tt.js expose --local-port 3000 --server-url http://localhost:8000
# → publicUrl: http://abc123.tt.localhost:8000

# Admin dashboard (real-time traffic + tunnel status)
# → http://localhost:8000/tubes

# Replay captured webhook requests
node bin/tt.js replay --manifest ./flows/onboarding.yaml --target-url http://localhost:3000/webhook
```

## Install

```sh
node --version   # requires >=25.0.0 (use nvm: nvm use)
pnpm install
```

## Commands

| Command | Description |
|---|---|
| `tt serve` | Run a tunnel server |
| `tt expose` | Expose a local port via a tunnel server |
| `tt replay` | Replay captured HTTP requests against a local webhook |
| `tt session reset` | Remove the persisted session token |

Use `tt <command> --help` for full flag reference.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Protocol the-tubes/1.0](docs/PROTOCOL.md)
- [serve reference](docs/SERVE.md)
- [expose reference](docs/EXPOSE.md)
- [replay & capture reference](docs/REPLAY.md)
- [Admin dashboard](docs/ADMIN-DASHBOARD.md)
- [Security](docs/SECURITY.md)
- [Deployment (Docker, Traefik, systemd)](docs/DEPLOYMENT.md)
- [Deployment with Traefik + Let's Encrypt (production)](docs/DEPLOYMENT-TRAEFIK.md)
- [Testing](docs/TESTING.md)
- [Migrating from localtunnel](docs/MIGRATION-FROM-LOCALTUNNEL.md)

## Development

```sh
task test          # unit + integration (fast feedback, default CI gate)
task test:unit
task test:integration
task test:regression
task test:all      # all suites — run before releases
task lint          # node --check on all JS files
task docker:up     # server + expose + whoami demo app via compose
```
