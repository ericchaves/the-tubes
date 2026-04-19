# the tubes — Architecture

## Overview

the tubes is a single Node.js CLI (`the tubes`) with three subcommands:

- `serve` — runs the tunnel server
- `expose` — exposes a local port through a running server
- `replay` — replays captured HTTP requests against a target

Zero runtime dependencies. All networking uses `node:http`, `node:net`, `node:tls`, `node:http2` (for WebSocket upgrade handling via raw TCP).

## Layer Diagram

```
┌──────────────────────────────────────────────────┐
│  bin/tt.js   ← entry, dispatch by command        │
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
    │          │  control-protocol.js  │
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
│  control-channel.js   │
│  router.js            │
│  hmac-middleware.js   │
│  api-server.js        │
└───────────────────────┘

┌──────────────────────────┐
│  client/                 │
│  tunnel.js (controller)  │
│  tunnel-cluster.js       │
│  control-channel.js      │
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
     ▼ forward to tunnel
┌────────────────────────────┐
│ ServerTunnel               │  one per expose session
│ ├── ControlSession         │  WS at /api/tunnels/:id/control
│ ├── TunnelAgent            │  TCP server for data sockets
│ └── reconnect window timer │
└────────────────────────────┘

Request flow (on-demand model):
  1. HTTP/WS request arrives at public server
  2. ServerTunnel sends pair.open on control channel
  3. Expose client connects to TunnelAgent TCP port
  4. Client writes preamble: TT/1 PAIR <pairId>\r\n
  5. TunnelAgent matches preamble → resolves pending reservation
  6. ServerTunnel pipes external ↔ data socket bidirectionally

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
│ GET  /api/tunnels/:id/control  (WS upgrade)
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
│ ├── ControlChannel         │ WS control channel
│ └── TunnelCluster          │ manages on-demand pairs
└────────┬───────────────────┘
         │
         ▼ one pair per server pair.open message
┌────────────────────────────┐
│ on-demand pair             │  created only when needed
│ ├── data (net.Socket)      │  → tunnel server TCP port
│ │    preamble: TT/1 PAIR   │
│ └── local (net.Socket)     │  → local service
│     with HeaderHostTransformer
└────────────────────────────┘

Pair lifecycle:
  control ← pair.open  → TunnelCluster._openPair()
    connect local service first (ECONNREFUSED → pair.failed)
    connect data socket, write preamble
    pipe bidirectionally
    on close → pair.closed (with stats)

Failure tracking:
  tunnel:dead → ClientTunnel.on('tunnel:dead')
    if (failureTracker.shouldGiveUp()) → emit('exit', 'reconnect_loop_detected')

Control reconnect (R1–R6):
  ControlChannel WS drops → built-in exponential backoff reconnect
  On reconnect → hello(resumeControlId, inflightPairs[])
  Server replies hello.ack → keep[] pairs reattached, drop[] pairs torn down
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

All expose sessions must send `X-TT-Session-Token`. If the server has HMAC enabled, `X-TT-Auth` is also required. After tunnel creation, the expose client maintains a persistent WebSocket control channel through which the server sends `pair.open` instructions. Each data socket is opened on demand with a `TT/1 PAIR <pairId>` preamble. See [PROTOCOL.md](./PROTOCOL.md) for the full spec.

## Design Principles

- **On-demand pairs** — data sockets are opened only when the server has a real request waiting. No pre-opened pool.
- **Composition over inheritance** — only `TunnelAgent` inherits from `http.Agent`. All others use composition + `EventEmitter`.
- **Single reconnect decision point** — only `ClientTunnel` calls reconnect logic. `TunnelCluster` emits `tunnel:dead` and stops.
- **Session-token-only identity** — no IP-based identity. Every tunnel has a reconnect window, keyed by `sessionToken`.
- **Zero runtime dependencies** — all I/O via Node.js built-ins.
