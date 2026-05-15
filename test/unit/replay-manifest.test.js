import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from '../../src/common/yaml-lite.js';
import { loadManifest, loadDotEnvFiles } from '../../src/replay/manifest.js';

let tmpDir;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'replay-manifest-test-'));
}

function teardown() {
  rmSync(tmpDir, { recursive: true, force: true });
}

function write(name, obj) {
  const p = join(tmpDir, name);
  writeFileSync(p, stringify(obj));
  return p;
}

describe('loadManifest — vars', () => {
  before(setup);
  after(teardown);

  it('exposes global vars when declared', () => {
    const p = write('vars.yaml', {
      target: 'http://x',
      vars: { sessionId: 'abc', env: 'prod' },
      steps: [{ path: '/x', method: 'GET' }],
    });
    const { manifest } = loadManifest(p);
    assert.deepEqual(manifest.vars, { sessionId: 'abc', env: 'prod' });
  });

  it('exposes nested vars objects', () => {
    const p = write('nested-vars.yaml', {
      target: 'http://x',
      vars: { user: { name: 'Alice', email: 'a@b.com' } },
      steps: [{ path: '/x', method: 'GET' }],
    });
    const { manifest } = loadManifest(p);
    assert.deepEqual(manifest.vars.user, { name: 'Alice', email: 'a@b.com' });
  });

  it('manifest.vars is undefined when not declared', () => {
    const p = write('no-vars.yaml', {
      target: 'http://x',
      steps: [{ path: '/x', method: 'GET' }],
    });
    const { manifest } = loadManifest(p);
    assert.equal(manifest.vars, undefined);
  });
});

describe('loadManifest — inline HTTP steps', () => {
  before(setup);
  after(teardown);

  it('accepts inline step with method and path', () => {
    const p = write('inline-http.yaml', {
      target: 'http://x',
      steps: [{ method: 'POST', path: '/webhook', headers: {}, body: '{}' }],
    });
    const { manifest } = loadManifest(p);
    const step = manifest.steps[0];
    assert.equal(step.method, 'POST');
    assert.equal(step.path, '/webhook');
  });

  it('accepts inline step with only path (method not required)', () => {
    const p = write('inline-path-only.yaml', {
      target: 'http://x',
      steps: [{ path: '/webhook' }],
    });
    const { manifest } = loadManifest(p);
    assert.equal(manifest.steps[0].path, '/webhook');
  });

  it('accepts inline step with Nunjucks template in fields', () => {
    const p = join(tmpDir, 'inline-template.yaml');
    writeFileSync(p, [
      'target: http://x',
      'steps:',
      '  - method: POST',
      '    path: /webhook',
      '    headers:',
      '      x-id: "{{ sessionId }}"',
      '    body: \'{"name":"{{ user.name }}"}\' ',
    ].join('\n'));
    const { manifest } = loadManifest(p);
    assert.equal(manifest.steps[0].headers['x-id'], '{{ sessionId }}');
  });

  it('throws ConfigError for inline HTTP step missing path', () => {
    const p = write('missing-path.yaml', {
      target: 'http://x',
      steps: [{ method: 'POST', body: '{}' }],
    });
    assert.throws(() => loadManifest(p), /path/i);
  });
});

describe('loadManifest — inline WebSocket steps', () => {
  before(setup);
  after(teardown);

  it('accepts inline WS step with type and path', () => {
    const p = join(tmpDir, 'inline-ws.yaml');
    writeFileSync(p, [
      'target: http://x',
      'steps:',
      '  - type: ws',
      '    path: /events',
      '    frames:',
      '      - dir: client',
      '        opcode: 1',
      '        data: hello',
    ].join('\n'));
    const { manifest } = loadManifest(p);
    const step = manifest.steps[0];
    assert.equal(step.type, 'ws');
    assert.equal(step.path, '/events');
    assert.equal(step.frames.length, 1);
  });

  it('throws ConfigError for inline WS step missing path', () => {
    const p = write('ws-no-path.yaml', {
      target: 'http://x',
      steps: [{ type: 'ws', frames: [] }],
    });
    assert.throws(() => loadManifest(p), /path/i);
  });
});

describe('loadManifest — step-level vars', () => {
  before(setup);
  after(teardown);

  it('exposes vars declared at step level', () => {
    const p = join(tmpDir, 'step-vars.yaml');
    writeFileSync(p, [
      'target: http://x',
      'steps:',
      '  - path: /x',
      '    method: POST',
      '    vars:',
      '      eventId: "{{ faker.string.uuid() }}"',
      '    body: \'{"id":"{{ eventId }}"}\' ',
    ].join('\n'));
    const { manifest } = loadManifest(p);
    assert.equal(manifest.steps[0].vars.eventId, '{{ faker.string.uuid() }}');
  });

  it('step-level vars is undefined when not declared', () => {
    const p = write('no-step-vars.yaml', {
      target: 'http://x',
      steps: [{ path: '/x', method: 'GET' }],
    });
    const { manifest } = loadManifest(p);
    assert.equal(manifest.steps[0].vars, undefined);
  });
});

describe('loadDotEnvFiles', () => {
  before(setup);
  after(teardown);

  function writeEnv(name, content) {
    const p = join(tmpDir, name);
    writeFileSync(p, content);
    return p;
  }

  it('parses KEY=value pairs', () => {
    writeEnv('.env', 'API_KEY=abc123\nAPI_URL=http://localhost:3000\n');
    const result = loadDotEnvFiles(['.env'], tmpDir);
    assert.equal(result.API_KEY, 'abc123');
    assert.equal(result.API_URL, 'http://localhost:3000');
  });

  it('strips double quotes', () => {
    writeEnv('.env.quoted', 'TOKEN="secret value"\nHOST="example.com"\n');
    const result = loadDotEnvFiles(['.env.quoted'], tmpDir);
    assert.equal(result.TOKEN, 'secret value');
    assert.equal(result.HOST, 'example.com');
  });

  it('strips single quotes', () => {
    writeEnv('.env.single', "NAME='John Doe'\nROLE='admin'\n");
    const result = loadDotEnvFiles(['.env.single'], tmpDir);
    assert.equal(result.NAME, 'John Doe');
    assert.equal(result.ROLE, 'admin');
  });

  it('ignores comment lines and empty lines', () => {
    writeEnv('.env.comments', '# This is a comment\n\nKEY=value\n  # another comment\nOTHER=x\n');
    const result = loadDotEnvFiles(['.env.comments'], tmpDir);
    assert.equal(Object.keys(result).length, 2);
    assert.equal(result.KEY, 'value');
    assert.equal(result.OTHER, 'x');
  });

  it('ignores lines without = sign', () => {
    writeEnv('.env.noeq', 'VALID=yes\nINVALID_LINE\nALSO=ok\n');
    const result = loadDotEnvFiles(['.env.noeq'], tmpDir);
    assert.equal(result.VALID, 'yes');
    assert.equal(result.ALSO, 'ok');
    assert.equal(result.INVALID_LINE, undefined);
  });

  it('value may contain = characters', () => {
    writeEnv('.env.eqval', 'BASE64=abc=def==\n');
    const result = loadDotEnvFiles(['.env.eqval'], tmpDir);
    assert.equal(result.BASE64, 'abc=def==');
  });

  it('merges multiple files — later file overrides earlier on collision', () => {
    writeEnv('.env.a', 'KEY=from_a\nONLY_A=yes\n');
    writeEnv('.env.b', 'KEY=from_b\nONLY_B=yes\n');
    const result = loadDotEnvFiles(['.env.a', '.env.b'], tmpDir);
    assert.equal(result.KEY, 'from_b');
    assert.equal(result.ONLY_A, 'yes');
    assert.equal(result.ONLY_B, 'yes');
  });

  it('returns empty object for null list', () => {
    assert.deepEqual(loadDotEnvFiles(null, tmpDir), {});
  });

  it('returns empty object for empty array', () => {
    assert.deepEqual(loadDotEnvFiles([], tmpDir), {});
  });

  it('throws ConfigError when file is missing', () => {
    assert.throws(
      () => loadDotEnvFiles(['.env.missing'], tmpDir),
      /\.env file not found/i,
    );
  });
});

describe('loadManifest — dotenv validation', () => {
  before(setup);
  after(teardown);

  it('accepts manifest without dotenv key', () => {
    const p = write('no-dotenv.yaml', {
      target: 'http://x',
      steps: [{ path: '/x', method: 'GET' }],
    });
    const { manifest } = loadManifest(p);
    assert.equal(manifest.dotenv, undefined);
  });

  it('accepts manifest with dotenv as array', () => {
    const envPath = join(tmpDir, '.env');
    writeFileSync(envPath, 'KEY=val\n');
    const p = write('with-dotenv.yaml', {
      target: 'http://x',
      dotenv: ['.env'],
      steps: [{ path: '/x', method: 'GET' }],
    });
    const { manifest } = loadManifest(p);
    assert.deepEqual(manifest.dotenv, ['.env']);
  });

  it('throws ConfigError when dotenv is not an array', () => {
    const p = write('bad-dotenv.yaml', {
      target: 'http://x',
      dotenv: '.env',
      steps: [{ path: '/x', method: 'GET' }],
    });
    assert.throws(() => loadManifest(p), /dotenv.*array/i);
  });
});

describe('loadManifest — mixed capture and inline steps', () => {
  before(setup);
  after(teardown);

  it('accepts a mix of capture and inline steps', () => {
    const capPath = join(tmpDir, 'cap.req.yaml');
    writeFileSync(capPath, stringify({
      request: { method: 'POST', path: '/x', headers: {}, body: '{}' },
    }));
    const p = write('mixed.yaml', {
      target: 'http://x',
      steps: [
        { capture: './cap.req.yaml' },
        { method: 'GET', path: '/ping' },
      ],
    });
    const { manifest } = loadManifest(p);
    assert.equal(manifest.steps.length, 2);
    assert.equal(manifest.steps[0].capture, './cap.req.yaml');
    assert.equal(manifest.steps[1].path, '/ping');
  });
});
