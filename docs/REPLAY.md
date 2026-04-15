# tt replay

Replays captured HTTP requests from a manifest file against a target URL. Use this to iterate on webhook handlers without depending on real events.

## Usage

```bash
tt replay --manifest <path> [options]
```

## Flags

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--manifest` | `TT_REPLAY_MANIFEST` | **required** | Path to the replay manifest YAML |
| `--target-url` | `TT_REPLAY_TARGET_URL` | from manifest | Override the target URL |
| `--loop` | — | from manifest / 1 | Repeat the sequence N times |
| `--loop-pause-ms` | — | from manifest / 0 | Pause between loops (ms) |
| `--warmup-ms` | — | from manifest / 0 | Wait before starting (ms) |
| `--send-host-header` | — | false | Include the original `Host:` header from the capture |
| `--dry-run` | — | false | Print what would be sent, without sending |

## Capture Format

When you run `tt expose --capture-dir ./captures`, each request/response pair is saved as YAML:

```
captures/<tunnelId>.<captureId>.req.yaml
captures/<tunnelId>.<captureId>.res.yaml
```

### Request file (`.req.yaml`)

```yaml
captureId: 7391948021430226944
tunnelId: wa-blutech
timestamp: 2026-04-15T14:22:03.412Z
request:
  method: POST
  path: /webhook?token=abc
  headers:
    content-type: application/json
    x-hub-signature-256: sha256=...
  bodyEncoding: utf8
  body: |
    {"object":"whatsapp_business_account","entry":[...]}
```

`bodyEncoding` is one of:
- `utf8` — body is inline text
- `base64` — binary body, base64-encoded inline
- `file` — binary body stored in a `.bin` file (> 16 KB)

## Manifest Format

```yaml
target: http://localhost:3000/webhooks/whatsapp
loop: 1
loopPauseMs: 500
warmupMs: 100
sendHostHeader: false

steps:
  - capture: ../captures/wa-blutech.7391948021430226944.req.yaml
    idleMs: 10
  - capture: ../captures/wa-blutech.7392157299655053312.req.yaml
  - capture: ../captures/wa-blutech.7392157299655053312.req.yaml
    overrides:
      headers:
        x-test-marker: replay-1
```

Capture paths are resolved relative to the manifest file's directory.

### Step fields

| Field | Description |
|-------|-------------|
| `capture` | Path to `.req.yaml` capture file |
| `idleMs` | Wait after this step before the next (ms) |
| `overrides.headers` | Extra headers to merge into the request |

## Examples

### Basic replay

```bash
tt replay --manifest flows/onboarding.yaml
```

### Override target

```bash
tt replay \
  --manifest flows/onboarding.yaml \
  --target-url http://localhost:4000/webhook
```

### Dry run (inspect what would be sent)

```bash
tt replay --manifest flows/onboarding.yaml --dry-run
```

### Loop 3 times with pause

```bash
tt replay \
  --manifest flows/onboarding.yaml \
  --loop 3 \
  --loop-pause-ms 1000
```

## WhatsApp Webhook Development Workflow

1. Expose your local webhook handler:
   ```bash
   tt expose \
     --local-port 3000 \
     --server-url http://tunnel.example.com \
     --tunnel-subdomain wa-dev \
     --capture-dir ./captures
   ```

2. Configure Meta with `https://wa-dev.tunnel.example.com/webhook`.

3. Trigger real WhatsApp interactions. Captures are saved automatically.

4. Write a manifest referencing the captures you want to replay:
   ```yaml
   target: http://localhost:3000/webhook
   steps:
     - capture: ../captures/wa-dev.7391948021430226944.req.yaml
       idleMs: 100
   ```

5. Iterate on your handler without a phone:
   ```bash
   tt replay --manifest flows/onboarding.yaml
   ```
