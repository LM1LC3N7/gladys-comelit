// -----------------------------------------------------------------------------
// One HTTP session with a Comelit host, ported from aiocomelit 3.0.0
// (src/aiocomelit/api.py, devices/bridge.py, devices/vedo.py; Apache-2.0, see
// THIRD_PARTY_NOTICES.md):
// - kind `bridge`: the SimpleHome Serial Bridge (lights, shutters, other
//   objects, thermostats) and, with a Vedo PIN, the Vedo alarm behind it
//   (`user/vedo_*.json`, `alm=<PIN>`);
// - kind `vedo`: a Vedo IP alarm of its own (`user/*.json`, `code=<PIN>`).
//
// Changed from aiocomelit:
// - ONE request on the wire at a time per host, never two closer than 250 ms
//   (aiocomelit sleeps 0.25 s between Vedo calls only); commands and their
//   fresh reads go before the polling requests in the queue;
// - a refused PIN (no cookie, or still not logged in after a second look)
//   stops the logins: no new try until the configuration changes or "Test
//   the connection" is clicked. A refused Vedo PIN through the bridge stops
//   the alarm part only;
// - reconnection with growing waits (10 s to 5 min), never in a loop; a
//   discovery that fails fails the session (never a partial list);
// - an alarm read that fails (an endpoint of the bridge) never stops the
//   lights and shutters: the alarm shows offline and is read again next time;
// - a request that may have reached the host is reported `sent: true`.
//
// Events: 'up' { snapshot }, 'down' { reason, retryIn, refused, stopped },
// 'status' { kind, status, val }, 'areas' { status }, 'zones' { status },
// 'vedo' { available, refused, reason } (kind `bridge` only).
//
// The PINs and the session cookies are never logged.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { BRIDGE_TYPES, TIMINGS } from '../constants.js';
import { ComelitError, nodeTransport } from '../http.js';
import {
  bridgeLogged,
  parseAreaDescription,
  parseAreaStatus,
  parseDescription,
  parsePage,
  parseStatus,
  parseZoneDescription,
  parseZoneStatus,
  vedoLogged,
} from './pages.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** aiocomelit's headers (the bridge web pages expect an XHR from a browser). */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:78.0) Gecko/20100101 Firefox/78.0',
  'Accept-Language': 'en-GB,en;q=0.5',
  'X-Requested-With': 'XMLHttpRequest',
};

/** The order aiocomelit reads the object types in (CLIMATE, COVER, LIGHT, OTHER). */
const KINDS = ['thermostat', 'shutter', 'light', 'plug'];

const refusedError = (what) => new ComelitError(`${what} refused`, 'refused', { sent: true });

export class ComelitClient extends EventEmitter {
  constructor({
    kind = 'bridge',
    transport = nodeTransport,
    timers = globalThis,
    now = Date.now,
    logger = silent,
    timings = TIMINGS,
  } = {}) {
    super();
    this.kind = kind;
    this.transport = transport;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    this.timings = timings;
    this.options = { host: '', port: 80, pin: '', vedoPin: '', pollInterval: 10_000 };
    this.generation = 0;
    this.running = false;
    this.ready = false;
    this.failures = 0;
    this.cookies = new Map();
    /** kind -> the last status read: { at (written), generation, status, val }. */
    this.lastReads = new Map();
    this.queue = [];
    this.inflight = undefined;
    this.lastAt = undefined;
    this.lastClimaAt = undefined;
    this.timer = undefined;
    this.pumpTimer = undefined;
    this.newFirmware = false;
    this.vedo = 'off';
    this.objects = undefined;
    this.label = kind === 'bridge' ? 'Comelit bridge' : 'Comelit Vedo';
  }

  /** pin: of the bridge (kind bridge) or of the Vedo (kind vedo); vedoPin: the alarm behind a bridge. */
  configure({ host, port, pin = '', vedoPin = '', pollInterval = 10_000 }) {
    this.options = { host, port, pin, vedoPin, pollInterval };
  }

  get connected() {
    return this.ready;
  }

  /** A session is being opened or is open. */
  get busy() {
    return this.running && (this.ready || this.opening === true);
  }

  /** The alarm is readable: always on a Vedo IP, after its login through a bridge. */
  get vedoReady() {
    return this.ready && (this.kind === 'vedo' || this.vedo === 'on');
  }

  get vedoSuffix() {
    return this.kind === 'bridge' ? 'vedo_' : '';
  }

  start() {
    this.stop();
    this.running = true;
    this.failures = 0;
    this.openSoon(0);
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.close('stopped');
  }

  openSoon(wait) {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (this.running) this.session(this.generation);
    }, wait);
  }

  /** Every waiting request fails as it was (not sent, or sent with no answer). */
  close(reason) {
    this.ready = false;
    this.opening = false;
    this.vedo = 'off';
    this.cookies.clear();
    this.lastReads.clear();
    if (this.pumpTimer) {
      this.timers.clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
    }
    for (const entry of this.queue.splice(0)) {
      entry.reject(new ComelitError(`Not connected (${reason})`, 'offline'));
    }
  }

  /** The session ended: try again later, unless stopped or refused. */
  lost(generation, reason, { refused = false } = {}) {
    if (generation !== this.generation) return;
    this.generation += 1;
    const wasUp = this.ready;
    this.close(reason);
    if (!this.running) return;
    let retryIn;
    if (refused) {
      // Never again by itself: a refused PIN tried in a loop could lock the device.
      this.running = false;
    } else {
      this.failures = wasUp ? 1 : this.failures + 1;
      const { backoff } = this.timings;
      retryIn = backoff[Math.min(this.failures - 1, backoff.length - 1)];
      this.openSoon(retryIn);
    }
    this.emit('down', { reason, retryIn, refused, stopped: !this.running, wasUp });
  }

  /** Waits `ms`, then tells whether the session is still the same one. */
  async pause(ms, generation) {
    if (ms > 0) await new Promise((resolve) => this.timers.setTimeout(resolve, ms));
    return generation === this.generation;
  }

  // --- Session ----------------------------------------------------------------

  async session(generation) {
    this.opening = true;
    try {
      const snapshot = {};
      if (this.kind === 'bridge') {
        await this.login('bridge', generation);
        snapshot.objects = await this.discoverObjects(generation);
        this.objects = snapshot.objects;
        if (this.options.vedoPin) snapshot.vedo = await this.vedoThroughBridge(generation);
      } else {
        await this.login('vedo', generation);
        snapshot.vedo = await this.discoverVedo(generation);
      }
      if (generation !== this.generation) return;
      this.opening = false;
      this.ready = true;
      this.failures = 0;
      this.emit('up', { snapshot });
      this.schedulePoll(generation);
    } catch (err) {
      if (generation !== this.generation) return;
      if (err instanceof ComelitError && err.kind === 'refused') {
        this.logger.error(`${this.label}: the PIN was refused, connection stopped (no new try)`);
        this.lost(generation, 'PIN refused', { refused: true });
        return;
      }
      this.lost(generation, err.message);
    }
  }

  /**
   * Logs in, as aiocomelit `_login`: nothing when the session already lives;
   * else the PIN is posted once. A 200 answer without cookie is a refusal; a
   * session still not seen 1.5 s after a cookie came is a refusal too.
   * `which`: 'bridge' (dom=PIN), 'vedo' (code=PIN on a Vedo IP, alm=PIN
   * through a bridge).
   */
  async login(which, generation) {
    if (await this.isLogged(which)) return;
    const viaBridge = which === 'vedo' && this.kind === 'bridge';
    const field = which === 'bridge' ? 'dom' : viaBridge ? 'alm' : 'code';
    const pin = viaBridge ? this.options.vedoPin : this.options.pin;
    const res = await this.call({
      method: 'POST',
      path: 'login.cgi',
      form: { [field]: pin },
      label: `login.cgi ${field}=<PIN>`,
      vedo: which === 'vedo',
    });
    // A clear "not allowed" to the PIN posted: a refusal, never tried again.
    if (res.status === 401 || res.status === 403) {
      throw refusedError(which === 'bridge' ? 'Bridge PIN' : 'Vedo PIN');
    }
    if (res.status !== 200) {
      throw new ComelitError(`login.cgi answered HTTP ${res.status}`, 'answer', {
        sent: true,
        status: res.status,
      });
    }
    if (which === 'vedo') {
      if (!(await this.pause(this.timings.vedoLoginWait, generation))) throw new Error('stopped');
      this.newFirmware = await this.checkNewFirmware();
    }
    if (!res.cookie) throw refusedError(which === 'bridge' ? 'Bridge PIN' : 'Vedo PIN');
    if (await this.isLogged(which)) return;
    if (!(await this.pause(this.timings.loginCheckWait, generation))) throw new Error('stopped');
    if (await this.isLogged(which)) return;
    throw refusedError(which === 'bridge' ? 'Bridge PIN' : 'Vedo PIN');
  }

  async isLogged(which) {
    if (which === 'bridge') {
      const res = await this.call({ path: 'login.json' });
      if (res.status === 401 || res.status === 403) return false;
      return bridgeLogged(this.page(res, 'login.json'));
    }
    const res = await this.call({ path: `user/${this.vedoSuffix}area_stat.json`, vedo: true });
    if (res.status === 401 || res.status === 403) return false;
    return vedoLogged(this.page(res, 'area_stat'));
  }

  /** aiocomelit `_check_new_firmware`: the new Vedo firmware takes its actions by POST. */
  async checkNewFirmware() {
    const res = await this.call({ path: `${this.vedoSuffix}index.shtml`, vedo: true });
    const fresh = res.text.includes('www.comelitgroup.com');
    if (fresh !== this.newFirmware) {
      this.logger.info(`${this.label}: ${fresh ? 'new' : 'older'} Vedo firmware`);
    }
    return fresh;
  }

  page(res, what) {
    if (res.status !== 200) {
      throw new ComelitError(`${what}: HTTP ${res.status}`, 'answer', {
        sent: true,
        status: res.status,
      });
    }
    return parsePage(res.text, what);
  }

  async discoverObjects(generation) {
    const objects = {};
    for (const kind of KINDS) {
      const type = BRIDGE_TYPES[kind];
      const res = await this.call({ path: 'user/icon_desc.json', query: { type } });
      if (generation !== this.generation) throw new Error('stopped');
      objects[kind] = parseDescription(this.page(res, `icon_desc ${type}`), type);
    }
    return objects;
  }

  async discoverVedo(generation) {
    const s = this.vedoSuffix;
    const read = async (name) => {
      const res = await this.call({ path: `user/${s}${name}.json` });
      if (generation !== this.generation) throw new Error('stopped');
      const data = this.page(res, name);
      if (!vedoLogged(data)) {
        throw new ComelitError(`${name}: the alarm session ended`, 'session', { sent: true });
      }
      return data;
    };
    const areas = parseAreaDescription(await read('area_desc'));
    const zones = parseZoneDescription(await read('zone_desc'));
    const areaStatus = parseAreaStatus(await read('area_stat'));
    const zoneStatus = parseZoneStatus(await read('zone_stat'));
    return { areas, zones, areaStatus, zoneStatus };
  }

  /**
   * The alarm behind a bridge (aiocomelit `vedo_enabled`): its own login when
   * its PIN differs from the bridge's, then its pages. Refused: the alarm
   * part stops ('vedo' refused), the bridge goes on. Unreadable: the alarm
   * shows offline and is tried again at the next polls.
   */
  async vedoThroughBridge(generation) {
    try {
      if (this.options.vedoPin !== this.options.pin) await this.login('vedo', generation);
      else this.newFirmware = await this.checkNewFirmware();
      const vedo = await this.discoverVedo(generation);
      this.vedo = 'on';
      return vedo;
    } catch (err) {
      if (generation !== this.generation) throw err;
      if (err instanceof ComelitError && err.kind === 'refused') {
        this.vedo = 'refused';
        // Forgotten until the next configure(): never posted again, not even after a reconnection.
        this.options = { ...this.options, vedoPin: '' };
        this.logger.error('Comelit bridge: the Vedo PIN was refused, alarm stopped (no new try)');
        this.emit('vedo', { available: false, refused: true, reason: 'PIN refused' });
        return undefined;
      }
      this.vedo = 'down';
      this.logger.warn(`Comelit bridge: the Vedo alarm is not readable: ${err.message}`);
      this.emit('vedo', { available: false, refused: false, reason: err.message });
      return undefined;
    }
  }

  // --- Polling ----------------------------------------------------------------

  schedulePoll(generation) {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.poll(generation);
    }, this.options.pollInterval);
  }

  async poll(generation) {
    if (generation !== this.generation || !this.ready) return;
    try {
      if (this.kind === 'bridge') {
        if (!(await this.isLogged('bridge'))) {
          this.logger.info('Comelit bridge: session expired, logging in again');
          await this.login('bridge', generation);
        }
        for (const kind of KINDS) {
          if (!this.objects?.[kind]?.size) continue;
          await this.readStatus(kind);
          if (generation !== this.generation) return;
        }
        if (this.options.vedoPin) await this.pollVedoThroughBridge(generation);
      } else {
        await this.pollVedo(generation);
      }
    } catch (err) {
      if (generation !== this.generation) return;
      if (err instanceof ComelitError && err.kind === 'refused') {
        this.logger.error(`${this.label}: the PIN was refused, connection stopped (no new try)`);
        this.lost(generation, 'PIN refused', { refused: true });
        return;
      }
      this.lost(generation, err.message);
      return;
    }
    if (generation === this.generation) this.schedulePoll(generation);
  }

  async pollVedo(generation) {
    try {
      await this.readAreas();
    } catch (err) {
      if (!(err instanceof ComelitError) || err.kind !== 'session') throw err;
      this.logger.info(`${this.label}: alarm session expired, logging in again`);
      await this.login('vedo', generation);
      await this.readAreas();
    }
    if (generation !== this.generation) return;
    await this.readZones();
  }

  async pollVedoThroughBridge(generation) {
    if (this.vedo === 'refused') return;
    if (this.vedo !== 'on') {
      // Unreadable before: try the whole alarm part again.
      const vedo = await this.vedoThroughBridge(generation);
      if (vedo && generation === this.generation) this.emit('vedo', { available: true, vedo });
      return;
    }
    try {
      await this.pollVedo(generation);
    } catch (err) {
      if (generation !== this.generation) throw err;
      if (err instanceof ComelitError && err.kind === 'refused') {
        this.vedo = 'refused';
        // Forgotten until the next configure(): never posted again, not even after a reconnection.
        this.options = { ...this.options, vedoPin: '' };
        this.logger.error('Comelit bridge: the Vedo PIN was refused, alarm stopped (no new try)');
        this.emit('vedo', { available: false, refused: true, reason: 'PIN refused' });
        return;
      }
      this.vedo = 'down';
      this.logger.warn(`Comelit bridge: the Vedo alarm is not readable: ${err.message}`);
      this.emit('vedo', { available: false, refused: false, reason: err.message });
    }
  }

  // --- Reads (emitted at their answer, in order) ------------------------------

  /** The statuses of one object type, emitted as 'status'. */
  async readStatus(kind, options = {}) {
    const type = BRIDGE_TYPES[kind];
    let writtenAt;
    const res = await this.call({
      path: 'user/icon_status.json',
      query: { type },
      ...options,
      onWritten: () => {
        writtenAt = this.now();
      },
    });
    const parsed = parseStatus(this.page(res, `icon_status ${type}`), type);
    // When it was asked of the bridge: a command that arrived before can
    // decide on it (several commands of one type share one read).
    this.lastReads.set(kind, { at: writtenAt, generation: this.generation, ...parsed });
    this.emit('status', { kind, ...parsed });
    return parsed;
  }

  /** The areas of the alarm, emitted as 'areas'; a page without session throws `session`. */
  async readAreas(options = {}) {
    const res = await this.call({ path: `user/${this.vedoSuffix}area_stat.json`, ...options });
    const data = this.page(res, 'area_stat');
    if (!vedoLogged(data)) {
      throw new ComelitError('area_stat: the alarm session ended', 'session', { sent: true });
    }
    const status = parseAreaStatus(data);
    this.emit('areas', { status });
    return status;
  }

  async readZones(options = {}) {
    const res = await this.call({ path: `user/${this.vedoSuffix}zone_stat.json`, ...options });
    const data = this.page(res, 'zone_stat');
    if (!vedoLogged(data)) {
      throw new ComelitError('zone_stat: the alarm session ended', 'session', { sent: true });
    }
    const status = parseZoneStatus(data);
    this.emit('zones', { status });
    return status;
  }

  // --- Commands ---------------------------------------------------------------

  /** aiocomelit `set_device_status`: action 1 = on / open, 0 = off / close. */
  deviceAction(kind, index, action, options = {}) {
    return this.call({
      path: 'user/action.cgi',
      query: { type: BRIDGE_TYPES[kind], [`num${action}`]: index },
      command: true,
      ...options,
    });
  }

  /**
   * aiocomelit `set_clima_status(index, 'set', temp)`: the setpoint in tenths.
   * Two thermostat commands are kept 1.5 s apart, as aiocomelit does.
   */
  climaSetpoint(index, value, options = {}) {
    const notBefore =
      this.lastClimaAt === undefined ? undefined : this.lastClimaAt + this.timings.climaGap;
    return this.call({
      path: 'user/action.cgi',
      query: { clima: index, thermo: 'set', val: Math.round(value * 10) },
      command: true,
      notBefore,
      onWritten: () => {
        this.lastClimaAt = this.now();
      },
      ...options,
    });
  }

  /**
   * aiocomelit `set_zone_status(index, action, force=False)` on an area:
   * `tot`, `p1`, `p12` or `dis`. Never forced: an area the Vedo will not arm
   * as it is (open zone, anomaly) stays disarmed.
   */
  vedoAction(action, index, options = {}) {
    const path = this.kind === 'bridge' ? 'user/action.cgi' : 'action.cgi';
    if (this.newFirmware) {
      return this.call({
        method: 'POST',
        path,
        form: { forced: 0, vedo_param: 1, type_param: action, area_param: index },
        command: true,
        ...options,
      });
    }
    return this.call({
      path,
      query: { vedo: 1, [action]: index, force: 0 },
      command: true,
      ...options,
    });
  }

  // --- Requests ---------------------------------------------------------------

  /**
   * Queues a request; resolves `{ status, text, cookie }` whatever the HTTP
   * status. `command` / `priority`: before the polling requests. `sendBy` (a
   * time): never written after it, rejected as not sent instead. `check`: a
   * last look right before the write; false withdraws it. `ticket` gets
   * `written` and `cancel()`, which withdraws the request while it is not
   * written yet. `notBefore`: not written before that time.
   */
  call({
    method = 'GET',
    path,
    query,
    form,
    label,
    command = false,
    priority = command,
    sendBy,
    check,
    ticket = {},
    notBefore,
    onWritten,
    timeout = this.timings.requestTimeout,
    vedo,
  }) {
    return new Promise((resolve, reject) => {
      ticket.written = false;
      ticket.cancel = () => false;
      if (!this.running) {
        reject(new ComelitError('Not connected', 'offline'));
        return;
      }
      const entry = {
        method,
        path,
        query,
        form,
        label: label ?? path,
        priority,
        sendBy,
        check,
        ticket,
        notBefore,
        onWritten,
        timeout,
        // The Vedo calls keep aiocomelit's 250 ms apart; the bridge's own calls do not wait.
        vedo:
          vedo ??
          (this.kind === 'vedo' ||
            path.includes('vedo_') ||
            query?.vedo !== undefined ||
            form?.vedo_param !== undefined),
        resolve,
        reject,
        state: 'queued',
      };
      ticket.cancel = () => {
        if (entry.state === 'queued') {
          const at = this.queue.indexOf(entry);
          if (at >= 0) this.queue.splice(at, 1);
          entry.state = 'done';
          reject(new ComelitError(`${entry.label} withdrawn before it was sent`, 'late'));
          return true;
        }
        if (entry.state === 'connecting') {
          // Connected but not written: the write is vetoed.
          entry.cancelled = true;
          return true;
        }
        return false;
      };
      // Priority requests go after the other priority ones, before the rest.
      const at = priority ? this.queue.findIndex((e) => !e.priority) : -1;
      if (at < 0) this.queue.push(entry);
      else this.queue.splice(at, 0, entry);
      this.pump();
    });
  }

  pump() {
    if (this.inflight || this.pumpTimer || this.queue.length === 0) return;
    const now = this.now();
    while (
      this.queue.length > 0 &&
      this.queue[0].sendBy !== undefined &&
      now > this.queue[0].sendBy
    ) {
      const late = this.queue.shift();
      late.state = 'done';
      late.reject(new ComelitError(`${late.label} not sent in time`, 'late'));
    }
    if (this.queue.length === 0) return;
    const entry = this.queue[0];
    const ready = Math.max(
      entry.vedo && this.lastVedoAt !== undefined ? this.lastVedoAt + this.timings.gap : 0,
      entry.notBefore ?? 0,
    );
    if (ready > now) {
      if (entry.sendBy !== undefined && ready > entry.sendBy) {
        this.queue.shift();
        entry.state = 'done';
        entry.reject(new ComelitError(`${entry.label} could not be sent in time`, 'late'));
        this.pump();
        return;
      }
      this.pumpTimer = this.timers.setTimeout(() => {
        this.pumpTimer = undefined;
        this.pump();
      }, ready - now);
      return;
    }
    this.queue.shift();
    this.send(entry);
  }

  async send(entry) {
    this.inflight = entry;
    entry.state = 'connecting';
    const generation = this.generation;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(entry.query ?? {})) search.append(key, String(value));
    if (entry.method === 'GET') search.append('_', String(this.now()));
    const body = entry.form
      ? new URLSearchParams(
          Object.entries(entry.form).map(([key, value]) => [key, String(value)]),
        ).toString()
      : undefined;
    const cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const query = search.toString();
    this.logger.debug(`${this.label} <- ${entry.method} ${entry.label}`);
    try {
      const res = await this.transport({
        host: this.options.host,
        port: this.options.port,
        method: entry.method,
        path: `/${entry.path}${query ? `?${query}` : ''}`,
        headers: {
          ...HEADERS,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body,
        timeout: entry.timeout,
        beforeSend: () => {
          // The last look before the socket.
          if (entry.cancelled || generation !== this.generation) {
            return new ComelitError(`${entry.label} withdrawn before it was sent`, 'late');
          }
          if (entry.sendBy !== undefined && this.now() > entry.sendBy) {
            return new ComelitError(`${entry.label} not sent in time`, 'late');
          }
          if (entry.check && !entry.check()) {
            return new ComelitError(`${entry.label} withdrawn: not allowed any more`, 'withdrawn');
          }
          entry.state = 'written';
          entry.ticket.written = true;
          entry.onWritten?.();
          return true;
        },
      });
      const got = this.takeCookies(res.headers);
      if (generation !== this.generation) {
        entry.reject(new ComelitError('The session ended', 'lost', { sent: true }));
      } else {
        entry.resolve({ status: res.status, text: res.text ?? '', cookie: got });
      }
    } catch (err) {
      const sent = entry.state === 'written' && (err.sent ?? true);
      entry.reject(
        err instanceof ComelitError
          ? Object.assign(err, { sent })
          : new ComelitError(err.message, sent ? 'lost' : 'offline', { sent }),
      );
    } finally {
      entry.state = 'done';
      this.inflight = undefined;
      this.lastAt = this.now();
      if (entry.vedo) this.lastVedoAt = this.lastAt;
      this.pump();
    }
  }

  /** `Set-Cookie` -> the jar (one session per host). True when one came. */
  takeCookies(headers) {
    const raw = headers?.['set-cookie'];
    const lines = Array.isArray(raw) ? raw : raw ? [raw] : [];
    let got = false;
    for (const line of lines.slice(0, 10)) {
      const match = /^\s*([A-Za-z0-9_.-]{1,64})=([^;]{0,512})/.exec(String(line));
      if (!match) continue;
      // At most 10 cookies kept: a peer cannot grow the jar.
      if (!this.cookies.has(match[1]) && this.cookies.size >= 10) continue;
      this.cookies.set(match[1], match[2]);
      got = true;
    }
    return got;
  }
}
