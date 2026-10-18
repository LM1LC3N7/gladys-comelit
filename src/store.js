// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the stops after a refused PIN or token, with the address they
// belong to, so a restart never sends a refused secret again. Never the PIN
// or the token, nor anything derived from them (a short PIN is found again
// from any hash). The file is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { safeJson } from './json.js';

export const STATE_FILE = '/data/comelit-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return safeJson(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** In-memory store, for the tests. */
export function memoryStore(initial = null) {
  let data = initial;
  return {
    async load() {
      return data === null ? null : JSON.parse(JSON.stringify(data));
    },
    async save(next) {
      data = JSON.parse(JSON.stringify(next));
    },
    get data() {
      return data;
    },
  };
}

/** bridge_pin: the bridge PIN; vedo_pin: the alarm PIN; icona_token: the intercom token. */
export const STOP_KINDS = ['bridge_pin', 'vedo_pin', 'icona_token'];

/** The persisted state, repaired: { stops: [{ kind, place, at }] }, one per kind at most. */
export function normalizeMemory(raw) {
  const stops = [];
  for (const stop of Array.isArray(raw?.stops) ? raw.stops.slice(0, 10) : []) {
    const valid =
      STOP_KINDS.includes(stop?.kind) &&
      typeof stop.place === 'string' &&
      stop.place.length > 0 &&
      stop.place.length <= 300 &&
      !stops.some((s) => s.kind === stop.kind);
    if (valid) {
      stops.push({
        kind: stop.kind,
        place: stop.place,
        at: Number.isFinite(stop.at) ? stop.at : 0,
      });
    }
  }
  return { stops };
}
