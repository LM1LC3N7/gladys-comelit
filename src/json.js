// -----------------------------------------------------------------------------
// JSON from the network or the disk, parsed without the keys that could reach
// an object prototype later (`__proto__`, `constructor`, `prototype`). The
// bridge answers are only read by fixed keys, never merged into an object,
// but a key like these is dropped at the source anyway.
// -----------------------------------------------------------------------------

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export function safeJson(text) {
  return JSON.parse(text, (key, value) => (FORBIDDEN.has(key) ? undefined : value));
}

/** An own property of a parsed object, never one of its prototype. */
export const own = (object, key) =>
  object !== null && typeof object === 'object' && Object.hasOwn(object, key)
    ? object[key]
    : undefined;
