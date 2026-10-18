// -----------------------------------------------------------------------------
// Door opening through the Comelit intercom bridge (ICONA protocol, TCP
// 64100), ported from comelit-client 3.0.0 by Pierpaolo Follia
// (src/icona-bridge-client.ts, src/icona/packet.ts, src/bin/icona-cli.ts;
// Apache-2.0, see THIRD_PARTY_NOTICES.md). Its author calls this part "very
// alpha": the frames below are what it sends, byte for byte, including the
// bytes nobody has explained yet ("??" in its source).
//
// Changed from comelit-client:
// - one short session per operation (list the doors, open one door), never
//   kept open; one operation at a time;
// - every answer awaited with a timeout, frames bounded to 64 KB, JSON
//   parsed without prototype keys;
// - an access answer with a response code other than 200 is a refused token
//   (the caller stops: no new try by itself);
// - the door is looked up in the configuration read in the same session,
//   right before the opening; the caller's option and deadline are checked
//   right before the first opening frame; once that frame is written the
//   opening counts as sent (the bridge gives no confirmation).
//
// The user token is never logged.
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';
import { ComelitError } from '../http.js';
import { own, safeJson } from '../json.js';

export const MESSAGE = {
  COMMAND: 0xabcd,
  END: 0x01ef,
  OPEN_DOOR_INIT: 0x18c0,
  OPEN_DOOR: 0x1800,
  OPEN_DOOR_CONFIRM: 0x1820,
};

/** The `message-id` of the JSON requests (comelit-client ViperChannelType). */
const MESSAGE_ID = { UAUT: 2, UCFG: 3, SERVER_INFO: 20 };

const HEADER = [0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
const NULL = Buffer.from([0x00]);

/** comelit-client `stringToBuffer`: one byte per character (its low byte). */
export const ascii = (text, nullTerminated = false) =>
  Buffer.from([
    ...[...String(text)].map((c) => c.charCodeAt(0) & 0xff),
    ...(nullTerminated ? [0x00] : []),
  ]);

/** comelit-client `PacketMessage.createBinaryPacketFromBuffers`. */
export function binaryPacket(requestId, ...buffers) {
  const header = Buffer.from(HEADER);
  header.writeUIntLE(requestId, 4, 2);
  const packet = Buffer.concat([header, ...buffers]);
  packet.writeUIntLE(packet.length - HEADER.length, 2, 2);
  return packet;
}

/** comelit-client `PacketMessage.createBinaryPacketFromStrings`. */
export function controlPacket(requestId, seq, type, ...messages) {
  const header = Buffer.from(HEADER);
  const magic = Buffer.alloc(4);
  magic.writeUIntLE(type, 0, 2);
  magic.writeUIntLE(seq, 2, 2);
  const parts = messages
    .filter((s) => s !== null && s !== undefined)
    .map((s, i) => {
      const info = Buffer.alloc(4);
      let text = ascii(s);
      if (i === 0) {
        const id = Buffer.alloc(2);
        id.writeUIntLE(requestId, 0, 2);
        text = Buffer.concat([text, id, NULL]);
        info.writeUIntLE(s.length + id.length + 1, 0, 4);
      } else {
        info.writeUIntLE(s.length + 1, 0, 4);
      }
      return Buffer.concat([info, text, NULL]);
    });
  const packet = Buffer.concat([header, magic, ...parts]);
  packet.writeUIntLE(packet.length - HEADER.length, 2, 2);
  return packet;
}

/** comelit-client `PacketMessage.createJSONPacket`. */
export function jsonPacket(requestId, json) {
  const text = ascii(JSON.stringify(json));
  const packet = Buffer.concat([Buffer.from(HEADER), text]);
  packet.writeUIntLE(text.length, 2, 2);
  packet.writeUIntLE(requestId, 4, 2);
  return packet;
}

const vipAddress = (vip) => `${vip.aptAddress}${vip.aptSubaddress}`;

/** The frames of an opening, as comelit-client builds them. */
export const frames = {
  access: (id, token) =>
    jsonPacket(id, {
      message: 'access',
      'user-token': token,
      'message-type': 'request',
      'message-id': MESSAGE_ID.UAUT,
    }),
  getConfig: (id, addressbooks) =>
    jsonPacket(id, {
      message: 'get-configuration',
      addressbooks,
      'message-type': 'request',
      'message-id': MESSAGE_ID.UCFG,
    }),
  serverInfo: (id) =>
    jsonPacket(id, {
      message: 'server-info',
      'message-type': 'request',
      'message-id': MESSAGE_ID.SERVER_INFO,
    }),
  /** `getUnknownOpenDoorMessage`. */
  ctppInit: (id, vip) =>
    binaryPacket(
      id,
      Buffer.from([0xc0, 0x18, 0x5c, 0x8b]),
      Buffer.from([0x2b, 0x73, 0x00, 0x11]),
      Buffer.from([0x00, 0x40, 0xac, 0x23]),
      ascii(vipAddress(vip), true),
      Buffer.from([0x10, 0x0e]),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      ascii(vipAddress(vip), true),
      ascii(vip.aptAddress, true),
      NULL,
    ),
  /**
   * `getOpenDoorMessage`. Its first byte is `Buffer.from([MessageType.OPEN_DOOR])`
   * in comelit-client: 0x1800 and 0x1820 kept to their low byte, 0x00 and
   * 0x20 (unlike the actuator frames, no 0x18 follows): kept as it is.
   */
  openDoor: (id, vip, door, confirm = false) =>
    binaryPacket(
      id,
      Buffer.from([(confirm ? MESSAGE.OPEN_DOOR_CONFIRM : MESSAGE.OPEN_DOOR) & 0xff]),
      Buffer.from([0x5c, 0x8b]),
      Buffer.from([0x2c, 0x74, 0x00, 0x00]),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      ascii(`${vip.aptAddress}${door.outputIndex}`, true),
      ascii(door.aptAddress),
      NULL,
    ),
  /** `getInitOpenDoorMessage`. */
  openDoorInit: (id, vip, door) =>
    binaryPacket(
      id,
      Buffer.from([0xc0, 0x18, 0x70, 0xab]),
      Buffer.from([0x29, 0x9f, 0x00, 0x0d]),
      Buffer.from([0x00, 0x2d]),
      ascii(door.aptAddress, true),
      NULL,
      Buffer.from([door.outputIndex & 0xff, 0x00, 0x00, 0x00]),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      ascii(`${vip.aptAddress}${door.outputIndex}`, true),
      ascii(door.aptAddress, true),
      NULL,
    ),
};

/**
 * Cuts the byte stream in frames: 8 bytes of header (size at 2, little
 * endian on 2 bytes; request id at 4, on 4 bytes), then the body.
 */
export class IconaReader {
  constructor({ onFrame, onError, max = LIMITS.maxIconaFrame }) {
    this.onFrame = onFrame;
    this.onError = onError;
    this.max = max;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const size = this.buffer.readUInt16LE(2);
      if (size > this.max) {
        this.onError(new Error('frame too large'));
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 8 + size) return;
      const requestId = this.buffer.readUInt32LE(4);
      const body = this.buffer.subarray(8, 8 + size);
      this.buffer = this.buffer.subarray(8 + size);
      this.onFrame(decode(requestId, Buffer.from(body)));
    }
  }
}

/** comelit-client `decodeResponse`: a control frame (id 0), a JSON frame, or binary. */
export function decode(requestId, body) {
  if (requestId === 0) {
    if (body.length < 4) return { kind: 'binary', requestId };
    return { kind: 'control', type: body.readUInt16LE(0), seq: body.readUInt16LE(2) };
  }
  if (body[0] === 0x7b) {
    try {
      return { kind: 'json', requestId, json: safeJson(body.toString('utf8')) };
    } catch {
      return { kind: 'binary', requestId };
    }
  }
  return { kind: 'binary', requestId };
}

/** The intercom configuration -> { vip, doors } (doors: id, name, aptAddress, outputIndex). */
export function parseConfiguration(json) {
  const vipRaw = own(json, 'vip');
  const aptAddress = own(vipRaw, 'apt-address');
  const aptSubaddress = own(vipRaw, 'apt-subaddress');
  if (
    typeof aptAddress !== 'string' ||
    !/^[0-9A-Za-z]{1,16}$/.test(aptAddress) ||
    !Number.isInteger(aptSubaddress) ||
    aptSubaddress < 0 ||
    aptSubaddress > 9999
  ) {
    throw new ComelitError('Intercom configuration without a valid apartment address', 'answer', {
      sent: true,
    });
  }
  const vip = { aptAddress, aptSubaddress };
  const book = own(own(vipRaw, 'user-parameters'), 'opendoor-address-book');
  const doors = [];
  for (const item of Array.isArray(book) ? book.slice(0, LIMITS.maxDoors) : []) {
    const id = own(item, 'id');
    const name = own(item, 'name');
    const address = own(item, 'apt-address');
    const output = own(item, 'output-index');
    if (
      !Number.isInteger(id) ||
      id < 0 ||
      id > 9999 ||
      typeof address !== 'string' ||
      !/^[0-9A-Za-z]{1,16}$/.test(address) ||
      !Number.isInteger(output) ||
      output < 0 ||
      output > 255 ||
      doors.some((d) => d.id === id)
    ) {
      continue;
    }
    doors.push({
      id,
      // eslint-disable-next-line no-control-regex
      name: typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, '').slice(0, 64) : '',
      aptAddress: address,
      outputIndex: output,
    });
  }
  return { vip, doors };
}

/** One TCP session with the intercom bridge. */
export class IconaSession {
  constructor({ connect = (o) => createConnection(o), timers = globalThis, logger, timings }) {
    this.connectFn = connect;
    this.timers = timers;
    this.logger = logger;
    this.timings = timings ?? TIMINGS;
    this.frames = [];
    this.waiters = [];
    this.channels = new Map();
    this.closed = false;
    // comelit-client starts its channel ids at a random number around 8000.
    this.id = 8000 + Math.floor(Math.random() * 10);
  }

  open(host, port) {
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.close();
        reject(new ComelitError('Intercom: connection timed out', 'offline'));
      }, this.timings.iconaConnect);
      let socket;
      try {
        socket = this.connectFn({ host, port });
      } catch (err) {
        this.timers.clearTimeout(timer);
        reject(new ComelitError(`Intercom: ${err.message}`, 'offline'));
        return;
      }
      this.socket = socket;
      this.reader = new IconaReader({
        onFrame: (frame) => this.deliver(frame),
        onError: (err) => this.fail(new ComelitError(`Intercom: ${err.message}`, 'answer')),
      });
      socket.on('connect', () => {
        this.timers.clearTimeout(timer);
        resolve();
      });
      socket.on('data', (chunk) => this.reader.push(chunk));
      socket.on('error', (err) => {
        this.timers.clearTimeout(timer);
        const error = new ComelitError(`Intercom: ${err.code ?? err.message}`, 'offline');
        reject(error);
        this.fail(error);
      });
      socket.on('close', () => this.fail(new ComelitError('Intercom: connection closed', 'lost')));
    });
  }

  deliver(frame) {
    const waiter = this.waiters.shift();
    if (waiter) {
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else if (this.frames.length < 16) {
      this.frames.push(frame);
    }
  }

  fail(error) {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  /** The next frame, or a `timeout` error. */
  next(timeout = this.timings.iconaRead) {
    if (this.frames.length > 0) return Promise.resolve(this.frames.shift());
    if (this.closed) return Promise.reject(new ComelitError('Intercom: closed', 'lost'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = this.timers.setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new ComelitError('Intercom: no answer in time', 'timeout'));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  write(bytes) {
    if (this.closed || !this.socket) throw new ComelitError('Intercom: closed', 'lost');
    this.socket.write(bytes);
  }

  /** comelit-client `openChanel`: the open channel when there is one. */
  async channel(name, extra) {
    if (this.channels.has(name)) return this.channels.get(name);
    this.id += 1;
    const data = { name, id: this.id, seq: 1 };
    this.channels.set(name, data);
    this.write(controlPacket(data.id, 1, MESSAGE.COMMAND, name, extra));
    const answer = await this.next();
    if (answer.kind !== 'control' || answer.seq !== 2) {
      throw new ComelitError(`Intercom: channel ${name} not opened`, 'answer', { sent: true });
    }
    data.seq = answer.seq;
    return data;
  }

  async closeChannel(data) {
    data.seq += 1;
    this.write(controlPacket(data.id, data.seq, MESSAGE.END));
    const answer = await this.next();
    if (answer.kind !== 'control' || answer.seq !== data.seq + 1) {
      throw new ComelitError(`Intercom: channel ${data.name} not closed`, 'answer', { sent: true });
    }
    this.channels.delete(data.name);
  }

  async json(name, packet, { close = true } = {}) {
    const data = await this.channel(name);
    this.write(packet(data.id));
    const answer = await this.next();
    if (answer.kind !== 'json') {
      throw new ComelitError(`Intercom: no JSON answer on ${name}`, 'answer', { sent: true });
    }
    if (close) await this.closeChannel(data);
    return answer.json;
  }

  /** The access answer's response code (200: the token is accepted). */
  async authenticate(token) {
    const json = await this.json('UAUT', (id) => frames.access(id, token));
    const code = own(json, 'response-code');
    return Number.isInteger(code) ? code : undefined;
  }

  close() {
    this.closed = true;
    try {
      this.socket?.end?.();
      this.socket?.destroy?.();
    } catch {
      // The socket is going anyway.
    }
  }
}

const tokenRefused = (code) =>
  new ComelitError(`Intercom: token refused (response code ${code})`, 'refused', { sent: true });

/**
 * Reads the doors. Throws `refused` when the bridge answers the token with a
 * response code other than 200, another ComelitError otherwise.
 */
export async function listDoors({ host, port, token, connect, timers, logger, timings }) {
  const session = new IconaSession({ connect, timers, logger, timings });
  try {
    await session.open(host, port);
    const code = await session.authenticate(token);
    if (code !== 200) throw tokenRefused(code);
    return parseConfiguration(await session.json('UCFG', (id) => frames.getConfig(id, 'all')));
  } finally {
    session.close();
  }
}

/**
 * Opens one door, with the sequence of comelit-client's `icona open-door`:
 * access, configuration (none, then all), server info, the CTPP channel, then
 * the opening frames. `ready()` is called right before the CTPP channel and
 * right before the first opening frame: it throws (a ComelitError, nothing
 * sent) to stop there. `onSent()` is called once the first opening frame is
 * written. Resolves when every frame is written.
 */
export async function openDoor({
  host,
  port,
  token,
  doorId,
  verify,
  ready,
  onSent,
  connect,
  timers,
  logger,
  timings,
  session = new IconaSession({ connect, timers, logger, timings }),
}) {
  let sent = false;
  try {
    await session.open(host, port);
    const code = await session.authenticate(token);
    if (code !== 200) throw tokenRefused(code);
    await session.json('UCFG', (id) => frames.getConfig(id, 'none'), { close: false });
    await session.json('INFO', (id) => frames.serverInfo(id), { close: false });
    const config = parseConfiguration(
      await session.json('UCFG', (id) => frames.getConfig(id, 'all'), { close: false }),
    );
    const door = config.doors.find((d) => d.id === doorId);
    if (!door) {
      throw new ComelitError(`Intercom: door ${doorId} not in its configuration`, 'missing');
    }
    // The entry read now must still be the door the device was made for.
    verify?.(door);
    await session.json('INFO', (id) => frames.serverInfo(id));
    ready();
    const ctpp = await session.channel('CTPP', vipAddress(config.vip));
    session.write(frames.ctppInit(ctpp.id, config.vip));
    // comelit-client reads two answers and does not look at them.
    await session.next().catch(() => undefined);
    await session.next().catch(() => undefined);
    ready();
    session.write(frames.openDoor(ctpp.id, config.vip, door));
    sent = true;
    onSent?.(door);
    session.write(frames.openDoor(ctpp.id, config.vip, door, true));
    session.write(frames.openDoorInit(ctpp.id, config.vip, door));
    await session.next().catch(() => undefined);
    await session.next().catch(() => undefined);
    session.write(frames.openDoor(ctpp.id, config.vip, door));
    session.write(frames.openDoor(ctpp.id, config.vip, door, true));
    return door;
  } catch (err) {
    const error =
      err instanceof ComelitError ? err : new ComelitError(err.message, sent ? 'lost' : 'offline');
    error.sent = sent;
    throw error;
  } finally {
    session.close();
  }
}
