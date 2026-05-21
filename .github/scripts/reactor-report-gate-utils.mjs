import { createHash } from 'node:crypto';

export const CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function assertContentHash(value, label) {
  if (typeof value !== 'string' || !CONTENT_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 content hash.`);
  }
  return value;
}

export function cloneRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error('expected an array to clone.');
  }
  return rows.map((row) => cloneRow(row));
}

export function cloneRow(row) {
  return JSON.parse(JSON.stringify(row));
}

export function hashText(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function hashCanonicalValue(value) {
  return hashText(renderCanonical(value));
}

export function renderCanonical(value) {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Cannot canonicalize non-finite numbers');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((item) => renderCanonical(item)).join(',')}]`;
      }
      if (!isRecord(value)) {
        throw new TypeError('Cannot canonicalize non-plain objects');
      }
      return renderCanonicalObject(value);
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`Cannot canonicalize ${typeof value}`);
  }

  throw new TypeError('Cannot canonicalize unknown value');
}

export function renderCanonicalObject(value) {
  const fields = [];
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) {
      throw new TypeError(`Cannot canonicalize undefined field ${key}`);
    }
    fields.push(`${JSON.stringify(key)}:${renderCanonical(item)}`);
  }
  return `{${fields.join(',')}}`;
}

export function markdownTableCell(value) {
  return markdownInline(String(value)).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

export function markdownInline(value) {
  return String(value).replace(/`/g, '\\`');
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
