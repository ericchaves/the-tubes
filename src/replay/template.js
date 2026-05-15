import { createHmac } from 'crypto';
import nunjucks from 'nunjucks';
import { faker } from '@faker-js/faker';

const env = new nunjucks.Environment(null, { throwOnUndefined: false, autoescape: false });

env.addGlobal('hmacSha256', (data, key) => {
  if (data == null || key == null) return '';
  return createHmac('sha256', String(key)).update(data).digest('hex');
});

env.addGlobal('hmacSha1', (data, key) => {
  if (data == null || key == null) return '';
  return createHmac('sha1', String(key)).update(data).digest('hex');
});

/**
 * Render a Nunjucks template string with the given context.
 * faker is always available in the context.
 */
export function renderString(str, context) {
  return env.renderString(str, { faker, ...context });
}

/**
 * Recursively render all string leaves in value as Nunjucks templates.
 * Numbers, booleans and null pass through unchanged.
 */
export function renderDeep(value, context) {
  if (typeof value === 'string') return renderString(value, context);
  if (Array.isArray(value)) return value.map(item => renderDeep(item, context));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = renderDeep(v, context);
    }
    return out;
  }
  return value;
}

/**
 * Resolve a vars declaration object: each value is rendered as a template.
 * extraContext is merged with faker before rendering, allowing step vars
 * to reference global vars.
 */
export function resolveVars(varsDecl, extraContext = {}) {
  if (!varsDecl || typeof varsDecl !== 'object') return {};
  const context = { faker, ...extraContext };
  const out = {};
  for (const [key, value] of Object.entries(varsDecl)) {
    out[key] = renderDeep(value, context);
  }
  return out;
}

/**
 * Apply a bodyPatch (dot/bracket notation keys → template values) to a JSON body string.
 * Throws a clear error if body is not valid JSON.
 * Returns the updated body as a JSON string.
 */
export function applyBodyPatch(body, patch, context) {
  let obj;
  try {
    obj = JSON.parse(body);
  } catch {
    throw new Error(`bodyPatch requires a valid JSON body; got: ${String(body).slice(0, 80)}`);
  }
  for (const [path, tmpl] of Object.entries(patch)) {
    _setPath(obj, path, renderDeep(tmpl, context));
  }
  return JSON.stringify(obj);
}

function _setPath(obj, path, value) {
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] == null) {
      cur[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}
