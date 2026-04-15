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
│   └── client-local-resilience.test.js — R7–R9: local app down/crash/recovery
└── helpers/
    ├── fake-local-service.js       — In-process HTTP server for testing
    ├── spawn-cli.js                — Spawn the tubes CLI subprocess
    └── wait-for.js                 — Polling utilities
```

## When to run each suite

| Suite | `task` command | When to run |
|---|---|---|
| Unit | `task test:unit` | On every save (< 100 ms) |
| Integration | `task test:integration` | Before committing |
| Unit + Integration | `task test` | Default CI gate |
| Regression | `task test:regression` | After touching reconnect/resilience code, before releases |
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
| R5 | Concurrent `openOne()` race — `pairs.size` never wrong |
| R6 | `--no-reconnect-local` → `retriable=false` on first failure |

## Local Resilience Regression Tests

`test/regression/client-local-resilience.test.js` — guards against two production bugs (run with `task test:regression`):

| Test | Bug guarded |
|------|-------------|
| R7a | Single `ECONNREFUSED` → `retriable=true`, `totalFailures=0` |
| R7b | N simultaneous `ECONNREFUSED` → `totalFailures=0`, `shouldGiveUp()=false` |
| R8a | Single app crash (`ECONNRESET`) → exactly 1 failure, not 2 |
| R8b | N simultaneous crashes → N failures (not 2N), `shouldGiveUp()=false` |
| R9 | After `ECONNREFUSED`, `openOne()` succeeds once local app restarts |

### Key invariants

- **R7**: `ECONNREFUSED` must never exhaust the reconnect budget. The expose client waits indefinitely for the local app to come back.
- **R8**: Node.js fires both `'error'` and `'close'` on the same socket after an error. The `localErrorHandled` flag in `TunnelCluster._connectLocal()` ensures only one failure is recorded. Without this guard, a 5-connection crash generates 10 failures (= `maxInWindow`), triggering `reconnect_loop_detected` before any retry happens.
- **R9**: After `ECONNREFUSED` (budget untouched), `openOne()` must succeed when the local app restarts on the same port.

### Note on ECONNRESET simulation

`socket.destroy()` on an idle connection sends FIN (clean close), not RST. R8 uses `socket.resetAndDestroy()` (Node.js ≥ 18.3) to force RST and reliably trigger `ECONNRESET`.
