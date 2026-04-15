# the tubes — Architecture

## Overview

the tubes is a single Node.js CLI (`the tubes`) with three subcommands:

- `serve` — runs the tunnel server
- `expose` — exposes a local port through a running server
- `replay` — replays captured HTTP requests against a target

Zero runtime dependencies. All networking uses `node:http`, `node:net`, `node:tls`.

## Layer Diagram

```
┌──────────────────────────────────────────────────┐
│  bin/tt.js   ← entry, dispatch by command │
└────────────┬─────────────────┬───────────────────┘
             │                 │
     ┌───────▼──────┐  ┌───────▼──────┐  ┌───────────────┐
     │  src/cli.js  │  │ src/config.js│  │ src/debug.js  │
     └──────────────┘  └──────────────┘  └───────────────┘
             │
    ┌────────┴──────────────────────────┐
    │               │                  │
┌───▼────┐   ┌──────▼──────┐   ┌──────▼──────┐
│ serve  │   │   expose    │   │   replay    │
└───┬────┘   └──────┬──────┘   └──────┬──────┘
    │               │                  │
    │          ┌────┴─────────────┐    │
    │          │  common/         │    │
    │          │  hmac.js         │    │
    │          │  nonce-cache.js  │    │
    │          │  id-generator.js │    │
    │          │  yaml-lite.js    │    │
    │          │  session-file.js │    │
    │          │  secret-loader.js│    │
    │          │  errors.js       │    │
    │          │  http-utils.js   │    │
    │          └──────────────────┘    │
    │                                  │
┌───▼───────────────────┐   ┌──────────▼──────────┐
│  server/              │   │  replay/             │
│  tunnel-manager.js    │   │  manifest.js         │
│  tunnel.js            │   │  runner.js           │
│  tunnel-agent.js      │   └─────────────────────┘
│  router.js            │
│  hmac-middleware.js   │
│  api-server.js        │
└───────────────────────┘

┌──────────────────────────┐
│  client/                 │
│  tunnel.js (controller)  │
│  tunnel-cluster.js       │
│  failure-tracker.js      │
│  reconnect-policy.js     │
│  header-host-transformer │
│  http-inspector.js       │
│  open-browser.js         │
└──────────────────────────┘
```

## Server Architecture

```
Internet user
     │
     ▼ HTTP/WS request (Host: <tunnelId>.<publicDomain>)
┌────────────────────────────┐
│ public HTTP server         │ :public-port
│ routes by subdomain        │
└────┬───────────────────────┘
     │
     ▼ GET socket
┌────────────────────────────┐
│ ServerTunnel               │  one per expose session
│ ├── TunnelAgent            │  TCP server, socket pool
│ │    └── socket pool       │  raw sockets from expose
│ └── reconnect window timer │
└────────────────────────────┘

┌────────────────────────────┐
│ TunnelManager              │
│ Map<tunnelId, ServerTunnel>│
│ Map<token, tunnelId>       │ reservations (reconnect window)
│ Port allocation set        │
└────────────────────────────┘

┌────────────────────────────┐
│ admin HTTP server          │ :api-port (or shared with public)
│ handleAdminRequest         │
│ POST /api/tunnels[/:id]    │
│ GET  /api/tunnels/:id      │
│ GET  /api/status           │
│ GET  /healthz              │
└────────────────────────────┘
```

## Client Architecture

```
expose process
     │
     ▼ POST /api/tunnels
┌────────────────────────────┐
│ ClientTunnel               │ owns singletons
│ ├── FailureTracker         │ sliding window + total
│ ├── ReconnectPolicy        │ exponential backoff
│ └── TunnelCluster          │ manages socket pairs
└────────┬───────────────────┘
         │
         ▼ openOne() × maxConnections
┌────────────────────────────┐
│ SocketPair                 │  one per connection
│ ├── remote (net.Socket)    │  → tunnel server TCP port
│ └── local  (net.Socket)    │  → local service
│     with HeaderHostTransformer
└────────────────────────────┘

Reconnect loop (R1–R10):
  tunnel:dead → ClientTunnel.on('tunnel:dead')
    if (!retriable) → exit or skip
    if (failureTracker.shouldGiveUp()) → emit('exit')
    else → setTimeout(openOne, policy.nextDelay())
```

## Capture & Replay

```
expose --capture-dir ./caps
     │
     ▼ per-request
HttpInspector.captureRequest() → ./caps/<tunnelId>.<captureId>.req.yaml
HttpInspector.captureResponse() → ./caps/<tunnelId>.<captureId>.res.yaml

tt replay --manifest flows/onboarding.yaml
     │
     ▼ per-step
loadCaptureRequest(capturePath) → reqData
fetch(target, { method, headers, body }) → HTTP response
```

## Protocol (`the-tubes/1.0`)

All expose sessions must send `X-TT-Session-Token`. If the server has HMAC enabled, `X-TT-Auth` is also required. See [PROTOCOL.md](./PROTOCOL.md) for the full spec.

## Design Principles

- **Composition over inheritance** — only `TunnelAgent` inherits from `http.Agent`. All others use composition + `EventEmitter`.
- **Single reconnect decision point** — only `ClientTunnel` calls `openOne()`. `TunnelCluster` emits `tunnel:dead` and stops.
- **Session-token-only identity** — no IP-based identity. Every tunnel has a reconnect window, keyed by `sessionToken`.
- **Zero runtime dependencies** — all I/O via Node.js built-ins.
