import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderString, renderDeep, resolveVars, applyBodyPatch } from '../../src/replay/template.js';

describe('renderString', () => {
  it('substitutes a simple variable', () => {
    assert.equal(renderString('Hello {{ name }}', { name: 'World' }), 'Hello World');
  });

  it('renders faker.string.uuid() as a UUID', () => {
    const result = renderString('{{ faker.string.uuid() }}', {});
    assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('renders faker.person.firstName() as a non-empty string', () => {
    const result = renderString('{{ faker.person.firstName() }}', {});
    assert.ok(result.length > 0);
  });

  it('leaves undefined variables as empty string without throwing', () => {
    assert.equal(renderString('{{ missing }}', {}), '');
  });

  it('passes through strings with no template syntax', () => {
    assert.equal(renderString('no templates here', {}), 'no templates here');
  });

  it('handles double braces in context value (no double-render)', () => {
    const result = renderString('{{ val }}', { val: '{{ not_rendered }}' });
    assert.equal(result, '{{ not_rendered }}');
  });
});

describe('renderDeep', () => {
  it('renders a flat object', () => {
    const result = renderDeep({ a: '{{ x }}', b: '{{ y }}' }, { x: '1', y: '2' });
    assert.deepEqual(result, { a: '1', b: '2' });
  });

  it('renders a nested object', () => {
    const result = renderDeep({ outer: { inner: '{{ val }}' } }, { val: 'deep' });
    assert.equal(result.outer.inner, 'deep');
  });

  it('renders an array', () => {
    const result = renderDeep(['{{ a }}', '{{ b }}'], { a: '1', b: '2' });
    assert.deepEqual(result, ['1', '2']);
  });

  it('renders array elements inside objects', () => {
    const result = renderDeep({ items: ['{{ x }}', '{{ y }}'] }, { x: 'p', y: 'q' });
    assert.deepEqual(result.items, ['p', 'q']);
  });

  it('passes through numbers unchanged', () => {
    assert.equal(renderDeep(42, {}), 42);
  });

  it('passes through booleans unchanged', () => {
    assert.equal(renderDeep(true, {}), true);
    assert.equal(renderDeep(false, {}), false);
  });

  it('passes through null unchanged', () => {
    assert.equal(renderDeep(null, {}), null);
  });

  it('does not mutate the original object', () => {
    const original = { a: '{{ x }}' };
    renderDeep(original, { x: 'rendered' });
    assert.equal(original.a, '{{ x }}');
  });
});

describe('resolveVars', () => {
  it('resolves simple string vars', () => {
    const result = resolveVars({ greeting: 'Hello {{ name }}' }, { name: 'Alice' });
    assert.equal(result.greeting, 'Hello Alice');
  });

  it('resolves nested object vars leaf by leaf', () => {
    const result = resolveVars({ user: { name: '{{ n }}', city: '{{ c }}' } }, { n: 'Bob', c: 'SP' });
    assert.deepEqual(result.user, { name: 'Bob', city: 'SP' });
  });

  it('resolves faker in vars', () => {
    const result = resolveVars({ id: '{{ faker.string.uuid() }}' }, {});
    assert.match(result.id, /^[0-9a-f-]{36}$/);
  });

  it('resolves faker inside nested object', () => {
    const result = resolveVars({ user: { id: '{{ faker.string.uuid() }}' } }, {});
    assert.match(result.user.id, /^[0-9a-f-]{36}$/);
  });

  it('makes extraContext available in vars', () => {
    const result = resolveVars({ msg: 'id={{ sessionId }}' }, { sessionId: 'abc-123' });
    assert.equal(result.msg, 'id=abc-123');
  });

  it('returns empty object for null varsDecl', () => {
    assert.deepEqual(resolveVars(null), {});
  });

  it('returns empty object for undefined varsDecl', () => {
    assert.deepEqual(resolveVars(undefined), {});
  });

  it('generates different UUID values across two resolveVars calls', () => {
    const a = resolveVars({ id: '{{ faker.string.uuid() }}' }, {});
    const b = resolveVars({ id: '{{ faker.string.uuid() }}' }, {});
    assert.notEqual(a.id, b.id);
  });
});

describe('applyBodyPatch', () => {
  it('patches a top-level field', () => {
    const result = applyBodyPatch('{"a":1,"b":2}', { a: '99' }, {});
    assert.deepEqual(JSON.parse(result), { a: '99', b: 2 });
  });

  it('leaves unpatched fields untouched', () => {
    const result = applyBodyPatch('{"a":1,"b":2}', { a: 'X' }, {});
    assert.equal(JSON.parse(result).b, 2);
  });

  it('patches a nested field via dot notation', () => {
    const body = JSON.stringify({ user: { name: 'old', age: 30 } });
    const result = applyBodyPatch(body, { 'user.name': 'new' }, {});
    const parsed = JSON.parse(result);
    assert.equal(parsed.user.name, 'new');
    assert.equal(parsed.user.age, 30);
  });

  it('patches an array element via bracket notation', () => {
    const body = JSON.stringify({ items: ['a', 'b', 'c'] });
    const result = applyBodyPatch(body, { 'items[1]': 'X' }, {});
    assert.deepEqual(JSON.parse(result).items, ['a', 'X', 'c']);
  });

  it('patches a nested field inside an array element', () => {
    const body = JSON.stringify({ entry: [{ id: 'old', v: 1 }] });
    const result = applyBodyPatch(body, { 'entry[0].id': 'new' }, {});
    const parsed = JSON.parse(result);
    assert.equal(parsed.entry[0].id, 'new');
    assert.equal(parsed.entry[0].v, 1);
  });

  it('renders template syntax in patch values', () => {
    const body = JSON.stringify({ name: 'old' });
    const result = applyBodyPatch(body, { name: '{{ val }}' }, { val: 'rendered' });
    assert.equal(JSON.parse(result).name, 'rendered');
  });

  it('renders faker in patch values', () => {
    const body = JSON.stringify({ id: 'old' });
    const result = applyBodyPatch(body, { id: '{{ faker.string.uuid() }}' }, {});
    assert.match(JSON.parse(result).id, /^[0-9a-f-]{36}$/);
  });

  it('accepts non-string literal patch values (number, boolean)', () => {
    const body = JSON.stringify({ count: 0, active: false });
    const result = applyBodyPatch(body, { count: 42, active: true }, {});
    const parsed = JSON.parse(result);
    assert.equal(parsed.count, 42);
    assert.equal(parsed.active, true);
  });

  it('throws a clear error when body is not valid JSON', () => {
    assert.throws(
      () => applyBodyPatch('not json', { a: '1' }, {}),
      /bodyPatch requires a valid JSON body/
    );
  });

  it('throws a clear error for empty string body', () => {
    assert.throws(
      () => applyBodyPatch('', { a: '1' }, {}),
      /bodyPatch requires a valid JSON body/
    );
  });
});
