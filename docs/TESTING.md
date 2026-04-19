# Testing

## Running Tests

```bash
# Fast feedback loop (unit + integration, excludes regression)
task test

# Specific suites
task test:unit
task test:integration
task test:regression

# Full suite before a release
task test:all

# Watch mode (unit + integration)
task test:watch
```

## Test Structure

```
test/
├── unit/               — Fast, no I/O, test individual functions
│   ├── hmac.test.js                — HMAC sign/verify
│   ├── nonce-cache.test.js         — Anti-replay nonce cache
│   ├── id-generator.test.js        — Tunnel ID and capture ID generation
│   ├── yaml-lite.test.js           — YAML subset parser round-trips
│   ├── session-file.test.js        — Session token persistence
│   ├── failure-tracker.test.js     — Sliding window failure detection
│   ├── reconnect-policy.test.js    — Exponential backoff policy
│   ├── header-host-transformer.test.js — Host header rewriting
│   └── http-inspector.test.js      — Capture file creation
├── integration/        — Test components together; use real TCP/HTTP servers
│   ├── server.test.js              — Admin API: healthz, status, create, HMAC, reconnect window, port range
│   ├── client-reconnect-loop.test.js — R1–R6: reconnect design invariants
│   └── replay.test.js              — Manifest load, capture load, session execution
├── regression/         — Guard specific bugs found in production; slower, targeted
│   ├── server-http-relay.test.js   — SRV-1–8: HTTP relay correctness via ServerTunnel + MockControlSession
│   ├── http-request-event.test.js  — HTTP-EV-1–6: TunnelCluster request event timing
│   ├── ws-capture.test.js          — WS-1–3: WebSocket capture via TunnelCluster
│   ├── client-local-resilience.test.js — R7–R9: local app down/crash/recovery
│   └── premature-local-data.test.js    — (tombstone; scenario eliminated by on-demand model)
└── helpers/
    ├── mock-control.js     — MockControlSession (server-side) + MockControlChannel (client-side)
    ├── fake-local-service.js — In-process HTTP server for testing
    ├── spawn-cli.js          — Spawn the tubes CLI subprocess
    └── wait-for.js           — Polling utilities
```

## When to run each suite

| Suite | `task` command | When to run |
|---|---|---|
| Unit | `task test:unit` | On every save (< 100 ms) |
| Integration | `task test:integration` | Before committing |
| Unit + Integration | `task test` | Default CI gate |
| Regression | `task test:regression` | After touching reconnect/resilience/relay code, before releases |
| All | `task test:all` | Before cutting a release |

## Test Framework

- `node:test` — test runner (built-in, Node.js 18+)
- `node:assert/strict` — assertions
- No test dependencies in `package.json`

## Writing Tests

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('MyModule', () => {
  it('does the thing', async () => {
    const result = await doThing();
    assert.equal(result, 'expected');
  });
});
```

## Environment Knobs for Integration Tests

Speed up timeout-heavy tests:

```bash
TT_RECONNECT_WINDOW_MS=100 node --test test/integration/server.test.js
```

## Reconnect Design Tests (integration)

`test/integration/client-reconnect-loop.test.js` — verifies the `FailureTracker` + `ReconnectPolicy` design invariants:

| Test | Scenario |
|------|----------|
| R1 | Local service killed hard — pairs bounded, failures recorded |
| R2 | Local service flapping — `shouldGiveUp()` triggers |
| R3 | Backoff not reset by socket open — delay grows monotonically |
| R4 | Successful traffic resets tracker + policy |
| R5 | Concurrent pair open race — `pairs.size` never wrong |
| R6 | `--no-reconnect-local` → `retriable=false` on first failure |

## Server HTTP Relay Regression Tests

`test/regression/server-http-relay.test.js` — guards relay correctness through `ServerTunnel` + `MockControlSession`:

| Test | Scenario |
|------|----------|
| SRV-1 | GET challenge body is plain text, not raw HTTP bytes |
| SRV-2 | POST JSON — correct status and body relayed |
| SRV-3 | Custom upstream headers forwarded to client |
| SRV-4 | Content-Length response ends without waiting for socket close (keep-alive) |
| SRV-5 | Chunked response ends on `0\r\n\r\n` terminator |
| SRV-6 | 204 ends immediately after headers (no body) |
| SRV-7 | GET with delayed upstream response does not prematurely close the pair |
| SRV-8 | 502 returned when tunnel socket closes before sending any bytes |

## HTTP Request Event Regression Tests

`test/regression/http-request-event.test.js` — guards `TunnelCluster` `'request'` event emission timing:

| Test | Scenario |
|------|----------|
| HTTP-EV-1 | Emits before close when Content-Length body is fully received |
| HTTP-EV-2 | Emits on `\r\n0\r\n\r\n` terminator for chunked responses |
| HTTP-EV-3 | 204/304 — emits immediately after headers (no body to wait for) |
| HTTP-EV-4 | Falls back to `local.once('close')` for HTTP/1.0-style responses |
| HTTP-EV-5 | Exactly one `'request'` event even when early detection and close both fire |
| HTTP-EV-6 | SSE stream — no premature emit while connection is open |

## WebSocket Capture Regression Tests

`test/regression/ws-capture.test.js` — guards WS capture via `TunnelCluster`:

| Test | Scenario |
|------|----------|
| WS-1 | Capture fires via `data.once('end')` on graceful server FIN |
| WS-2 | Capture fires via `local.once('close')` when server is destroyed (RST) |
| WS-3 | Exactly one `.ws.yaml` written even when both `end` and `close` fire |

## Local Resilience Regression Tests

`test/regression/client-local-resilience.test.js` — guards against production bugs in local service handling:

| Test | Bug guarded |
|------|-------------|
| R7a | Single `ECONNREFUSED` → `retriable=true`, `totalFailures=0` |
| R7b | N simultaneous `ECONNREFUSED` → `totalFailures=0`, `shouldGiveUp()=false` |
| R8a | Single app crash (`ECONNRESET`) → exactly 1 failure, not 2 |
| R8b | N simultaneous crashes → N failures (not 2N), `shouldGiveUp()=false` |
| R9 | After `ECONNREFUSED`, next pair opens successfully once local app restarts |

### Key invariants

- **R7**: `ECONNREFUSED` must never exhaust the reconnect budget. The expose client waits indefinitely for the local app to come back.
- **R8**: Node.js fires both `'error'` and `'close'` on the same socket after an error. `_openPair` deletes the pair and emits `tunnel:dead` in the `error` handler, so the `close` handler's second `tunnel:dead` emission is correct (different kind: `localDrop`) but the `failureTracker.record()` call is only in the `error` handler — preventing double-counting. Without this separation, a 5-connection crash generates 10 failures (= `maxInWindow`), triggering `reconnect_loop_detected` before any retry happens.
- **R9**: After `ECONNREFUSED` (budget untouched), the next `pair.open` must succeed when the local app restarts on the same port.

### Note on ECONNRESET simulation

`socket.destroy()` on an idle connection sends FIN (clean close), not RST. R8 uses `socket.resetAndDestroy()` (Node.js ≥ 18.3) to force RST and reliably trigger `ECONNRESET`.

### Note on test server teardown

TCP server sockets used as data endpoints (`createAcceptingServer`) must be put in flowing mode with `sock.resume()`. Without it, FIN frames from `data.end()` accumulate in the kernel read buffer but are never processed by Node.js, stalling the FIN exchange and causing `server.close()` to hang indefinitely.
