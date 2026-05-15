import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

/**
 * Parse a YAML string to a plain JS object.
 * @param {string} yamlStr
 * @returns {object}
 */
export function parse(yamlStr) {
  return yamlParse(yamlStr);
}

/**
 * Serialize a plain object to a YAML string.
 * @param {object} obj
 * @returns {string}
 */
export function stringify(obj) {
  return yamlStringify(obj, { lineWidth: 0 });
}
