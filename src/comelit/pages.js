// -----------------------------------------------------------------------------
// The JSON pages of the Comelit Serial Bridge and of the Vedo, read as
// aiocomelit 3.0.0 reads them (src/aiocomelit/api.py, devices/bridge.py,
// const.py; Apache-2.0, see THIRD_PARTY_NOTICES.md). Pure functions: a page
// in, plain values out, every field checked (a field missing or of the wrong
// type is an error, never a guess). Arrays are only read by index; nothing
// from the bridge becomes an object key.
// -----------------------------------------------------------------------------

import { ARMED_LEVELS, LIMITS, ZONE_BITS } from '../constants.js';
import { ComelitError } from '../http.js';
import { own, safeJson } from '../json.js';

/** The page as an object, or a ComelitError `answer` (sent: true, it was a read). */
export function parsePage(text, what) {
  let data;
  try {
    data = safeJson(text);
  } catch {
    throw new ComelitError(`${what}: not JSON`, 'answer', { sent: true });
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ComelitError(`${what}: not an object`, 'answer', { sent: true });
  }
  return data;
}

const bad = (what) => new ComelitError(`${what}: unexpected content`, 'answer', { sent: true });

/** An array field, bounded. */
function list(data, key, what, max = LIMITS.maxObjects) {
  const value = own(data, key);
  if (!Array.isArray(value) || value.length > max) throw bad(`${what}.${key}`);
  return value;
}

const text = (value, max = 64) =>
  typeof value === 'string'
    ? value
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, max)
    : '';

const int = (value) => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,9}$/.test(value.trim())) return Number(value.trim());
  return undefined;
};

const flag = (value) => {
  const n = int(value);
  if (n === undefined && typeof value === 'boolean') return value;
  return n === undefined ? undefined : n !== 0;
};

/**
 * `login.json` of the bridge: logged in when `domus` is not twelve zeros
 * (aiocomelit `_check_logged_in`).
 */
export function bridgeLogged(data) {
  const domus = own(data, 'domus');
  if (typeof domus !== 'string') throw bad('login.json.domus');
  return domus !== '000000000000';
}

/** Any Vedo page: `logged` is 1 while the alarm session lives. */
export const vedoLogged = (data) => int(own(data, 'logged')) === 1;

/**
 * `user/icon_desc.json?type=<t>`: the objects of one type, index -> { name,
 * room, status, val, protected }. Empty names are skipped (the bridge lists
 * placeholders, aiocomelit skips them too). An empty `desc` with `num` > 0
 * is an error (some old bridges answer so now and then: never read as "no
 * object").
 */
export function parseDescription(data, type) {
  const what = `icon_desc ${type}`;
  const num = int(own(data, 'num'));
  if (num === undefined || num < 0 || num > LIMITS.maxObjects) throw bad(`${what}.num`);
  const desc = list(data, 'desc', what);
  if (desc.length === 0 && num > 0) throw bad(`${what}.desc (empty)`);
  if (desc.length < num) throw bad(`${what}.desc`);
  const status = list(data, 'status', what);
  const val = own(data, 'val');
  const env = own(data, 'env');
  const envDesc = own(data, 'env_desc');
  const prot = own(data, 'protected');
  const objects = new Map();
  for (let i = 0; i < num; i += 1) {
    const name = text(desc[i]);
    if (name === '') continue;
    const room =
      Array.isArray(env) && Array.isArray(envDesc) && int(env[i]) !== undefined
        ? text(envDesc[int(env[i])])
        : '';
    objects.set(i, {
      name,
      room,
      status: int(status[i]),
      val: Array.isArray(val) ? val[i] : undefined,
      protected: Array.isArray(prot) ? flag(prot[i]) === true : false,
    });
  }
  return objects;
}

/** `user/icon_status.json?type=<t>`: { status: [...], val: [...] } by index. */
export function parseStatus(data, type) {
  const what = `icon_status ${type}`;
  const status = list(data, 'status', what).map(int);
  const val = own(data, 'val');
  return { status, val: Array.isArray(val) ? val.slice(0, LIMITS.maxObjects) : [] };
}

/**
 * The thermostat part of a `clima` value (aiocomelit and Home Assistant
 * `load_api_data`): `[[temp*10, active, mode O/L/U, A/M, setpoint*10, ...],
 * [humidity...]]`.
 */
export function parseClima(val) {
  const thermo = Array.isArray(val) ? val[0] : undefined;
  if (!Array.isArray(thermo)) return undefined;
  const temperature = int(thermo[0]);
  const setpoint = int(thermo[4]);
  const mode = typeof thermo[2] === 'string' ? thermo[2] : undefined;
  const auto = typeof thermo[3] === 'string' ? thermo[3] : undefined;
  return {
    temperature: temperature === undefined ? undefined : temperature / 10,
    setpoint: setpoint === undefined ? undefined : setpoint / 10,
    active: flag(thermo[1]),
    // O: off, L: cooling (lower), U: heating (upper).
    mode: ['O', 'L', 'U'].includes(mode) ? mode : undefined,
    // A: automatic (the program sets the target), M: manual.
    automatic: auto === 'A' ? true : auto === 'M' ? false : undefined,
    // A thermostat without temperature nor setpoint is a humidifier only.
    thermostat: !(temperature === 0 && setpoint === 0),
  };
}

/** `area_desc.json`: index -> { name, p1, p2 } for the areas present. */
export function parseAreaDescription(data) {
  const what = 'area_desc';
  const present = list(data, 'present', what, LIMITS.maxAreas);
  const desc = list(data, 'description', what, LIMITS.maxAreas);
  const p1 = own(data, 'p1_pres');
  const p2 = own(data, 'p2_pres');
  const areas = new Map();
  for (let i = 0; i < present.length; i += 1) {
    if (flag(present[i]) !== true) continue;
    areas.set(i, {
      name: text(desc[i]),
      p1: Array.isArray(p1) ? flag(p1[i]) === true : false,
      p2: Array.isArray(p2) ? flag(p2[i]) === true : false,
    });
  }
  return areas;
}

const AREA_FIELDS = [
  'ready',
  'armed',
  'alarm',
  'alarm_memory',
  'sabotage',
  'anomaly',
  'in_time',
  'out_time',
];

/**
 * `area_stat.json`: index -> the status of each area. `armed` is a level
 * (ARMED_LEVELS); a value outside them leaves the mode unknown.
 */
export function parseAreaStatus(data) {
  const what = 'area_stat';
  const fields = Object.fromEntries(
    AREA_FIELDS.map((key) => [key, list(data, key, what, LIMITS.maxAreas)]),
  );
  const areas = new Map();
  for (let i = 0; i < fields.armed.length; i += 1) {
    const level = int(fields.armed[i]);
    areas.set(i, {
      level,
      mode: level !== undefined && level >= 0 ? ARMED_LEVELS[level] : undefined,
      ready: flag(fields.ready[i]),
      alarm: flag(fields.alarm[i]),
      alarmMemory: flag(fields.alarm_memory[i]),
      sabotage: flag(fields.sabotage[i]),
      anomaly: flag(fields.anomaly[i]),
      entryDelay: flag(fields.in_time[i]),
      exitDelay: flag(fields.out_time[i]),
    });
  }
  return areas;
}

/**
 * The state of an area, in aiocomelit's order (`ALARM_AREA_STATUS`): exit
 * delay, entry delay, sabotage, triggered, armed, else disarmed.
 */
export function areaState(status) {
  if (!status) return 'unknown';
  if (status.exitDelay) return 'exit_delay';
  if (status.entryDelay) return 'entry_delay';
  if (status.sabotage) return 'sabotage';
  if (status.alarm) return 'triggered';
  if (status.mode === undefined) return 'unknown';
  return status.mode === 'disarmed' ? 'disarmed' : 'armed';
}

/** `zone_desc.json`: index -> { name } for the zones present. */
export function parseZoneDescription(data) {
  const what = 'zone_desc';
  let present = own(data, 'present');
  // aiocomelit reads a list; an older page may give "1,0,1".
  if (typeof present === 'string') present = present.split(',');
  if (!Array.isArray(present) || present.length > LIMITS.maxZones) throw bad(`${what}.present`);
  const desc = list(data, 'description', what, LIMITS.maxZones);
  const zones = new Map();
  for (let i = 0; i < present.length; i += 1) {
    if (flag(present[i]) !== true) continue;
    zones.set(i, { name: text(desc[i]) });
  }
  return zones;
}

/** `zone_stat.json`: `status` is "0x0000,0x0021,..." -> [number | undefined] by index. */
export function parseZoneStatus(data) {
  const status = own(data, 'status');
  if (typeof status !== 'string' || status.length > LIMITS.maxZones * 12) {
    throw bad('zone_stat.status');
  }
  return status
    .split(',')
    .map((part) => part.trim())
    .map((part) => (/^(0x)?[0-9a-f]{1,8}$/i.test(part) ? Number.parseInt(part, 16) : undefined));
}

/** The meaning of a zone status number (aiocomelit ALARM_ZONE_STATUS bits). */
export function zoneFlags(status) {
  if (status === undefined) return undefined;
  const has = (bit) => (status & bit) !== 0;
  return {
    open: has(ZONE_BITS.open),
    alarm: has(ZONE_BITS.alarm),
    faulty: has(ZONE_BITS.faulty),
    sabotage: has(ZONE_BITS.sabotage),
    excluded: has(ZONE_BITS.excluded) || has(ZONE_BITS.isolated),
    unavailable: has(ZONE_BITS.unavailable),
  };
}
