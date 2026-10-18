// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, ICONA_PORT, LIMITS, ZONE_KINDS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  port: DEFAULT_PORT,
  vedo_port: DEFAULT_PORT,
  poll_interval: 10,
  allow_setpoint: false,
  allow_arm: false,
  allow_disarm: false,
  intercom_port: ICONA_PORT,
  allow_door: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return value !== null && value !== '' && value !== undefined && Number.isFinite(number)
    ? Math.round(Math.max(min, Math.min(max, number)))
    : fallback;
};

/** `192.168.1.40`, `bridge.lan:8080`, `http://192.168.1.40/` -> { host, port? }. */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9][a-z0-9.-]{0,252})(?::(\d{1,5}))?$/i.exec(text);
  if (!match) return { host: '' };
  const port = match[2] ? Number(match[2]) : undefined;
  return {
    host: match[1].replace(/^\[|\]$/g, ''),
    port: port >= 1 && port <= 65535 ? port : undefined,
  };
}

/** A PIN of the bridge or of the Vedo: 1 to 16 digits, '' when absent or malformed. */
export const normalizePin = (raw) => {
  const text = String(raw ?? '').trim();
  return /^\d{1,16}$/.test(text) ? text : '';
};

/** The ICONA user token: 8 to 256 visible ASCII characters, '' otherwise. */
export const normalizeToken = (raw) => {
  const text = String(raw ?? '').trim();
  return /^[\x21-\x7e]{8,256}$/.test(text) ? text : '';
};

/**
 * How the Vedo zones show: `3:motion, 5:smoke, 10-12:motion` -> Map(zone ->
 * kind), zones numbered from 1 as in the Comelit app. Entries are separated
 * by commas, semicolons or new lines; `=` works like `:`. Wrong entries are
 * reported, not fatal. A zone not listed is an opening.
 */
export function parseZoneKinds(raw) {
  const kinds = new Map();
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\n]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const match = /^(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*[:=]\s*([a-z]+)$/i.exec(text);
    const kind = match?.[3].toLowerCase();
    const from = Number(match?.[1]);
    const to = match?.[2] ? Number(match[2]) : from;
    if (!match || !ZONE_KINDS.includes(kind) || from < 1 || to > LIMITS.maxZones || to < from) {
      errors.push(text);
      continue;
    }
    for (let zone = from; zone <= to; zone += 1) kinds.set(zone, kind);
  }
  return { kinds, errors };
}

/** A secret typed but not usable: reported once, never logged. */
const typed = (raw) => String(raw ?? '').trim() !== '';

export function normalizeConfig(raw = {}) {
  const bridge = parseHost(raw?.host);
  const vedo = parseHost(raw?.vedo_host);
  const intercom = parseHost(raw?.intercom_host);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const zones = parseZoneKinds(raw?.zone_kinds);
  const bridgePin = normalizePin(raw?.bridge_pin);
  const vedoPin = normalizePin(raw?.vedo_pin);
  const token = normalizeToken(raw?.intercom_token);
  return {
    host: bridge.host,
    // A port typed with the address wins over the port field (which has a default).
    port: bridge.port ?? integer(raw?.port, DEFAULTS.port, 1, 65535),
    bridgePin,
    vedoHost: vedo.host,
    vedoPort: vedo.port ?? integer(raw?.vedo_port, DEFAULTS.vedo_port, 1, 65535),
    vedoPin,
    intercomHost: intercom.host,
    intercomPort: intercom.port ?? integer(raw?.intercom_port, DEFAULTS.intercom_port, 1, 65535),
    intercomToken: token,
    invalid: [
      typed(raw?.bridge_pin) && !bridgePin && 'bridge_pin',
      typed(raw?.vedo_pin) && !vedoPin && 'vedo_pin',
      typed(raw?.intercom_token) && !token && 'intercom_token',
    ].filter(Boolean),
    zoneKinds: zones.kinds,
    zoneErrors: zones.errors,
    pollInterval: integer(raw?.poll_interval, DEFAULTS.poll_interval, 5, 300) * 1000,
    allowSetpoint: bool(raw?.allow_setpoint, DEFAULTS.allow_setpoint),
    allowArm: bool(raw?.allow_arm, DEFAULTS.allow_arm),
    allowDisarm: bool(raw?.allow_disarm, DEFAULTS.allow_disarm),
    allowDoor: bool(raw?.allow_door, DEFAULTS.allow_door),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/**
 * Where the alarm is read: through the bridge (no Vedo address) or on a Vedo
 * IP of its own; none without a Vedo PIN.
 */
export const vedoSource = (config) => {
  if (!config.vedoPin) return 'none';
  return config.vedoHost ? 'standalone' : config.host ? 'bridge' : 'none';
};

/** What a session depends on: a change reconnects (and lifts the stops of that session). */
export const bridgeKey = (config) =>
  JSON.stringify([
    config.host,
    config.port,
    config.bridgePin,
    vedoSource(config) === 'bridge' ? config.vedoPin : '',
    config.pollInterval,
  ]);

export const vedoKey = (config) =>
  JSON.stringify(
    vedoSource(config) === 'standalone'
      ? [config.vedoHost, config.vedoPort, config.vedoPin, config.pollInterval]
      : [],
  );

export const intercomKey = (config) =>
  JSON.stringify([config.intercomHost, config.intercomPort, config.intercomToken]);

/**
 * What each persisted stop depends on: a stop is lifted when its address or
 * its secret changes, never by another setting (a poll interval saved again
 * must not send a refused PIN again).
 */
export const stopKeys = (config) => ({
  bridge_pin: JSON.stringify([config.host, config.port, config.bridgePin]),
  vedo_pin: JSON.stringify([
    vedoSource(config),
    config.host,
    config.port,
    config.vedoHost,
    config.vedoPort,
    config.vedoPin,
  ]),
  icona_token: JSON.stringify([config.intercomHost, config.intercomPort, config.intercomToken]),
});

/** Where a session goes, without its secret: what a persisted stop is tied to. */
export const places = (config) => ({
  bridge: `${config.host}:${config.port}`,
  vedo: `${config.vedoHost}:${config.vedoPort}`,
  intercom: `${config.intercomHost}:${config.intercomPort}`,
});
