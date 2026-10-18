// -----------------------------------------------------------------------------
// The integration: one HTTP session with the Comelit bridge, one with a Vedo
// IP when the alarm has its own address (src/comelit/client.js), short ICONA
// sessions with the intercom bridge for the doors (src/comelit/icona.js), the
// model they describe, the Gladys devices and states (src/devices.js), the
// scene events, the commands. index.js only wires the SDK handlers to it.
//
// Safety:
// - arming, disarming, setting a setpoint and opening a door are each off
//   unless the configuration allows them; an option is checked when the
//   command arrives, again in the queue, after the fresh read, before the
//   request is queued and once more right before it is written;
// - an alarm, shutter-stop or setpoint command decides on the state read from
//   the bridge right before it, never on the state in memory; one command at
//   a time per host;
// - a command is sent within 3.5 s of the request or not at all (Gladys
//   waits 5 s); one that may have reached the bridge is never reported "not
//   sent", but "sent, not confirmed", and the state is read again; only a
//   clear answer (an HTTP 4xx refusal) is a refusal;
// - the acks never wait for a publication to Gladys;
// - a refused PIN or token stops its session, persisted in /data, no new try
//   until the configuration changes or "Test the connection" is clicked;
// - every command, sent or refused, is logged; the PINs and the token never.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  bridgeKey,
  intercomKey,
  normalizeConfig,
  places,
  stopKeys,
  vedoKey,
  vedoSource,
} from './config.js';
import {
  ARM_ACTIONS,
  BUTTON_PUSH,
  COVER_STATE,
  DISARM_ACTION,
  LIMITS,
  SCENE_TRIGGERS,
  SHUTTER_STATUS,
  TIMINGS,
} from './constants.js';
import { buildDevices, buildStates, parseFeatureId } from './devices.js';
import { COMMAND_NAMES, T, fill, word } from './i18n.js';
import { ComelitClient } from './comelit/client.js';
import { IconaSession, listDoors, openDoor } from './comelit/icona.js';
import { parseClima, zoneFlags } from './comelit/pages.js';
import { ComelitError, nodeTransport } from './http.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A command refused before anything was sent. */
export class Refused extends Error {}

/** Command -> [config flag, refusal message, log name]. */
const OPTIONS = {
  arm: ['allowArm', T.armRefused, 'Arm'],
  disarm: ['allowDisarm', T.disarmRefused, 'Disarm'],
  setpoint: ['allowSetpoint', T.setpointRefused, 'Setpoint'],
  door: ['allowDoor', T.doorRefused, 'Door'],
};

const emptyModel = () => ({ bridge: undefined, vedo: undefined, doors: undefined });

const isButtonPush = (value) =>
  value === BUTTON_PUSH.PRESSED || value === String(BUTTON_PUSH.PRESSED);

/** A strict number: null, '', true and '1e' are not numbers. */
const strictNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
};

export class ComelitApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'comelit' }),
    transport = nodeTransport,
    connectIcona,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
    timings = TIMINGS,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.timings = timings;
    this.connectIcona = connectIcona;
    const options = { transport, timers, now, logger, timings };
    this.bridge = new ComelitClient({ kind: 'bridge', ...options });
    this.vedoClient = new ComelitClient({ kind: 'vedo', ...options });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.keys = undefined;
    this.model = emptyModel();
    this.bridgeOnline = false;
    this.vedoOnline = false;
    /** off (not set up), ok, down, refused. */
    this.vedoState = 'off';
    this.doorState = 'off';
    this.downInfo = {};
    this.memory = undefined;
    /** area -> { mode, until }: what the last Gladys command asked. */
    this.commanded = new Map();
    /** shutter -> { from, until }: a stop sent, not seen yet. */
    this.stopGuards = new Map();
    /** door -> until: a door opened from Gladys. */
    this.doorGuards = new Map();
    this.readBacks = new Set();
    this.doorTimer = undefined;
    this.doorFailures = 0;
    this.lastStatus = undefined;
    this.lastTransport = undefined;
    this.published = undefined;
    this.started = false;
    this.sweeper = undefined;
    this.queues = new Map();
    this.starting = Promise.resolve();
    this.pendingEvents = [];
    this.flushScheduled = false;
    this.wire(this.bridge, 'bridge');
    this.wire(this.vedoClient, 'vedo');
  }

  // Every model change is applied when a client emits it, in the order of
  // emission (session up, polled and fresh reads, session down); guard() only
  // queues what talks to Gladys (publication, scene events, status).
  wire(client, source) {
    client.on('up', ({ snapshot }) => {
      const events = this.applyUp(source, snapshot);
      this.guard(() => this.onUp(source, events));
    });
    client.on('down', (info) => {
      const wasOnline = source === 'bridge' ? this.bridgeOnline : this.vedoOnline;
      if (source === 'bridge') this.bridgeOnline = false;
      if (source === 'vedo' || vedoSource(this.config) === 'bridge') this.vedoOnline = false;
      this.downInfo[source] = info;
      this.guard(() => this.onDown(source, info, wasOnline));
    });
    client.on('status', ({ kind, status, val }) =>
      this.noteChange(() => this.applyStatus(kind, status, val)),
    );
    client.on('areas', ({ status }) => this.noteChange(() => this.applyAreas(status)));
    client.on('zones', ({ status }) => this.noteChange(() => this.applyZones(status)));
    client.on('vedo', (info) => {
      if (info.available) {
        const events = this.applyVedo(info.vedo, false);
        this.vedoOnline = true;
        this.vedoState = 'ok';
        this.guard(() => this.onVedoBack(events));
        return;
      }
      this.vedoOnline = false;
      this.vedoState = info.refused ? 'refused' : 'down';
      this.guard(() => this.onVedoLost(info));
    });
  }

  /** Client events run one after the other, in order. */
  guard(fn) {
    this.chain = (this.chain ?? Promise.resolve())
      .then(fn)
      .catch((err) => this.logger.error(`Comelit event failed: ${err.message}`));
    return this.chain;
  }

  get language() {
    return this.config.language;
  }

  error(entry, cause) {
    return new Error(word(entry, this.language), cause ? { cause } : undefined);
  }

  refused(entry) {
    return new Refused(word(entry, this.language));
  }

  /** The client that reads the alarm, if any. */
  alarmClient() {
    const source = vedoSource(this.config);
    if (source === 'bridge') return this.bridge;
    if (source === 'standalone') return this.vedoClient;
    return undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  async loadMemory() {
    if (this.memory) return this.memory;
    try {
      this.memory = normalizeMemory(await this.store.load());
    } catch {
      this.memory = normalizeMemory(null);
    }
    return this.memory;
  }

  async saveMemory() {
    try {
      await this.store.save(this.memory);
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.message}`);
    }
  }

  /** The place a stop of this kind belongs to, with the current configuration. */
  stopPlace(kind) {
    const at = places(this.config);
    if (kind === 'bridge_pin') return at.bridge;
    if (kind === 'icona_token') return at.intercom;
    return vedoSource(this.config) === 'standalone' ? at.vedo : at.bridge;
  }

  stopped(kind) {
    return Boolean(
      this.memory?.stops.some((s) => s.kind === kind && s.place === this.stopPlace(kind)),
    );
  }

  async persistStop(kind) {
    const memory = await this.loadMemory();
    memory.stops = memory.stops.filter((s) => s.kind !== kind);
    memory.stops.push({ kind, place: this.stopPlace(kind), at: this.now() });
    await this.saveMemory();
  }

  async liftStops(kinds) {
    const memory = await this.loadMemory();
    const before = memory.stops.length;
    memory.stops = memory.stops.filter((s) => !kinds.includes(s.kind));
    if (memory.stops.length !== before) await this.saveMemory();
  }

  /** Starts (or restarts); two starts never overlap (no leaked timer). */
  start(raw = {}) {
    const run = this.starting.then(() => this.startNow(raw));
    this.starting = run.catch(() => undefined);
    return run;
  }

  async startNow(raw = {}) {
    this.stop();
    this.rawConfig = raw;
    const next = normalizeConfig(raw);
    const before = places(this.config);
    const after = places(next);
    if (before.bridge !== after.bridge || before.vedo !== after.vedo) {
      // Another installation, maybe: what we knew no longer holds.
      this.model = { ...emptyModel(), doors: this.model.doors };
    }
    if (before.intercom !== after.intercom) this.model.doors = undefined;
    if (vedoSource(next) === 'none') this.model.vedo = undefined;
    if (!next.host) this.model.bridge = undefined;
    if (!next.intercomHost || !next.intercomToken) this.model.doors = undefined;
    this.config = next;
    this.keys = { bridge: bridgeKey(next), vedo: vedoKey(next), intercom: intercomKey(next) };
    this.stopKeys = stopKeys(next);
    this.bridgeOnline = false;
    this.vedoOnline = false;
    this.downInfo = {};
    for (const field of next.invalid) {
      this.logger.warn(`The ${field} of the configuration is not in the expected form: ignored`);
    }
    if (next.zoneErrors.length > 0) {
      this.logger.warn(`Zone kinds not understood: ${next.zoneErrors.join(', ')}`);
    }
    await this.loadMemory();
    await this.publishDevices();
    await this.publishStates();
    const problem = this.configProblem();
    if (problem) {
      await this.setStatus(false, problem);
      return;
    }
    const source = vedoSource(next);
    const vedoStopped = this.stopped('vedo_pin');
    this.vedoState = source === 'none' ? 'off' : vedoStopped ? 'refused' : 'down';
    if (next.host && this.stopped('bridge_pin')) {
      this.logger.warn(
        'Comelit bridge: it refused this PIN before: not sent again until the configuration changes or "Test the connection" is clicked',
      );
    } else if (next.host) {
      this.bridge.configure({
        host: next.host,
        port: next.port,
        pin: next.bridgePin,
        vedoPin: source === 'bridge' && !vedoStopped ? next.vedoPin : '',
        pollInterval: next.pollInterval,
      });
      this.bridge.start();
    }
    if (source === 'standalone' && vedoStopped) {
      this.logger.warn(
        'Comelit Vedo: it refused this PIN before: not sent again until the configuration changes or "Test the connection" is clicked',
      );
    } else if (source === 'standalone') {
      this.vedoClient.configure({
        host: next.vedoHost,
        port: next.vedoPort,
        pin: next.vedoPin,
        pollInterval: next.pollInterval,
      });
      this.vedoClient.start();
    }
    if (source === 'bridge' && vedoStopped) {
      this.logger.warn('Comelit Vedo: it refused this PIN before: the alarm is not read');
    }
    this.startIntercom();
    await this.refreshStatus();
    this.startSweeper();
  }

  startIntercom() {
    if (!this.config.intercomHost || !this.config.intercomToken) {
      this.doorState = 'off';
      return;
    }
    if (this.stopped('icona_token')) {
      this.doorState = 'refused';
      this.logger.warn(
        'Comelit intercom: it refused this token before: not sent again until the configuration changes or "Test the connection" is clicked',
      );
      return;
    }
    this.doorState = this.model.doors ? 'ok' : 'down';
    this.doorFailures = 0;
    this.refreshDoors().catch(() => undefined);
  }

  startSweeper() {
    if (this.sweeper) this.timers.clearInterval(this.sweeper);
    this.sweeper = this.timers.setInterval(
      () => this.guard(() => this.sweep()),
      this.timings.sweep,
    );
  }

  /**
   * Stops the sessions. `final` only when the container stops: a restart
   * (new address or PIN) keeps the alarm_triggered retries running.
   */
  stop({ final = false } = {}) {
    this.bridge.stop();
    this.vedoClient.stop();
    this.bridgeOnline = false;
    this.vedoOnline = false;
    this.publisher.stop({ final });
    if (this.sweeper) {
      this.timers.clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    if (this.doorTimer) {
      this.timers.clearTimeout(this.doorTimer);
      this.doorTimer = undefined;
    }
    this.doorGeneration = (this.doorGeneration ?? 0) + 1;
    for (const timer of this.readBacks) this.timers.clearTimeout(timer);
    this.readBacks.clear();
  }

  configProblem() {
    if (!this.config.host && !this.config.vedoHost && !this.config.intercomHost) return T.noHost;
    return undefined;
  }

  /** First connection to Gladys: start; a reconnection (Gladys restarted): resend everything. */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    // Gladys keeps the connection status and the discovered devices in memory.
    // The stops on refused secrets stay: a reconnection to Gladys is no reason to try again.
    this.published = undefined;
    this.lastTransport = undefined;
    this.lastStatus = undefined;
    await this.configUpdated(raw);
    await this.refreshStatus();
    this.publisher.forget();
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports();
  }

  /** A new address or secret reconnects (and lifts its stop); the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const nextStops = stopKeys(next);
    const changed = Object.keys(nextStops).filter(
      (kind) => nextStops[kind] !== this.stopKeys?.[kind],
    );
    const keys = { bridge: bridgeKey(next), vedo: vedoKey(next), intercom: intercomKey(next) };
    if (
      changed.length > 0 ||
      keys.bridge !== this.keys?.bridge ||
      keys.vedo !== this.keys?.vedo ||
      keys.intercom !== this.keys?.intercom
    ) {
      if (this.stopKeys) await this.liftStops(changed);
      return this.start(raw);
    }
    this.config = next;
    await this.publishDevices();
    await this.publishStates();
    await this.refreshStatus();
    return undefined;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The devices of the bridge shown in Gladys (a humidifier only is not one). */
  deviceCount() {
    const objects = this.model.bridge?.objects ?? {};
    const thermostats = [...(objects.thermostat?.values() ?? [])].filter(
      (object) => parseClima(object.val)?.thermostat !== false,
    ).length;
    return (
      ['light', 'plug', 'shutter'].reduce((sum, kind) => sum + (objects[kind]?.size ?? 0), 0) +
      thermostats
    );
  }

  /** The connection status: (false, why) when a main session is down, else (true, parts). */
  status() {
    const problem = this.configProblem();
    if (problem) return [false, problem];
    const c = this.config;
    const source = vedoSource(c);
    const down = (what, info) => {
      const reason = info?.reason ?? '…';
      const seconds = Math.round((info?.retryIn ?? 0) / 1000);
      return {
        fr: T.unreachable.fr(what.fr, reason, seconds),
        en: T.unreachable.en(what.en, reason, seconds),
      };
    };
    const BRIDGE = { fr: 'Pont', en: 'Bridge' };
    const VEDO = { fr: 'Vedo', en: 'Vedo' };
    const parts = { fr: [], en: [] };
    const add = (entry) => {
      parts.fr.push(word(entry, 'fr'));
      parts.en.push(word(entry, 'en'));
    };
    if (c.host) {
      if (this.stopped('bridge_pin')) return [false, T.bridgeRefused];
      if (!this.bridgeOnline) {
        return [false, this.downInfo.bridge ? down(BRIDGE, this.downInfo.bridge) : T.connecting];
      }
      add(fill(T.partBridge, this.deviceCount()));
    }
    if (source === 'standalone') {
      if (this.stopped('vedo_pin')) return [false, T.vedoRefused];
      if (!this.vedoOnline) {
        return [false, this.downInfo.vedo ? down(VEDO, this.downInfo.vedo) : T.connecting];
      }
    }
    if (source !== 'none') {
      if (this.vedoState === 'refused') add(T.partVedoRefused);
      else if (this.vedoOnline && this.model.vedo) {
        add(fill(T.partVedo, this.model.vedo.areas.size, this.model.vedo.zones.size));
      } else add(T.partVedoDown);
    }
    if (c.intercomHost && c.intercomToken) {
      if (this.doorState === 'refused') add(T.partDoorsRefused);
      else if (this.doorState === 'ok') add(fill(T.partDoors, this.model.doors?.size ?? 0));
      else add(T.partDoorsDown);
    }
    if (parts.en.length === 0) return [false, T.noHost];
    return [true, { fr: T.connected.fr(parts.fr), en: T.connected.en(parts.en) }];
  }

  refreshStatus() {
    const [connected, message] = this.status();
    return this.setStatus(connected, message);
  }

  // --- Client events ---------------------------------------------------------

  /** The model of a new session, applied at once: the events it means. */
  applyUp(source, snapshot) {
    let events = [];
    if (source === 'bridge') {
      this.model.bridge = { objects: snapshot.objects };
      this.bridgeOnline = true;
      for (const [index, object] of snapshot.objects.shutter ?? []) {
        this.checkStopGuard(index, object.status);
      }
      if (vedoSource(this.config) === 'bridge') {
        if (snapshot.vedo) {
          events = this.applyVedo(snapshot.vedo, false);
          this.vedoOnline = true;
          this.vedoState = 'ok';
        } else if (this.vedoState !== 'refused') {
          this.vedoState = 'down';
        }
      }
    } else {
      events = this.applyVedo(snapshot.vedo, true);
      this.vedoOnline = true;
      this.vedoState = 'ok';
    }
    return events;
  }

  /** A full read of the alarm (description and statuses): the events it means. */
  applyVedo(vedo, standalone) {
    const events = [];
    const areas = new Map();
    for (const [index, area] of vedo.areas) {
      const status = vedo.areaStatus.get(index);
      const before = this.model.vedo?.areas.get(index)?.status;
      events.push(...this.transitions(index, before, status));
      areas.set(index, { ...area, status });
    }
    const zones = new Map();
    for (const [index, zone] of vedo.zones) {
      zones.set(index, { ...zone, status: vedo.zoneStatus[index] });
    }
    this.model.vedo = { areas, zones, standalone };
    return events;
  }

  async onUp(source, events) {
    await this.publishDevices();
    await this.publishStates();
    await this.refreshStatus();
    await this.publishTransports();
    for (const event of events) await this.effect(event);
  }

  async onDown(source, { reason, retryIn, refused }, wasOnline) {
    const seconds = Math.round((retryIn ?? 0) / 1000);
    if (refused) {
      const kind = source === 'bridge' ? 'bridge_pin' : 'vedo_pin';
      this.logger.error(`Comelit ${source}: PIN refused, connection stopped (no new try)`);
      await this.persistStop(kind);
      if (kind === 'vedo_pin') this.vedoState = 'refused';
    } else {
      this.logger.warn(`Comelit ${source}: ${reason}; next try in ${seconds} s`);
    }
    await this.refreshStatus();
    if (wasOnline || this.lastTransport !== undefined) {
      await this.publishStates();
      await this.publishTransports();
    }
  }

  async onVedoBack(events) {
    await this.publishDevices();
    await this.publishStates();
    await this.refreshStatus();
    await this.publishTransports();
    for (const event of events) await this.effect(event);
  }

  async onVedoLost(info) {
    if (info.refused) await this.persistStop('vedo_pin');
    await this.refreshStatus();
    await this.publishStates();
    await this.publishTransports();
  }

  /**
   * A change read from the bridge, applied to the model at once and in order;
   * an object the bridge did not give at the discovery is ignored right here.
   * The publication, the scene events and the status follow once per turn of
   * the event loop, however many reads came in it.
   */
  noteChange(apply) {
    const events = apply();
    if (events === null) return;
    this.pendingEvents.push(...events);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.guard(() => this.flushChanges());
    });
  }

  async flushChanges() {
    const events = this.pendingEvents.splice(0);
    await this.publishStates();
    for (const event of events) await this.effect(event);
  }

  applyStatus(kind, status, val) {
    const objects = this.model.bridge?.objects?.[kind];
    if (!objects) return null;
    for (const [index, object] of objects) {
      if (status[index] !== undefined) object.status = status[index];
      if (val[index] !== undefined) object.val = val[index];
      if (kind === 'shutter') this.checkStopGuard(index, object.status);
    }
    return [];
  }

  applyAreas(status) {
    if (!this.model.vedo) return null;
    const events = [];
    for (const [index, area] of this.model.vedo.areas) {
      const next = status.get(index);
      if (!next) continue;
      events.push(...this.transitions(index, area.status, next));
      area.status = next;
    }
    return events;
  }

  applyZones(status) {
    if (!this.model.vedo) return null;
    for (const [index, zone] of this.model.vedo.zones) {
      if (status[index] !== undefined) zone.status = status[index];
    }
    return [];
  }

  /** A stop guard falls when the bridge shows the shutter stopped (never its start state). */
  checkStopGuard(index, status) {
    const guard = this.stopGuards.get(index);
    if (guard && status === SHUTTER_STATUS.STOPPED && status !== guard.from) {
      this.stopGuards.delete(index);
    }
  }

  /** Nothing for the first status seen of an area after a start. */
  transitions(index, before, after) {
    if (!before || !after || before.mode === undefined || after.mode === undefined) return [];
    const events = [];
    if (before.mode !== after.mode) {
      events.push(
        after.mode === 'disarmed'
          ? { type: 'disarmed', area: index }
          : { type: 'armed', area: index, mode: after.mode },
      );
    }
    if (!before.alarm && after.alarm) events.push({ type: 'alarm', area: index });
    return events;
  }

  /** Whether a transition answers a Gladys command; the entry is used once. */
  byGladys(area, mode) {
    const asked = this.commanded.get(area);
    const match = Boolean(asked && asked.mode === mode && this.now() < asked.until);
    if (match) this.commanded.delete(area);
    return match;
  }

  /** The first zone in alarm (numbered from 1), if the Vedo shows one. */
  zoneInAlarm() {
    for (const [index, zone] of [...(this.model.vedo?.zones ?? new Map())].sort(
      ([a], [b]) => a - b,
    )) {
      if (zoneFlags(zone.status)?.alarm) return index + 1;
    }
    return undefined;
  }

  async effect(event) {
    const area = String(event.area + 1);
    const name = this.model.vedo?.areas.get(event.area)?.name ?? '';
    if (event.type === 'armed') {
      const byGladys = this.byGladys(event.area, event.mode);
      this.logger.info(
        `Vedo: area ${area} ARMED ${event.mode} (${byGladys ? 'Gladys command' : 'keypad or other'})`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.ARMED, {
        area,
        name,
        mode: event.mode,
        by_gladys: byGladys,
      });
    } else if (event.type === 'disarmed') {
      const byGladys = this.byGladys(event.area, 'disarmed');
      this.logger.info(
        `Vedo: area ${area} DISARMED (${byGladys ? 'Gladys command' : 'keypad or other'})`,
      );
      await this.publisher.sceneEvent(SCENE_TRIGGERS.DISARMED, {
        area,
        name,
        by_gladys: byGladys,
      });
    } else if (event.type === 'alarm') {
      const zone = this.zoneInAlarm();
      this.logger.warn(`Vedo: ALARM area ${area}${zone ? ` zone ${zone}` : ''}`);
      await this.publisher.sceneEvent(SCENE_TRIGGERS.ALARM_TRIGGERED, { area, name, zone });
    }
  }

  /** Heartbeats of the unchanged states; expired guards and memories go. */
  async sweep() {
    const now = this.now();
    for (const [id, guard] of this.stopGuards) if (now >= guard.until) this.stopGuards.delete(id);
    for (const [id, until] of this.doorGuards) if (now >= until) this.doorGuards.delete(id);
    for (const [id, asked] of this.commanded) if (now >= asked.until) this.commanded.delete(id);
    await this.publishStates();
  }

  // --- Gladys ----------------------------------------------------------------

  devices() {
    if (!this.model.bridge && !this.model.vedo && !this.model.doors) return undefined;
    return buildDevices(this.gladys, this.config, this.model);
  }

  async publishDevices({ force = false } = {}) {
    const devices = this.devices();
    if (!devices) return;
    const json = JSON.stringify(devices);
    if (json === this.published && !force) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
  }

  publishStates() {
    if (!this.model.bridge && !this.model.vedo) return Promise.resolve();
    return this.publisher.publish(
      buildStates(this.gladys, this.config, this.model, {
        bridgeOnline: this.bridgeOnline,
        vedoOnline: this.vedoOnline,
      }),
    );
  }

  /** Local when its session is up, unreachable otherwise; doors follow the intercom. */
  transportOf(externalId) {
    const kind = /:([a-z]+):[^:]+$/.exec(externalId)?.[1];
    const bridgeSide = ['bridge', 'light', 'plug', 'shutter', 'thermostat'].includes(kind);
    let up;
    if (bridgeSide) up = this.bridgeOnline;
    else if (kind === 'door') up = this.doorState === 'ok';
    else up = this.vedoOnline;
    return up ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE;
  }

  async publishTransports() {
    const devices = this.devices();
    if (!devices) return;
    const entries = devices.map((device) => ({
      external_id: device.external_id,
      transport: this.transportOf(device.external_id),
    }));
    const key = JSON.stringify(entries);
    if (key === this.lastTransport) return;
    try {
      // At most 100 entries per request.
      for (let i = 0; i < entries.length; i += 100) {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      }
      this.lastTransport = key;
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  async scan() {
    if (this.config.intercomHost && this.config.intercomToken && this.doorState !== 'refused') {
      this.refreshDoors().catch(() => undefined);
    }
    await this.publishDevices({ force: true });
  }

  /** The user created or updated a device: Gladys has none of its states yet, send them again. */
  async deviceChanged(device) {
    this.publisher.forget(device?.external_id);
    await this.publishStates();
  }

  // --- Intercom ----------------------------------------------------------------

  icona() {
    return {
      host: this.config.intercomHost,
      port: this.config.intercomPort,
      token: this.config.intercomToken,
      connect: this.connectIcona,
      timers: this.timers,
      logger: this.logger,
      timings: this.timings,
    };
  }

  /** Reads the doors of the intercom (in its queue); tries again later on a failure. */
  refreshDoors() {
    const generation = this.doorGeneration;
    return this.serial('door', async () => {
      if (generation !== this.doorGeneration || this.doorState === 'refused') return;
      try {
        const { doors } = await listDoors(this.icona());
        if (generation !== this.doorGeneration) return;
        this.model.doors = new Map(doors.map((door) => [door.id, { name: door.name }]));
        this.doorState = 'ok';
        this.doorFailures = 0;
        this.logger.info(`Comelit intercom: ${doors.length} door(s)`);
      } catch (err) {
        if (generation !== this.doorGeneration) return;
        if (err instanceof ComelitError && err.kind === 'refused') {
          this.doorState = 'refused';
          this.logger.error('Comelit intercom: token refused, stopped (no new try)');
          await this.persistStop('icona_token');
        } else {
          this.doorState = 'down';
          const retry = this.timings.iconaRetry;
          const wait = retry[Math.min(this.doorFailures, retry.length - 1)];
          this.doorFailures += 1;
          this.logger.warn(
            `Comelit intercom: doors not read (${err.message}); next try in ${Math.round(wait / 1000)} s`,
          );
          if (this.doorTimer) this.timers.clearTimeout(this.doorTimer);
          this.doorTimer = this.timers.setTimeout(() => {
            this.doorTimer = undefined;
            this.refreshDoors().catch(() => undefined);
          }, wait);
        }
      }
      this.guard(async () => {
        await this.publishDevices();
        await this.refreshStatus();
        await this.publishTransports();
      });
    });
  }

  // --- Commands --------------------------------------------------------------

  /** One command at a time per host; a failed one never blocks the next. */
  serial(queue, fn) {
    const previous = this.queues.get(queue) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.queues.set(
      queue,
      run.catch(() => undefined),
    );
    return run;
  }

  /** A press, a switch or a value from Gladys. */
  async setValue(_device, feature, value) {
    const target = parseFeatureId(feature?.external_id);
    const asked = this.now();
    if (!target) throw new Error(`${feature?.external_id} is read-only`);
    const { kind, index, key } = target;
    const button = (fn) => {
      if (!isButtonPush(value))
        throw new Error(`Unexpected value ${JSON.stringify(value)} for a button`);
      return fn();
    };
    if ((kind === 'light' || kind === 'plug') && key === 'state') {
      const number = strictNumber(value);
      if (number !== 0 && number !== 1) throw this.refused(fill(T.badValue, JSON.stringify(value)));
      return this.switchObject(kind, index, number === 1, asked);
    }
    if (kind === 'shutter' && key === 'state') {
      const number = strictNumber(value);
      const action = {
        [COVER_STATE.OPEN]: 'open',
        [COVER_STATE.CLOSE]: 'close',
        [COVER_STATE.STOP]: 'stop',
      }[number];
      if (number === undefined || !action)
        throw this.refused(fill(T.badValue, JSON.stringify(value)));
      return this.shutter(index, action, asked);
    }
    if (kind === 'thermostat' && key === 'setpoint') return this.setpoint(index, value, asked);
    if (kind === 'area' && key === 'arm-total')
      return button(() => this.arm(index, 'armed_total', asked));
    if (kind === 'area' && key === 'arm-p1')
      return button(() => this.arm(index, 'armed_p1', asked));
    if (kind === 'area' && key === 'arm-p12')
      return button(() => this.arm(index, 'armed_p12', asked));
    if (kind === 'area' && key === 'disarm') return button(() => this.disarm(index, asked));
    if (kind === 'door' && key === 'open') return button(() => this.door(index, asked));
    throw new Error(`${feature?.external_id} is read-only`);
  }

  isAllowed(command) {
    return Boolean(this.config[OPTIONS[command][0]]);
  }

  /** The option of a command, read again now; refused (nothing sent) once switched off. */
  checkAllowed(command, what) {
    if (this.isAllowed(command)) return;
    const option = OPTIONS[command];
    this.logger.warn(`${option[2]} REFUSED (${word(what, 'en')}): disabled in the configuration`);
    throw this.refused(option[1]);
  }

  /**
   * A state read from the bridge now; refused (nothing sent) when it cannot be
   * read in time. The read is withdrawn at sendBy if it is still waiting for
   * the line, so the refusal comes within Gladys' 5 s.
   */
  async fresh(client, read, asked) {
    if (!client.connected) throw this.refused(T.offline);
    const sendBy = asked + this.timings.sendBy;
    const left = sendBy - this.now();
    if (left < 200) throw this.refused(T.tooLate);
    const ticket = {};
    const timer = this.timers.setTimeout(() => {
      if (!ticket.written) ticket.cancel?.();
    }, left);
    try {
      // Before the polling requests in the queue.
      return await read({
        timeout: Math.min(this.timings.readBefore, left),
        sendBy,
        ticket,
        priority: true,
      });
    } catch (err) {
      if (err instanceof ComelitError && err.kind === 'late') throw this.refused(T.tooLate);
      if (err instanceof ComelitError && err.kind === 'offline') throw this.refused(T.offline);
      if (err instanceof ComelitError && err.kind === 'session')
        throw this.refused(T.sessionExpired);
      // Timeout, unexpected answer, lost session: unreadable.
      throw this.refused(T.stateUnknown);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /**
   * Sends a command. Resolves when the bridge accepted it (HTTP 200, or the
   * state read right after shows it done); throws Refused when nothing was
   * sent, an Error otherwise. Only a 4xx answer is a refusal (except 404 on
   * the new Vedo firmware, which answers 404 to every action, aiocomelit
   * says): any other outcome after the write (no answer, a 5xx, a lost
   * connection) is "sent, without confirmation", with onSent() and a read back.
   */
  async send(
    what,
    asked,
    run,
    { client, command, onSent = () => {}, readBack, confirm, vedo = false },
  ) {
    const label = word(what, 'en');
    if (this.now() > asked + this.timings.sendBy) {
      this.logger.warn(`Command NOT sent (${label}): too late`);
      throw this.refused(T.tooLate);
    }
    // The configuration may have changed while the command waited its turn.
    if (command) this.checkAllowed(command, what);
    const ticket = {};
    // …and once more right before the socket write.
    const request = run({
      sendBy: asked + this.timings.sendBy,
      ticket,
      timeout: Math.max(500, asked + this.timings.answerBy - this.now()),
      check: command ? () => this.isAllowed(command) : undefined,
    });
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(
        () => resolve('late'),
        Math.max(0, asked + this.timings.answerBy - this.now()),
      );
    });
    let outcome;
    try {
      outcome = await Promise.race([request, late]);
    } catch (err) {
      if (err instanceof ComelitError && !err.sent) {
        this.logger.warn(`Command NOT sent (${label}): ${err.message}`);
        if (err.kind === 'withdrawn' && command) this.checkAllowed(command, what);
        throw this.refused(err.kind === 'late' ? T.tooLate : T.offline);
      }
      this.logger.warn(`Command sent, NOT confirmed (${label}): ${err.message}`);
      onSent();
      this.scheduleReadBack(client, readBack);
      throw this.error(fill(T.unconfirmed, word(what, this.language)), err);
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (outcome === 'late') {
      if (!ticket.written && ticket.cancel()) {
        this.logger.warn(`Command NOT sent (${label}): the line stayed busy`);
        throw this.refused(T.tooLate);
      }
      onSent();
      request.then(
        (res) => this.logger.info(`Command answered late (${label}): HTTP ${res.status}`),
        (err) => this.logger.warn(`Command not confirmed (${label}): ${err.message}`),
      );
      this.scheduleReadBack(client, readBack);
      this.logger.warn(`Command sent, NOT confirmed in time (${label})`);
      throw this.error(fill(T.unconfirmed, word(what, this.language)));
    }
    const { status } = outcome;
    const newFirmware = vedo && client.newFirmware;
    if (status === 200) {
      onSent();
      this.logger.info(`Command accepted by the bridge (${label})`);
      this.scheduleReadBack(client, readBack);
      return;
    }
    if (status >= 400 && status < 500 && !(newFirmware && status === 404)) {
      this.logger.warn(`Command REFUSED by the bridge (${label}): HTTP ${status}`);
      this.scheduleReadBack(client, readBack);
      throw this.error(fill(T.refusedByBridge, word(what, this.language), status));
    }
    onSent();
    if (confirm && (await this.confirmed(client, confirm, asked))) {
      this.logger.info(`Command sent (HTTP ${status}), confirmed by the state read (${label})`);
      return;
    }
    this.logger.warn(`Command sent, NOT confirmed (${label}): HTTP ${status}`);
    this.scheduleReadBack(client, readBack);
    throw this.error(fill(T.unconfirmed, word(what, this.language)));
  }

  /** A read right after an unclear answer, when there is time left: true when it shows the result. */
  async confirmed(client, confirm, asked) {
    const left = asked + this.timings.answerBy - this.now();
    if (left < 300) return false;
    try {
      // Bounded: the ack never waits past answerBy for a read stuck in the queue.
      let timer;
      const late = new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve(false), left - 50);
      });
      const read = confirm({ timeout: left - 100, priority: true });
      read.catch(() => undefined);
      const result = await Promise.race([read, late]);
      this.timers.clearTimeout(timer);
      return Boolean(result);
    } catch {
      return false;
    }
  }

  scheduleReadBack(client, readBack) {
    if (!readBack) return;
    const timer = this.timers.setTimeout(() => {
      this.readBacks.delete(timer);
      if (!client.connected) return;
      readBack().catch((err) => this.logger.debug(`Read back failed: ${err.message}`));
    }, this.timings.readBack);
    this.readBacks.add(timer);
  }

  bridgeObject(kind, index) {
    const object = this.model.bridge?.objects?.[kind]?.get(index);
    if (!object) throw this.refused(fill(T.unknownObject, `${kind} ${index + 1}`));
    return object;
  }

  /** A light or a plug: an absolute command, no state needed before it. */
  async switchObject(kind, index, on, asked) {
    const object = this.bridgeObject(kind, index);
    const what = fill(COMMAND_NAMES.light, object.name || `${kind} ${index + 1}`, on);
    return this.serial('bridge', async () => {
      if (!this.bridge.connected) throw this.refused(T.offline);
      this.logger.info(`Comelit: ${word(what, 'en')}`);
      await this.send(
        what,
        asked,
        (options) => this.bridge.deviceAction(kind, index, on ? 1 : 0, options),
        {
          client: this.bridge,
          readBack: () => this.bridge.readStatus(kind),
        },
      );
    });
  }

  /**
   * A shutter, decided on its status read now. The bridge stops a moving
   * shutter on a command in the other direction (as Home Assistant's stop
   * does): open while closing is refused (it would stop, not open); stop
   * sends the reverse of the movement read, and no second stop goes until the
   * bridge shows it stopped (a second one would start it the other way).
   */
  async shutter(index, action, asked) {
    const object = this.bridgeObject('shutter', index);
    const what = fill(COMMAND_NAMES.shutter, object.name || `shutter ${index + 1}`, action);
    return this.serial('bridge', async () => {
      const read = await this.fresh(
        this.bridge,
        (options) => this.bridge.readStatus('shutter', options),
        asked,
      );
      const status = read.status[index];
      if (!Object.values(SHUTTER_STATUS).includes(status)) throw this.refused(T.stateUnknown);
      this.checkStopGuard(index, status);
      let num;
      if (action === 'open' || action === 'close') {
        const same = action === 'open' ? SHUTTER_STATUS.OPENING : SHUTTER_STATUS.CLOSING;
        const opposite = action === 'open' ? SHUTTER_STATUS.CLOSING : SHUTTER_STATUS.OPENING;
        if (status === same) {
          this.logger.info(`Shutter ${index + 1} already moving that way: nothing sent`);
          return;
        }
        if (status === opposite) {
          this.logger.warn(`Shutter REFUSED (${word(what, 'en')}): it moves the other way`);
          throw this.refused(T.shutterOpposite);
        }
        num = action === 'open' ? 1 : 0;
      } else {
        if (status === SHUTTER_STATUS.STOPPED) {
          this.logger.info(`Shutter ${index + 1} already stopped: nothing sent`);
          return;
        }
        const guard = this.stopGuards.get(index);
        if (guard && this.now() < guard.until) {
          this.logger.warn(
            `Shutter REFUSED (${word(what, 'en')}): the previous stop is not seen yet`,
          );
          throw this.refused(T.stopPending);
        }
        num = status === SHUTTER_STATUS.CLOSING ? 1 : 0;
      }
      this.logger.info(`Comelit: ${word(what, 'en')}`);
      await this.send(
        what,
        asked,
        (options) => this.bridge.deviceAction('shutter', index, num, options),
        {
          client: this.bridge,
          onSent: () => {
            if (action === 'stop') {
              this.stopGuards.set(index, {
                from: status,
                until: this.now() + this.timings.stopGuard,
              });
            }
          },
          readBack: () => this.bridge.readStatus('shutter'),
        },
      );
    });
  }

  /** A setpoint, behind its option, decided on the thermostat read now. */
  async setpoint(index, raw, asked) {
    const object = this.bridgeObject('thermostat', index);
    const number = strictNumber(raw);
    if (number === undefined) throw this.refused(fill(T.badValue, JSON.stringify(raw)));
    const value = Math.round(number * 10) / 10;
    const what = fill(COMMAND_NAMES.setpoint, object.name || `thermostat ${index + 1}`, value);
    this.checkAllowed('setpoint', what);
    if (value < LIMITS.minSetpoint || value > LIMITS.maxSetpoint) {
      throw this.refused(fill(T.setpointRange, LIMITS.minSetpoint, LIMITS.maxSetpoint));
    }
    return this.serial('bridge', async () => {
      this.checkAllowed('setpoint', what);
      const read = await this.fresh(
        this.bridge,
        (options) => this.bridge.readStatus('thermostat', options),
        asked,
      );
      const clima = parseClima(read.val[index]);
      if (!clima || clima.mode === undefined || clima.automatic === undefined) {
        throw this.refused(T.stateUnknown);
      }
      if (clima.mode === 'O') throw this.refused(T.thermostatOff);
      if (clima.automatic) throw this.refused(T.thermostatAuto);
      if (clima.setpoint === value) {
        this.logger.info(`Thermostat ${index + 1} already at ${value} °C: nothing sent`);
        return;
      }
      this.checkAllowed('setpoint', what);
      this.logger.info(`Comelit: ${word(what, 'en')}`);
      await this.send(what, asked, (options) => this.bridge.climaSetpoint(index, value, options), {
        client: this.bridge,
        command: 'setpoint',
        readBack: () => this.bridge.readStatus('thermostat'),
      });
    });
  }

  vedoArea(index) {
    const area = this.model.vedo?.areas.get(index);
    if (!area) throw this.refused(fill(T.unknownObject, `area ${index + 1}`));
    return area;
  }

  alarmReady() {
    const client = this.alarmClient();
    if (!client?.vedoReady || !this.vedoOnline) throw this.refused(T.vedoOffline);
    return client;
  }

  async arm(index, mode, asked = this.now()) {
    if (!ARM_ACTIONS[mode]) throw new Error(`Unknown arming mode ${mode}`);
    const what = fill(COMMAND_NAMES[mode], index + 1);
    this.checkAllowed('arm', what);
    const area = this.vedoArea(index);
    if (mode === 'armed_p12' && !area.p2)
      throw this.refused(fill(T.unknownObject, `P2 ${index + 1}`));
    return this.serial('vedo', async () => {
      this.checkAllowed('arm', what);
      const client = this.alarmReady();
      const read = await this.fresh(client, (options) => client.readAreas(options), asked);
      const status = read.get(index);
      if (!status || status.mode === undefined) throw this.refused(T.stateUnknown);
      if (status.mode === mode) {
        this.logger.info(`Area ${index + 1} already ${mode}: nothing sent`);
        return;
      }
      if (status.exitDelay || status.entryDelay) {
        this.logger.warn(`Arm REFUSED (${word(what, 'en')}): a delay is running`);
        throw this.refused(T.delayInProgress);
      }
      if (status.mode !== 'disarmed') {
        this.logger.warn(`Arm REFUSED (${word(what, 'en')}): area ${index + 1} is ${status.mode}`);
        throw this.refused(T.otherMode);
      }
      if (status.alarm) {
        this.logger.warn(`Arm REFUSED (${word(what, 'en')}): alarm in progress`);
        throw this.refused(T.alarmInProgress);
      }
      this.checkAllowed('arm', what);
      this.logger.info(`ARMING from Gladys: ${word(what, 'en')}`);
      await this.send(
        what,
        asked,
        (options) => client.vedoAction(ARM_ACTIONS[mode], index, options),
        {
          client,
          command: 'arm',
          vedo: true,
          onSent: () =>
            this.commanded.set(index, { mode, until: this.now() + this.timings.commandMemory }),
          confirm: async (options) => {
            const now = (await client.readAreas(options)).get(index);
            return now && (now.mode === mode || now.exitDelay);
          },
          readBack: () => client.readAreas(),
        },
      );
    });
  }

  async disarm(index, asked = this.now()) {
    const what = fill(COMMAND_NAMES.disarm, index + 1);
    this.checkAllowed('disarm', what);
    this.vedoArea(index);
    return this.serial('vedo', async () => {
      this.checkAllowed('disarm', what);
      const client = this.alarmReady();
      const read = await this.fresh(client, (options) => client.readAreas(options), asked);
      const status = read.get(index);
      if (!status || status.mode === undefined) throw this.refused(T.stateUnknown);
      if (status.mode === 'disarmed' && !status.alarm && !status.exitDelay && !status.entryDelay) {
        this.logger.info(`Area ${index + 1} already disarmed: nothing sent`);
        return;
      }
      this.checkAllowed('disarm', what);
      this.logger.info(`DISARMING from Gladys: ${word(what, 'en')}`);
      await this.send(what, asked, (options) => client.vedoAction(DISARM_ACTION, index, options), {
        client,
        command: 'disarm',
        vedo: true,
        onSent: () =>
          this.commanded.set(index, {
            mode: 'disarmed',
            until: this.now() + this.timings.commandMemory,
          }),
        confirm: async (options) => {
          const now = (await client.readAreas(options)).get(index);
          return now && now.mode === 'disarmed' && !now.exitDelay;
        },
        readBack: () => client.readAreas(),
      });
    });
  }

  /**
   * Opens a door through the intercom bridge, behind its option. The door is
   * looked up in the configuration the bridge gives in the same session; the
   * option and the deadline are checked again right before the first opening
   * frame. The bridge gives no confirmation: all frames written is a success;
   * a failure after the first one is "sent, without confirmation". A door is
   * not opened again from Gladys for 10 s.
   */
  async door(id, asked = this.now()) {
    const door = this.model.doors?.get(id);
    const what = fill(COMMAND_NAMES.door, door?.name || `door ${id}`);
    this.checkAllowed('door', what);
    if (!door) throw this.refused(fill(T.unknownObject, `door ${id}`));
    if (this.doorState === 'refused' || !this.config.intercomToken)
      throw this.refused(T.intercomOff);
    return this.serial('door', async () => {
      this.checkAllowed('door', what);
      const label = word(what, 'en');
      const until = this.doorGuards.get(id);
      if (until !== undefined && this.now() < until) {
        this.logger.warn(`Door REFUSED (${label}): opened less than 10 s ago`);
        throw this.refused(T.doorPending);
      }
      const sendBy = asked + this.timings.sendBy;
      if (this.now() > sendBy) throw this.refused(T.tooLate);
      let sent = false;
      const ready = () => {
        if (this.now() > sendBy) throw new ComelitError('too late', 'late');
        if (!this.isAllowed('door')) throw new ComelitError('not allowed any more', 'withdrawn');
      };
      const icona = this.icona();
      const session = new IconaSession(icona);
      this.logger.info(`DOOR from Gladys: ${label}`);
      const run = openDoor({
        ...icona,
        session,
        doorId: id,
        ready,
        onSent: () => {
          sent = true;
          this.doorGuards.set(id, this.now() + this.timings.doorGuard);
        },
      });
      let timer;
      const late = new Promise((resolve) => {
        timer = this.timers.setTimeout(
          () => resolve('late'),
          Math.max(0, asked + this.timings.answerBy - this.now()),
        );
      });
      let outcome;
      try {
        outcome = await Promise.race([run, late]);
      } catch (err) {
        outcome = err;
      } finally {
        this.timers.clearTimeout(timer);
      }
      if (outcome === 'late') {
        // The sequence stops here: nothing more is written after the answer.
        run.catch(() => undefined);
        session.close();
        if (!sent) {
          this.logger.warn(`Door NOT opened (${label}): the intercom was too slow`);
          throw this.refused(T.tooLate);
        }
        this.logger.warn(`Door sent, NOT confirmed in time (${label})`);
        throw this.error(fill(T.doorUnconfirmed, word(what, this.language)));
      }
      if (!(outcome instanceof Error)) {
        this.logger.info(`Door opening sent (${label}); the intercom bridge gives no confirmation`);
        return;
      }
      const err = outcome;
      if (err instanceof ComelitError && err.kind === 'refused') {
        this.doorState = 'refused';
        this.logger.error('Comelit intercom: token refused, stopped (no new try)');
        await this.persistStop('icona_token');
        this.guard(() => this.refreshStatus());
        throw this.error(T.intercomRefused);
      }
      if (!sent) {
        this.logger.warn(`Door NOT opened (${label}): ${err.message}`);
        if (err.kind === 'withdrawn') this.checkAllowed('door', what);
        if (err.kind === 'missing') throw this.refused(fill(T.unknownObject, `door ${id}`));
        throw this.refused(err.kind === 'late' ? T.tooLate : T.offline);
      }
      this.logger.warn(`Door sent, NOT confirmed (${label}): ${err.message}`);
      throw this.error(fill(T.doorUnconfirmed, word(what, this.language)), err);
    });
  }

  // --- Configuration button ----------------------------------------------------

  /** Waits for a client's session to come up or go down, at most `timeout` ms. */
  waitFor(client, timeout) {
    if (client.connected) return Promise.resolve('up');
    return new Promise((resolve) => {
      const done = (result) => {
        client.off('up', onUp);
        client.off('down', onDown);
        this.timers.clearTimeout(timer);
        resolve(result);
      };
      const onUp = () => done('up');
      const onDown = () => done('down');
      const timer = this.timers.setTimeout(() => done('timeout'), timeout);
      client.on('up', onUp);
      client.on('down', onDown);
    });
  }

  /**
   * "Test the connection": lifts every stop, starts the sessions that are not
   * up (a session up is kept), reads the doors again, tells what was found.
   */
  async testConnection() {
    const problem = this.configProblem();
    if (problem) throw this.error(problem);
    await this.liftStops(['bridge_pin', 'vedo_pin', 'icona_token']);
    const source = vedoSource(this.config);
    const restart =
      (this.config.host && !this.bridge.connected) ||
      (source === 'standalone' && !this.vedoClient.connected) ||
      (source === 'bridge' && this.vedoState !== 'ok');
    if (restart) {
      await this.setStatus(false, T.connecting);
      await this.start(this.rawConfig ?? (await this.gladys.getConfig()));
    } else {
      this.startIntercom();
    }
    const waits = [];
    if (this.config.host) waits.push(this.waitFor(this.bridge, this.timings.testWait));
    if (source === 'standalone') waits.push(this.waitFor(this.vedoClient, this.timings.testWait));
    const results = await Promise.all(waits);
    await this.queues.get('door');
    await this.chain;
    if (results.includes('timeout')) throw this.error(T.stillConnecting);
    const [connected, message] = this.status();
    if (!connected) throw this.error(message);
    return message;
  }
}
