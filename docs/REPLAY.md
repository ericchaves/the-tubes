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

vars:
  sessionId: "{{ faker.string.uuid() }}"
  contact:
    name: "{{ faker.person.fullName() }}"
    phone: "5511{{ faker.string.numeric(9) }}"

steps:
  # Step referencing a captured file
  - capture: ../captures/wa-blutech.7391948021430226944.req.yaml
    idleMs: 10

  # Step with header and path overrides
  - capture: ../captures/wa-blutech.7392157299655053312.req.yaml
    overrides:
      headers:
        x-session-id: "{{ sessionId }}"
      bodyPatch:
        "entry[0].changes[0].value.from": "{{ contact.phone }}"

  # Fully inline step (no capture file required)
  - method: POST
    path: /webhooks/whatsapp
    headers:
      content-type: application/json
    body: |
      {
        "object": "whatsapp_business_account",
        "entry": [{
          "changes": [{
            "value": {
              "from": "{{ contact.phone }}",
              "name": "{{ contact.name }}"
            }
          }]
        }]
      }
    idleMs: 200
```

### Manifest-level fields

All string fields accept Nunjucks templates. `dotenv` vars, global `vars`, and faker are available as context.

| Field | Description |
|-------|-------------|
| `target` | Webhook URL to send requests to (template-rendered) |
| `loop` | Number of times to repeat all steps — default: 1 (template-rendered) |
| `loopPauseMs` | Pause between loop iterations in ms — default: 0 (template-rendered) |
| `warmupMs` | Wait before starting the first step in ms — default: 0 (template-rendered) |
| `sendHostHeader` | Forward the original `Host` header from the capture — default: false (template-rendered) |
| `dotenv` | List of `.env` file paths to import (relative to the manifest) |
| `vars` | Global variables available as Nunjucks context in all steps |

### Step fields

| Field | Description |
|-------|-------------|
| `capture` | Path to `.req.yaml` capture file (relative to the manifest, template-rendered) |
| `method` | HTTP method for inline steps (default: `POST`) |
| `path` | Request path for inline steps |
| `headers` | Request headers for inline steps |
| `body` | Request body for inline steps |
| `bodyEncoding` | Encoding of inline body: `utf8` (default) or `base64` |
| `type` | Set to `ws` for WebSocket steps |
| `frames` | WebSocket frames for inline WS steps |
| `vars` | Step-level variables (re-evaluated every loop iteration) |
| `idleMs` | Wait after this step before the next in ms (template-rendered) |
| `overrides.headers` | Headers to merge (template-rendered) |
| `overrides.path` | Replace the captured path (template-rendered) |
| `overrides.body` | Replace the entire body (template-rendered) |
| `overrides.bodyPatch` | Patch specific fields of a JSON body via dot/bracket notation |

---

## Templates (Nunjucks + Faker.js)

Inline step content, all `overrides` values, and manifest-level string fields (`target`, `loop`, etc.) are rendered as [Nunjucks](https://mozilla.github.io/nunjucks/) templates before being sent. **Capture files are not rendered** — their content is used verbatim.

[Faker.js](https://fakerjs.dev/) is available as `faker` in every template:

```yaml
steps:
  - method: POST
    path: /events
    body: |
      {
        "id": "{{ faker.string.uuid() }}",
        "name": "{{ faker.person.fullName() }}",
        "email": "{{ faker.internet.email() }}"
      }
```

---

## Environment Variables (`dotenv`)

Declare a list of `.env` files at the root of the manifest. Their values are loaded once before the loop and made available as template variables in every step, override, and manifest-level field.

```yaml
target: http://localhost:3000/webhooks
dotenv:
  - .env
  - .env.local
```

Example `.env` file:

```dotenv
# Application config
API_VERSION=v2
NOTIFY_EMAIL=team@example.com
TARGET_HOST=localhost
```

Reference `.env` values the same way as `vars`:

```yaml
steps:
  - capture: ./wa.req.yaml
    overrides:
      path: "/api/{{ API_VERSION }}/webhook"
      headers:
        x-notify: "{{ NOTIFY_EMAIL }}"
```

Paths are relative to the manifest file. Missing files throw an error.

**Supported `.env` syntax:**
- `KEY=value`
- `KEY="value with spaces"`
- `KEY='value'`
- Lines starting with `#` are comments and are ignored
- When multiple files declare the same key, the last file wins

**Priority (lowest → highest):** dotenv vars < global `vars` < step `vars`

If a global var and a `.env` key share the same name, the global var takes precedence. This lets you use `.env` as defaults and override them per-manifest.

**Template rendering in manifest-level fields**

`target`, `loop`, `loopPauseMs`, `warmupMs`, and `sendHostHeader` all support Nunjucks templates. `dotenv` vars and global `vars` are available:

```yaml
dotenv:
  - .env

# .env contains: TARGET_URL=http://localhost:3000
target: "{{ TARGET_URL }}"
loop: "{{ LOOP_COUNT }}"
```

---

## Variables (`vars`)

### Global vars

Declared at manifest level. Resolved **once** before the loop starts — stable across all iterations and steps.

```yaml
vars:
  sessionId: "{{ faker.string.uuid() }}"   # same value in every iteration
  env: production                           # static value

steps:
  - method: POST
    path: /events
    body: '{"session":"{{ sessionId }}","env":"{{ env }}"}'
```

Vars can be nested objects — all string leaves are rendered:

```yaml
vars:
  contact:
    name: "{{ faker.person.fullName() }}"
    phone: "5511{{ faker.string.numeric(9) }}"
    email: "{{ faker.internet.email() }}"
```

Access nested vars with dot notation in templates: `{{ contact.name }}`.

### Step-level vars

Declared inside a step. Re-evaluated on **every loop iteration** — useful for generating fresh data each time.

```yaml
vars:
  sessionId: "{{ faker.string.uuid() }}"   # stable across iterations

steps:
  - method: POST
    path: /events
    vars:
      eventId: "{{ faker.string.uuid() }}"  # new value per iteration
      ts: "{{ faker.date.recent().toISOString() }}"
    body: |
      {
        "session": "{{ sessionId }}",
        "event": "{{ eventId }}",
        "timestamp": "{{ ts }}"
      }
```

Step vars can reference global vars in their templates. If a step var has the same name as a global var, the step var takes precedence within that step.

---

## Overrides

Overrides are applied after content is loaded (from capture or inline) and are always template-rendered.

### `overrides.headers`

Merges extra headers into the request:

```yaml
- capture: ./wa.req.yaml
  overrides:
    headers:
      x-session-id: "{{ sessionId }}"
      x-replay: "true"
```

### `overrides.path`

Replaces the request path:

```yaml
- capture: ./wa.req.yaml
  overrides:
    path: /api/{{ version }}/webhook
```

### `overrides.body`

Replaces the entire request body:

```yaml
- capture: ./wa.req.yaml
  overrides:
    body: '{"replaced":true,"id":"{{ faker.string.uuid() }}"}'
```

### `overrides.bodyPatch`

Patches specific fields of a JSON body using dot notation. The rest of the body is preserved. Throws a clear error if the body is not valid JSON (regardless of content-type).

```yaml
- capture: ./wa.req.yaml
  overrides:
    bodyPatch:
      "entry[0].changes[0].value.from": "{{ contact.phone }}"
      "entry[0].id": "{{ sessionId }}"
      "metadata.version": "2"
```

Supported path syntax:
- `field` — top-level field
- `a.b.c` — nested fields (dot notation)
- `arr[0]` — array element by index
- `arr[0].field` — field inside array element

`bodyPatch` and `body` are mutually exclusive — if `body` is set, `bodyPatch` is ignored.

---

## Inline Steps

Steps do not require a capture file. Declare the full request inline:

### HTTP inline step

```yaml
steps:
  - method: POST
    path: /webhooks/whatsapp
    headers:
      content-type: application/json
      x-hub-signature-256: sha256=placeholder
    body: |
      {
        "object": "whatsapp_business_account",
        "entry": [{
          "id": "{{ contact.phone }}",
          "changes": [{"value": {"from": "{{ contact.phone }}"}}]
        }]
      }
    idleMs: 100
```

### WebSocket inline step

```yaml
steps:
  - type: ws
    path: /ws/events
    headers:
      x-session: "{{ sessionId }}"
    frames:
      - dir: client
        opcode: 1
        data: '{"action":"subscribe","id":"{{ sessionId }}"}'
      - dir: client
        opcode: 1
        data: '{"action":"ping"}'
    idleMs: 50
```

---

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

### Loop 10 times — load test with unique data per iteration

```yaml
target: http://localhost:3000/webhook
loop: 10
loopPauseMs: 200

steps:
  - method: POST
    path: /events
    headers:
      content-type: application/json
    vars:
      eventId: "{{ faker.string.uuid() }}"
      userName: "{{ faker.person.fullName() }}"
    body: |
      {
        "eventId": "{{ eventId }}",
        "user": "{{ userName }}",
        "timestamp": "{{ faker.date.recent().toISOString() }}"
      }
```

```bash
tt replay --manifest flows/load.yaml
```

### Mix captures and inline in the same manifest

```yaml
target: http://localhost:3000/webhook

vars:
  sessionId: "{{ faker.string.uuid() }}"

steps:
  # Replay an existing capture, patching one field
  - capture: ./captures/wa.7391948021430226944.req.yaml
    overrides:
      bodyPatch:
        "entry[0].id": "{{ sessionId }}"

  # Follow up with a synthetic event
  - method: POST
    path: /webhook
    headers:
      content-type: application/json
    body: '{"type":"ack","session":"{{ sessionId }}"}'
    idleMs: 100
```

---

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
   vars:
     phone: "{{ faker.phone.number() }}"
   steps:
     - capture: ../captures/wa-dev.7391948021430226944.req.yaml
       idleMs: 100
       overrides:
         bodyPatch:
           "entry[0].changes[0].value.from": "{{ phone }}"
   ```

5. Iterate on your handler without a phone:
   ```bash
   tt replay --manifest flows/onboarding.yaml
   ```
