// -----------------------------------------------------------------------------
// In-memory Comelit hosts: no socket, no network.
// - FakeBridge: a `transport` for src/comelit/client.js that answers like a
//   Serial Bridge (and the Vedo behind it) or a Vedo IP, as aiocomelit reads
//   them: login.json, login.cgi (dom= / alm= / code=), icon_desc, icon_status,
//   the Vedo pages, action.cgi. It records every request and can be told to
//   delay, fail or change an answer (`hook`).
// - FakeIcona: a `connect` for src/comelit/icona.js that answers like the
//   intercom bridge as comelit-client describes it.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { ComelitError } from '../../src/http.js';

/** Lets every queued delivery and the promise chains behind it run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Settles until `check()` is true. */
export async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never met');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A logger that keeps every line (to look for secrets), printing nothing. */
export function quietLogger() {
  const lines = [];
  const keep =
    (level) =>
    (...args) =>
      lines.push(
        `${level} ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`,
      );
  return {
    lines,
    debug: keep('debug'),
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
  };
}

const json = (data, headers = {}) => ({ status: 200, headers, text: JSON.stringify(data) });

export class FakeBridge {
  constructor({
    kind = 'bridge',
    pin = '1234',
    vedoPin = '5678',
    vedo = true,
    newFirmware = false,
  } = {}) {
    this.kind = kind;
    this.pin = pin;
    this.vedoPin = vedoPin;
    this.vedo = vedo;
    this.newFirmware = newFirmware;
    this.requests = [];
    this.sessions = 0;
    this.logins = [];
    this.hook = undefined;
    this.session = undefined;
    this.objects = {
      light: { desc: ['Salon', 'Cuisine'], status: [0, 1], env: [1, 2] },
      shutter: { desc: ['Volet salon'], status: [0], env: [1] },
      other: { desc: ['Prise TV'], status: [0], env: [1] },
      clima: {
        desc: ['Thermostat séjour', 'Déshumidificateur'],
        status: [0, 0],
        env: [1, 1],
        val: [
          [
            [215, 1, 'U', 'M', 200, 0, 0, 'U'],
            [650, 0, 'U', 'M', 500, 0, 0, 'U'],
            [0, 0],
          ],
          [
            [0, 0, 'O', 'M', 0, 0, 0, 'O'],
            [600, 1, 'L', 'M', 550, 0, 0, 'L'],
            [0, 0],
          ],
        ],
      },
      irrigation: { desc: [], status: [] },
      scenario: { desc: [], status: [] },
    };
    this.envDesc = ['', 'Séjour', 'Cuisine'];
    this.areas = {
      description: ['Maison', 'Garage', ''],
      present: [1, 1, 0],
      p1_pres: [1, 1, 0],
      p2_pres: [1, 0, 0],
      ready: [0, 0, 0],
      armed: [0, 0, 0],
      alarm: [0, 0, 0],
      alarm_memory: [0, 0, 0],
      sabotage: [0, 0, 0],
      anomaly: [0, 0, 0],
      in_time: [0, 0, 0],
      out_time: [0, 0, 0],
    };
    this.zones = {
      description: ['Porte entrée', 'Couloir', 'Garage', ''],
      present: ['1', '1', '1', '0'],
      status: ['0x0000', '0x0000', '0x0000', '0x0000'],
    };
    this.transport = (req) => this.handle(req);
  }

  get suffix() {
    return this.kind === 'bridge' ? 'vedo_' : '';
  }

  /** The requests without the cache-busting `_` parameter, as "GET path?query". */
  get log() {
    return this.requests.map((r) => `${r.method} ${r.path}${r.body ? ` ${r.body}` : ''}`);
  }

  async handle(req) {
    const url = new URL(`http://x${req.path}`);
    url.searchParams.delete('_');
    const path = url.pathname.slice(1);
    const query = Object.fromEntries(url.searchParams);
    const entry = {
      method: req.method,
      path: `${path}${url.searchParams.size ? `?${url.searchParams}` : ''}`,
      body: req.body,
      query,
      cookie: req.headers.Cookie,
    };
    if (this.hook) {
      const hooked = await this.hook(entry, req);
      if (hooked?.veto) {
        const veto = req.beforeSend();
        if (veto !== true) throw veto;
      }
      if (hooked?.error) throw hooked.error;
      if (hooked?.response) {
        const veto = req.beforeSend();
        if (veto !== true) throw veto;
        this.requests.push(entry);
        return hooked.response;
      }
    }
    // The transport calls beforeSend once connected, right before the write.
    const veto = req.beforeSend();
    if (veto !== true) throw veto;
    this.requests.push(entry);
    return this.answer(req.method, path, query, req.body, req.headers.Cookie ?? '');
  }

  logged(cookie) {
    return Boolean(this.session) && cookie.includes(`uid=${this.session.id}`);
  }

  answer(method, path, query, body, cookie) {
    const form = Object.fromEntries(new URLSearchParams(body ?? ''));
    const session = this.logged(cookie) ? this.session : undefined;
    if (path === 'login.cgi' && method === 'POST') {
      if (form.logout) return { status: 200, headers: {}, text: '' };
      const [field] = Object.keys(form);
      this.logins.push(field);
      const expected = field === 'alm' || field === 'code' ? this.vedoPin : this.pin;
      if (form[field] !== expected) return { status: 200, headers: {}, text: '' };
      if (!this.session || !session) {
        this.sessions += 1;
        this.session = { id: `s${this.sessions}`, bridge: false, vedo: false };
      }
      if (field === 'dom') this.session.bridge = true;
      else this.session.vedo = true;
      return {
        status: 200,
        headers: { 'set-cookie': [`uid=${this.session.id}; path=/`] },
        text: '',
      };
    }
    if (path === 'login.json') {
      return json({ domus: session?.bridge ? '0123456789ab' : '000000000000', logged: 0 });
    }
    if (path === `${this.suffix}index.shtml`) {
      return this.newFirmware
        ? { status: 200, headers: {}, text: '<html>www.comelitgroup.com</html>' }
        : { status: 404, headers: {}, text: 'not found' };
    }
    if (path === 'user/icon_desc.json' || path === 'user/icon_status.json') {
      const objects = this.objects[query.type];
      if (!objects) return { status: 404, headers: {}, text: '' };
      const data = {
        num: objects.desc.length,
        desc: objects.desc,
        env: objects.env ?? objects.desc.map(() => 0),
        env_desc: this.envDesc,
        status: objects.status,
        val: objects.val ?? objects.desc.map(() => 0),
        protected: objects.desc.map(() => 0),
        type: objects.desc.map(() => 1),
      };
      return json(path === 'user/icon_desc.json' ? data : { status: data.status, val: data.val });
    }
    const vedoPage = new RegExp(
      `^user/${this.suffix}(area_desc|area_stat|zone_desc|zone_stat)\\.json$`,
    );
    const page = vedoPage.exec(path)?.[1];
    if (page) {
      if (!this.vedo) return { status: 404, headers: {}, text: '' };
      const logged =
        session?.vedo || (this.kind === 'bridge' && session?.bridge && this.pin === this.vedoPin)
          ? 1
          : 0;
      const a = this.areas;
      if (page === 'area_desc') {
        return json({
          logged,
          present: a.present,
          p1_pres: a.p1_pres,
          p2_pres: a.p2_pres,
          description: a.description,
        });
      }
      if (page === 'area_stat') {
        const { description: _d, present: _p, p1_pres: _1, p2_pres: _2, ...stat } = a;
        return json({ logged, zone_open: 0, ...stat });
      }
      if (page === 'zone_desc') {
        return json({
          logged,
          present: this.zones.present,
          in_area: [1, 1, 2, 0],
          description: this.zones.description,
        });
      }
      return json({ logged, status: this.zones.status.join(',') });
    }
    const action = this.kind === 'bridge' ? 'user/action.cgi' : 'action.cgi';
    if (path === action) return this.action(method, query, form, session);
    return { status: 404, headers: {}, text: '' };
  }

  action(method, query, form, session) {
    if (!session) return { status: 403, headers: {}, text: '' };
    if (method === 'POST' || query.vedo) {
      const params =
        method === 'POST'
          ? { type: form.type_param, area: Number(form.area_param) }
          : {
              type: ['tot', 'p1', 'p12', 'dis'].find((k) => query[k] !== undefined),
              area: Number(query.tot ?? query.p1 ?? query.p12 ?? query.dis),
            };
      const levels = { tot: 4, p1: 1, p12: 3, dis: 0 };
      this.areas.armed[params.area] = levels[params.type];
      if (params.type === 'dis') this.areas.alarm[params.area] = 0;
      // The new firmware answers 404 to every action (aiocomelit).
      return { status: this.newFirmware ? 404 : 200, headers: {}, text: '' };
    }
    if (query.clima !== undefined) {
      this.objects.clima.val[Number(query.clima)][0][4] = Number(query.val);
      return { status: 200, headers: {}, text: '' };
    }
    const objects = this.objects[query.type];
    const on = query.num1 !== undefined;
    const index = Number(on ? query.num1 : query.num0);
    if (query.type === 'shutter') {
      const status = objects.status[index];
      // A command the other way stops a moving shutter.
      if (status === 1 && !on) objects.status[index] = 0;
      else if (status === 2 && on) objects.status[index] = 0;
      else objects.status[index] = on ? 1 : 2;
    } else {
      objects.status[index] = on ? 1 : 0;
    }
    return { status: 200, headers: {}, text: '' };
  }
}

// --- ICONA ---------------------------------------------------------------------

class FakeIconaSocket extends EventEmitter {
  constructor(server) {
    super();
    this.server = server;
    this.buffer = Buffer.alloc(0);
    this.destroyed = false;
    queueMicrotask(() => {
      if (server.refuse) {
        this.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
        return;
      }
      this.emit('connect');
    });
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    this.buffer = Buffer.concat([this.buffer, Buffer.from(bytes)]);
    while (this.buffer.length >= 8) {
      const size = this.buffer.readUInt16LE(2);
      if (this.buffer.length < 8 + size) return;
      const packet = this.buffer.subarray(0, 8 + size);
      this.buffer = this.buffer.subarray(8 + size);
      this.server.receive(this, Buffer.from(packet));
    }
    return true;
  }

  send(requestId, body) {
    const header = Buffer.alloc(8);
    header.writeUInt16LE(0x0600, 0);
    header.writeUInt16LE(body.length, 2);
    header.writeUInt32LE(requestId, 4);
    const frame = Buffer.concat([header, body]);
    queueMicrotask(() => {
      if (!this.destroyed) this.emit('data', frame);
    });
  }

  end() {}

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }
}

export class FakeIcona {
  constructor({ token = 'icona-token-0123456789' } = {}) {
    this.token = token;
    this.received = [];
    this.connections = 0;
    this.refuse = false;
    this.onJson = undefined;
    this.configuration = {
      vip: {
        enabled: true,
        'apt-address': 'SB000006',
        'apt-subaddress': 2,
        'logical-subaddress': 2,
        'user-parameters': {
          'opendoor-address-book': [
            {
              id: 1,
              name: 'Portail',
              'apt-address': 'SB100001',
              'output-index': 2,
              'secure-mode': false,
            },
            {
              id: 2,
              name: 'Porte immeuble',
              'apt-address': 'SB100001',
              'output-index': 1,
              'secure-mode': false,
            },
          ],
        },
      },
    };
    this.connect = () => {
      this.connections += 1;
      return new FakeIconaSocket(this);
    };
  }

  /** What was written, by kind: control channel names, JSON messages, binary first bytes. */
  get log() {
    return this.received.map((r) => r.label);
  }

  receive(socket, packet) {
    const requestId = packet.readUInt16LE(4);
    const body = packet.subarray(8);
    if (requestId === 0 || (body.length >= 4 && [0xabcd, 0x01ef].includes(body.readUInt16LE(0)))) {
      const type = body.readUInt16LE(0);
      const seq = body.readUInt16LE(2);
      if (type === 0xabcd) {
        const length = body.readUInt32LE(4);
        const name = body.subarray(8, 8 + 4).toString('latin1');
        this.received.push({ label: `open ${name}`, packet, length });
        const answer = Buffer.alloc(8);
        answer.writeUInt16LE(0xabcd, 0);
        answer.writeUInt16LE(seq + 1, 2);
        socket.send(0, answer);
        return;
      }
      if (type === 0x01ef) {
        this.received.push({ label: 'end', packet });
        const answer = Buffer.alloc(4);
        answer.writeUInt16LE(0x01ef, 0);
        answer.writeUInt16LE(seq + 1, 2);
        socket.send(0, answer);
        return;
      }
    }
    if (body[0] === 0x7b) {
      const message = JSON.parse(body.toString('latin1'));
      this.received.push({ label: message.message, packet, message });
      this.onJson?.(message);
      let answer;
      if (message.message === 'access') {
        const ok = message['user-token'] === this.token;
        answer = {
          message: 'access',
          'response-code': ok ? 200 : 401,
          'response-string': ok ? 'Access Granted' : 'Unauthorized',
        };
      } else if (message.message === 'get-configuration') {
        answer = {
          message: 'get-configuration',
          'response-code': 200,
          ...(message.addressbooks === 'all'
            ? this.configuration
            : { vip: { ...this.configuration.vip, 'user-parameters': {} } }),
        };
      } else {
        answer = { message: 'server-info', 'response-code': 200, 'server-version': '1.0' };
      }
      socket.send(requestId, Buffer.from(JSON.stringify(answer), 'latin1'));
      return;
    }
    const label = `bin ${body.subarray(0, 4).toString('hex')}`;
    this.received.push({ label, packet });
    if (body[0] === 0xc0) {
      // CTPP init and init-open: two answers each.
      socket.send(requestId, Buffer.from([0x60, 0x18, 0x5c, 0x8b, 0x00]));
      socket.send(requestId, Buffer.from([0x00, 0x18, 0x5c, 0x8b, 0x00]));
    }
  }
}

export { ComelitError };
