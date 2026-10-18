// -----------------------------------------------------------------------------
// The model -> Gladys devices and states (pure).
//
// Ids that do not depend on the address of the bridge (a new DHCP lease keeps
// the devices), keyed by the index the bridge or the Vedo gives each object
// (as the Home Assistant integration does); one installation per integration:
// - `ext:<sel>:bridge:comelit`, `ext:<sel>:vedo:comelit`: link only;
// - `ext:<sel>:light:<i>`, `plug:<i>`: `state` (light / switch, binary);
// - `ext:<sel>:shutter:<i>`: `state` (shutter, open / close / stop), never a
//   switch;
// - `ext:<sel>:thermostat:<i>`: `temperature` (read-only), `setpoint`;
// - `ext:<sel>:area:<i>`: `mode` (read-only text), `alarm`, `tamper`, and the
//   arm / disarm BUTTONS;
// - `ext:<sel>:zone:<i>`: one state feature keyed by the zone kind
//   (`:opening`, `:motion`, `:smoke` or `:leak`), `alarm`, `excluded`,
//   `tamper`;
// - `ext:<sel>:door:<apt-address>-<output>`: the `open` BUTTON (intercom),
//   keyed by the target it opens.
//
// No alarm or door command is a switch or a binary: a "turn everything off"
// (voice assistants, HomeKit, scenes on switches) must never reach them.
// Numbers shown to the user start at 1 (area 1 is index 0).
//
// A device published again never loses a feature the user created (Gladys
// would mark it changed, and "Update" would drop its history): the features
// of the created device that the bridge no longer gives are kept.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { COVER_STATE, LIMITS, OPENING_SENSOR_STATE, SHUTTER_STATUS } from './constants.js';
import { DEVICE_NAMES, FEATURE_NAMES, MODE_NAMES, word } from './i18n.js';
import { areaState, parseClima, zoneFlags } from './comelit/pages.js';

const binary = (category, type) => ({
  category,
  type,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});

const button = {
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
};

const command = (category, type, min, max, extra = {}) => ({
  category,
  type,
  min,
  max,
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...extra,
});

/** Feature definitions by key (the last part of their external id). Keys are forever. */
export const FEATURES = {
  online: binary(C.INPUT, T.INPUT.BINARY),
  light: command(C.LIGHT, T.LIGHT.BINARY, 0, 1),
  plug: command(C.SWITCH, T.SWITCH.BINARY, 0, 1),
  shutter: command(C.SHUTTER, T.SHUTTER.STATE, -1, 1, { keep_history: false }),
  temperature: {
    ...binary(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL),
    min: -20,
    max: 60,
    unit: U.CELSIUS,
  },
  setpoint: command(
    C.THERMOSTAT,
    T.THERMOSTAT.TARGET_TEMPERATURE,
    LIMITS.minSetpoint,
    LIMITS.maxSetpoint,
    { unit: U.CELSIUS },
  ),
};

export const AREA_FEATURES = {
  mode: {
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    // A text history is not charted; the armed / disarmed events are the history.
    keep_history: false,
  },
  alarm: binary(C.SIREN, T.SIREN.BINARY),
  tamper: binary(C.TAMPER, T.TAMPER.BINARY),
  'arm-total': button,
  'arm-p1': button,
  'arm-p12': button,
  disarm: button,
};

/** The state feature of a zone, by kind (the kind is also its feature key). */
export const ZONE_STATE = {
  opening: binary(C.OPENING_SENSOR, T.SENSOR.BINARY),
  motion: binary(C.MOTION_SENSOR, T.SENSOR.BINARY),
  smoke: binary(C.SMOKE_SENSOR, T.SENSOR.BINARY),
  leak: binary(C.LEAK_SENSOR, T.SENSOR.BINARY),
};

export const ZONE_FEATURES = {
  alarm: binary(C.SIREN, T.SIREN.BINARY),
  excluded: binary(C.INPUT, T.INPUT.BINARY),
  tamper: binary(C.TAMPER, T.TAMPER.BINARY),
};

const ZONE_FEATURE_NAMES = { alarm: 'zone-alarm', excluded: 'excluded', tamper: 'zone-tamper' };

export const ids = {
  bridge: (gladys) => gladys.externalIds('bridge', 'comelit'),
  vedo: (gladys) => gladys.externalIds('vedo', 'comelit'),
  object: (gladys, kind, index) => gladys.externalIds(kind, String(index)),
};

const KINDS = ['light', 'plug', 'shutter', 'thermostat', 'area', 'zone', 'door'];

/**
 * `ext:sel:area:0:arm-total` -> { kind: 'area', index: 0, key: 'arm-total' };
 * `ext:sel:door:SB100001-2:open` -> { kind: 'door', door: 'SB100001-2', key: 'open' }.
 */
export function parseFeatureId(externalId) {
  const text = String(externalId ?? '');
  const door = /:door:([0-9A-Za-z]{1,16}-\d{1,3}):([a-z]+)$/.exec(text);
  if (door) return { kind: 'door', door: door[1], key: door[2] };
  const match = /:([a-z]+):(\d{1,4}):([a-z0-9-]+)$/.exec(text);
  if (!match || !KINDS.includes(match[1]) || match[1] === 'door') return undefined;
  return { kind: match[1], index: Number(match[2]), key: match[3] };
}

/**
 * The id of a door: the target it opens (apartment address and output of
 * the intercom address book), never the slot of the book. A slot given to
 * another target is another device; the old one is refused as missing.
 */
export const doorKey = (door) => `${door.aptAddress}-${door.outputIndex}`;
const feature = (deviceIds, key, name, definition) => ({
  name,
  external_id: deviceIds.feature(key),
  ...definition,
});

const sorted = (map) => [...(map ?? new Map()).entries()].sort(([a], [b]) => a - b);

/** The kind of a zone: the configured one (zones numbered from 1), else an opening. */
export const zoneKind = (config, index) => config.zoneKinds.get(index + 1) ?? 'opening';

/** What a discovered feature declares (a created one also has ids, values, dates). */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'unit',
];

/** Adds to each device the features of its created twin it no longer has. */
export function keepCreatedFeatures(devices, created = []) {
  const byId = new Map((created ?? []).map((device) => [device.external_id, device]));
  return devices.map((device) => {
    const twin = byId.get(device.external_id);
    if (!twin?.features?.length) return device;
    const have = new Set(device.features.map((f) => f.external_id));
    const kept = twin.features
      .filter((f) => f?.external_id && !have.has(f.external_id))
      .map((f) =>
        Object.fromEntries(
          FEATURE_FIELDS.filter((key) => f[key] !== undefined && f[key] !== null).map((key) => [
            key,
            f[key],
          ]),
        ),
      );
    return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
  });
}

/** A thermostat of the bridge that is a humidifier only is left out (as Home Assistant). */
const isThermostat = (object) => parseClima(object.val)?.thermostat !== false;

export function buildDevices(gladys, config, model, created = gladys.devices) {
  const { language } = config;
  const devices = [];
  const params = (index, object, extra = []) => [
    { name: 'index', value: String(index) },
    ...(object.room ? [{ name: 'room', value: object.room }] : []),
    ...extra,
  ];
  if (model.bridge) {
    const bridgeIds = ids.bridge(gladys);
    devices.push({
      name: word(DEVICE_NAMES.bridge, language),
      external_id: bridgeIds.device,
      should_poll: false,
      params: [],
      features: [
        feature(bridgeIds, 'online', word(FEATURE_NAMES.online, language), FEATURES.online),
      ],
    });
    for (const kind of ['light', 'plug', 'shutter']) {
      for (const [index, object] of sorted(model.bridge.objects[kind])) {
        const objectIds = ids.object(gladys, kind, index);
        devices.push({
          name: object.name || word(DEVICE_NAMES[kind], language)(index + 1),
          external_id: objectIds.device,
          should_poll: false,
          params: params(index, object),
          features: [
            feature(objectIds, 'state', word(FEATURE_NAMES[kind], language), FEATURES[kind]),
          ],
        });
      }
    }
    for (const [index, object] of sorted(model.bridge.objects.thermostat)) {
      if (!isThermostat(object)) continue;
      const objectIds = ids.object(gladys, 'thermostat', index);
      devices.push({
        name: object.name || word(DEVICE_NAMES.thermostat, language)(index + 1),
        external_id: objectIds.device,
        should_poll: false,
        params: params(index, object),
        features: ['temperature', 'setpoint'].map((key) =>
          feature(objectIds, key, word(FEATURE_NAMES[key], language), FEATURES[key]),
        ),
      });
    }
  }
  if (model.vedo) {
    if (model.vedo.standalone) {
      const vedoIds = ids.vedo(gladys);
      devices.push({
        name: word(DEVICE_NAMES.vedo, language),
        external_id: vedoIds.device,
        should_poll: false,
        params: [],
        features: [
          feature(vedoIds, 'online', word(FEATURE_NAMES.online, language), FEATURES.online),
        ],
      });
    }
    for (const [index, area] of sorted(model.vedo.areas)) {
      const areaIds = ids.object(gladys, 'area', index);
      const keys = Object.keys(AREA_FEATURES).filter(
        (key) => (key !== 'arm-p12' || area.p2) && (key !== 'arm-p1' || area.p1),
      );
      devices.push({
        name: area.name || word(DEVICE_NAMES.area, language)(index + 1),
        external_id: areaIds.device,
        should_poll: false,
        params: [{ name: 'area', value: String(index + 1) }],
        features: keys.map((key) =>
          feature(areaIds, key, word(FEATURE_NAMES[key], language), AREA_FEATURES[key]),
        ),
      });
    }
    for (const [index, zone] of sorted(model.vedo.zones)) {
      const zoneIds = ids.object(gladys, 'zone', index);
      const kind = zoneKind(config, index);
      devices.push({
        name: zone.name || word(DEVICE_NAMES.zone, language)(index + 1),
        external_id: zoneIds.device,
        should_poll: false,
        params: [
          { name: 'zone', value: String(index + 1) },
          { name: 'kind', value: kind },
        ],
        features: [
          feature(zoneIds, kind, word(FEATURE_NAMES.kind[kind], language), ZONE_STATE[kind]),
          ...Object.entries(ZONE_FEATURES).map(([key, definition]) =>
            feature(
              zoneIds,
              key,
              word(FEATURE_NAMES[ZONE_FEATURE_NAMES[key]], language),
              definition,
            ),
          ),
        ],
      });
    }
  }
  const doors = [...(model.doors ?? new Map()).entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [key, door] of doors) {
    const doorIds = ids.object(gladys, 'door', key);
    devices.push({
      name: door.name || word(DEVICE_NAMES.door, language)(key),
      external_id: doorIds.device,
      should_poll: false,
      params: [{ name: 'door', value: key }],
      features: [feature(doorIds, 'open', word(FEATURE_NAMES.open, language), button)],
    });
  }
  return keepCreatedFeatures(devices, created);
}

const flag = (value) => (value ? 1 : 0);

const SHUTTER_STATE = {
  [SHUTTER_STATUS.STOPPED]: COVER_STATE.STOP,
  [SHUTTER_STATUS.OPENING]: COVER_STATE.OPEN,
  [SHUTTER_STATUS.CLOSING]: COVER_STATE.CLOSE,
};

/** The text of an area state. */
export const areaText = (status, language) => {
  const state = areaState(status);
  const key = ['exit_delay', 'entry_delay'].includes(state)
    ? state
    : status?.mode && MODE_NAMES[status.mode]
      ? status.mode
      : 'unknown';
  return word(MODE_NAMES[key], language);
};

/** Every known state: `[{ device_feature_external_id, state | text }]`. */
export function buildStates(gladys, config, model, { bridgeOnline, vedoOnline }) {
  const states = [];
  const push = (deviceIds, key, value) => {
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return;
    states.push({
      device_feature_external_id: deviceIds.feature(key),
      ...(typeof value === 'string' ? { text: value } : { state: value }),
    });
  };
  if (model.bridge) {
    push(ids.bridge(gladys), 'online', flag(bridgeOnline));
    for (const kind of ['light', 'plug']) {
      for (const [index, object] of sorted(model.bridge.objects[kind])) {
        const status = object.status;
        push(
          ids.object(gladys, kind, index),
          'state',
          status === undefined ? undefined : flag(status === 1),
        );
      }
    }
    for (const [index, object] of sorted(model.bridge.objects.shutter)) {
      push(ids.object(gladys, 'shutter', index), 'state', SHUTTER_STATE[object.status]);
    }
    for (const [index, object] of sorted(model.bridge.objects.thermostat)) {
      if (!isThermostat(object)) continue;
      const clima = parseClima(object.val);
      const objectIds = ids.object(gladys, 'thermostat', index);
      push(objectIds, 'temperature', clima?.temperature);
      push(objectIds, 'setpoint', clima?.setpoint);
    }
  }
  if (model.vedo) {
    if (model.vedo.standalone) push(ids.vedo(gladys), 'online', flag(vedoOnline));
    for (const [index, area] of sorted(model.vedo.areas)) {
      if (!area.status) continue;
      const areaIds = ids.object(gladys, 'area', index);
      push(areaIds, 'mode', areaText(area.status, config.language));
      push(areaIds, 'alarm', flag(area.status.alarm));
      push(areaIds, 'tamper', flag(area.status.sabotage));
    }
    for (const [index, zone] of sorted(model.vedo.zones)) {
      const flags = zoneFlags(zone.status);
      if (!flags) continue;
      const zoneIds = ids.object(gladys, 'zone', index);
      const kind = zoneKind(config, index);
      push(
        zoneIds,
        kind,
        kind === 'opening'
          ? flags.open
            ? OPENING_SENSOR_STATE.OPEN
            : OPENING_SENSOR_STATE.CLOSE
          : flag(flags.open),
      );
      push(zoneIds, 'alarm', flag(flags.alarm));
      push(zoneIds, 'excluded', flag(flags.excluded));
      push(zoneIds, 'tamper', flag(flags.sabotage));
    }
  }
  return states;
}
