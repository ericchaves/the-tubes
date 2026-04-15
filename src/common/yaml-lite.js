/**
 * Minimal YAML writer and reader for a fixed subset used by the tubes captures.
 *
 * Supported subset (write + read):
 *   - Top-level and nested mappings (key: value)
 *   - Scalar values: string, number, boolean, null
 *   - Block literal strings (|) for multi-line values only
 *   - Double-quoted strings for single-line values that need quoting
 *   - Sequences (- item) one level deep
 *
 * Not supported (will throw on read, never emitted on write):
 *   - Anchors, aliases, merge keys
 *   - Flow style ({}, [])
 *   - Tags (!!, !!str, etc.)
 *   - Multi-document (---)
 */

// ──────────────────────────────────────────────────────────────────────────────
// Writer
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a plain object to YAML string.
 * @param {object} obj
 * @returns {string}
 */
export function stringify(obj) {
  return _dumpValue(obj, 0);
}

function _indent(level) {
  return '  '.repeat(level);
}

function _dumpValue(value, level) {
  if (value === null || value === undefined) return 'null\n';
  if (typeof value === 'boolean') return `${value}\n`;
  if (typeof value === 'number') return `${value}\n`;
  if (typeof value === 'string') return _dumpString(value, level);
  if (Array.isArray(value)) return _dumpArray(value, level);
  if (typeof value === 'object') return _dumpMapping(value, level);
  return `${String(value)}\n`;
}

function _dumpString(str, level) {
  // Use block literal for multi-line strings
  if (str.includes('\n') || str.includes('\r')) {
    const ind = _indent(level);
    const lines = str.replace(/\n$/, '').split('\n');
    return '|\n' + lines.map(l => `${ind}${l}`).join('\n') + '\n';
  }
  // Use double-quoted for strings that need quoting (single-line)
  if (_needsQuoting(str)) {
    const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"\n`;
  }
  return `${str}\n`;
}

function _needsQuoting(str) {
  if (str === '') return true;
  // Characters that could be misinterpreted at start of scalar
  if (/^[|>&*!,[\]{}"'#%@`]/.test(str)) return true;
  // Looks like a YAML special value
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(str)) return true;
  // Looks like a number (would be parsed as number, not string)
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(str)) return true;
  // Contains colon+space or trailing colon (mapping indicator)
  if (/:\s/.test(str) || str.endsWith(':')) return true;
  return false;
}

function _dumpArray(arr, level) {
  if (arr.length === 0) return '[]\n';
  const ind = _indent(level);
  let out = '';
  for (const item of arr) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const entries = Object.entries(item);
      if (entries.length === 0) {
        out += `${ind}- {}\n`;
      } else {
        const [firstKey, firstVal] = entries[0];
        const firstDumped = _dumpValue(firstVal, level + 2);
        out += `${ind}- ${firstKey}: ${firstDumped}`;
        for (let i = 1; i < entries.length; i++) {
          const [k, v] = entries[i];
          out += `${ind}  ${k}: ${_dumpValue(v, level + 2)}`;
        }
      }
    } else {
      out += `${ind}- ${_dumpValue(item, level + 1)}`;
    }
  }
  return out;
}

function _dumpMapping(obj, level) {
  const ind = _indent(level);
  let out = '';
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const dumped = _dumpValue(value, level + 1);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out += `${ind}${key}:\n${dumped}`;
    } else if (Array.isArray(value)) {
      out += `${ind}${key}:\n${dumped}`;
    } else if (dumped.startsWith('|\n')) {
      out += `${ind}${key}: ${dumped}`;
    } else {
      out += `${ind}${key}: ${dumped}`;
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Reader
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse a YAML string (subset only) to a plain JS object.
 * @param {string} yamlStr
 * @returns {object}
 */
export function parse(yamlStr) {
  const lines = yamlStr.split('\n');
  const result = _parseBlock(lines, 0, 0);
  return result.value;
}

/**
 * @param {string[]} lines
 * @param {number} startLine
 * @param {number} indent
 * @returns {{ value: any, nextLine: number }}
 */
function _parseBlock(lines, startLine, indent) {
  const result = {};
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }

    const lineIndent = _getIndent(line);
    if (lineIndent < indent) break;

    const trimmed = line.trim();
    if (/^[&*]/.test(trimmed)) {
      throw new Error(`yaml-lite: unsupported YAML feature at line ${i + 1}: "${trimmed}"`);
    }

    // Sequence item
    if (trimmed.startsWith('- ') || trimmed === '-') {
      return _parseSequence(lines, startLine, indent);
    }

    // Mapping entry
    const colonIdx = line.indexOf(': ', lineIndent);
    const isColonEnd = line.endsWith(':') && colonIdx === -1;

    if (colonIdx !== -1 || isColonEnd) {
      const colonPos = isColonEnd ? line.lastIndexOf(':') : colonIdx;
      const key = line.slice(lineIndent, colonPos).trim();
      const rest = isColonEnd ? '' : line.slice(colonPos + 2);
      const restTrimmed = rest.replace(/#[^"]*$/, '').trimEnd();

      if (restTrimmed === '') {
        // Value on next lines
        i++;
        let nextContent = i;
        while (nextContent < lines.length &&
               (lines[nextContent].trim() === '' || lines[nextContent].trim().startsWith('#'))) {
          nextContent++;
        }
        if (nextContent >= lines.length) {
          result[key] = null;
        } else {
          const nextIndent = _getIndent(lines[nextContent]);
          if (nextIndent > lineIndent) {
            const nested = _parseBlock(lines, nextContent, nextIndent);
            result[key] = nested.value;
            i = nested.nextLine;
          } else {
            result[key] = null;
          }
        }
      } else if (restTrimmed === '|') {
        // Block literal — detect actual indent from first content line
        i++;
        let blockIndent = lineIndent + 2; // fallback
        let probe = i;
        while (probe < lines.length && lines[probe].trim() === '') probe++;
        if (probe < lines.length) {
          blockIndent = _getIndent(lines[probe]);
        }
        const blockLines = [];
        while (i < lines.length) {
          const bl = lines[i];
          if (bl.trim() === '' || _getIndent(bl) >= blockIndent) {
            blockLines.push(bl.slice(blockIndent));
            i++;
          } else {
            break;
          }
        }
        // Remove trailing empty lines (chomping: clip)
        while (blockLines.length > 0 && blockLines[blockLines.length - 1].trim() === '') {
          blockLines.pop();
        }
        result[key] = blockLines.join('\n');
      } else {
        result[key] = _parseScalar(restTrimmed);
        i++;
      }
    } else {
      i++;
    }
  }

  return { value: result, nextLine: i };
}

function _parseSequence(lines, startLine, indent) {
  const arr = [];
  let i = startLine;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }

    const lineIndent = _getIndent(line);
    if (lineIndent < indent) break;

    const trimmed = line.trim();
    if (!trimmed.startsWith('-')) break;

    const rest = trimmed.slice(1).trimStart();
    if (rest === '' || rest.startsWith('#')) {
      i++;
      const nextIndent = indent + 2;
      const nested = _parseBlock(lines, i, nextIndent);
      arr.push(nested.value);
      i = nested.nextLine;
    } else if (rest.includes(': ') || rest.endsWith(':')) {
      // Inline mapping starting from -
      const pseudoLines = [' '.repeat(indent + 2) + rest, ...lines.slice(i + 1)];
      const nested = _parseBlock(pseudoLines, 0, indent + 2);
      arr.push(nested.value);
      i += nested.nextLine;
    } else {
      arr.push(_parseScalar(rest));
      i++;
    }
  }

  return { value: arr, nextLine: i };
}

function _getIndent(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

function _parseScalar(str) {
  const s = str.trim();
  if (s === 'null' || s === '~' || s === '') return null;
  if (s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === 'no' || s === 'off') return false;
  // Number
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  // Quoted string
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}
