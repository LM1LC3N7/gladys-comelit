// The ICONA frames, byte for byte as comelit-client 3.0.0 builds them
// (src/icona/packet.ts, src/icona-bridge-client.ts), the reader and the
// configuration parser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IconaReader,
  binaryPacket,
  controlPacket,
  decode,
  frames,
  jsonPacket,
  parseConfiguration,
} from '../src/comelit/icona.js';

const hex = (buffer) => Buffer.from(buffer).toString('hex');
const vip = { aptAddress: 'SB000006', aptSubaddress: 2 };
const door = { id: 1, name: 'Portail', aptAddress: 'SB100001', outputIndex: 2 };

test('the channel frame of createBinaryPacketFromStrings', () => {
  // header 0006, size 16, id 0 | COMMAND cdab, seq 1 | length 7, "UAUT", id 0x1f41, 00, 00
  assert.equal(
    hex(controlPacket(8001, 1, 0xabcd, 'UAUT')),
    '0006100000000000' + 'cdab0100' + '07000000' + '55415554' + '411f' + '00' + '00',
  );
  // A second string: its own length + 1, then its NUL.
  assert.equal(
    hex(controlPacket(8002, 1, 0xabcd, 'CTPP', 'SB0000062')),
    '00061e0000000000cdab0100070000004354505042' +
      '1f0000' +
      '0a000000' +
      Buffer.from('SB0000062').toString('hex') +
      '00',
  );
  // END with the next sequence number, no string.
  assert.equal(hex(controlPacket(8001, 3, 0x01ef)), '0006040000000000ef010300');
});

test('the JSON frame of createJSONPacket: size and request id in the header', () => {
  const packet = jsonPacket(8001, { a: 1 });
  assert.equal(hex(packet.subarray(0, 8)), '00060700411f0000');
  assert.equal(packet.subarray(8).toString('latin1'), '{"a":1}');
  const access = frames.access(8001, 'token');
  assert.deepEqual(JSON.parse(access.subarray(8).toString('latin1')), {
    message: 'access',
    'user-token': 'token',
    'message-type': 'request',
    'message-id': 2,
  });
});

test('the opening frames, as comelit-client writes them', () => {
  const id = 0x1f45;
  const open = frames.openDoor(id, vip, door);
  assert.equal(
    hex(open.subarray(0, 8)),
    `0006${(open.length - 8).toString(16).padStart(2, '0')}00451f0000`,
  );
  assert.equal(
    hex(open.subarray(8)),
    '00' +
      '5c8b' +
      '2c740000' +
      'ffffffff' +
      hex(Buffer.from('SB0000062\0')) +
      hex(Buffer.from('SB100001')) +
      '00',
  );
  assert.equal(frames.openDoor(id, vip, door, true)[8], 0x20, 'the confirmation');
  const init = frames.openDoorInit(id, vip, door);
  assert.equal(
    hex(init.subarray(8)),
    'c01870ab' +
      '299f000d' +
      '002d' +
      hex(Buffer.from('SB100001\0')) +
      '00' +
      '02000000' +
      'ffffffff' +
      hex(Buffer.from('SB0000062\0')) +
      hex(Buffer.from('SB100001\0')) +
      '00',
  );
  const ctpp = frames.ctppInit(id, vip);
  assert.equal(
    hex(ctpp.subarray(8)),
    'c0185c8b' +
      '2b730011' +
      '0040ac23' +
      hex(Buffer.from('SB0000062\0')) +
      '100e' +
      '00000000' +
      'ffffffff' +
      hex(Buffer.from('SB0000062\0')) +
      hex(Buffer.from('SB000006\0')) +
      '00',
  );
  assert.equal(binaryPacket(1, Buffer.from([1, 2])).readUInt16LE(2), 2);
});

test('the reader cuts frames across chunks and refuses an oversized one', () => {
  const got = [];
  const errors = [];
  const reader = new IconaReader({
    onFrame: (f) => got.push(f),
    onError: (e) => errors.push(e),
    max: 64,
  });
  const control = Buffer.from('0006040000000000cdab0200', 'hex');
  const json = Buffer.concat([
    Buffer.from('0006070041 1f0000'.replace(' ', ''), 'hex'),
    Buffer.from('{"a":1}'),
  ]);
  const stream = Buffer.concat([control, json]);
  reader.push(stream.subarray(0, 5));
  reader.push(stream.subarray(5, 15));
  reader.push(stream.subarray(15));
  assert.deepEqual(got, [
    { kind: 'control', type: 0xabcd, seq: 2 },
    { kind: 'json', requestId: 0x1f41, json: { a: 1 } },
  ]);
  reader.push(Buffer.from('0006ff0000000000', 'hex'));
  assert.equal(errors.length, 1);
  assert.equal(decode(5, Buffer.from('{"__proto__":{"x":1}}')).json.x, undefined);
  assert.equal({}.x, undefined);
});

test('the configuration: valid doors only, no guess', () => {
  const config = parseConfiguration({
    vip: {
      'apt-address': 'SB000006',
      'apt-subaddress': 2,
      'user-parameters': {
        'opendoor-address-book': [
          door && { id: 1, name: 'Portail', 'apt-address': 'SB100001', 'output-index': 2 },
          { id: 1, name: 'Twice', 'apt-address': 'SB100001', 'output-index': 3 },
          { id: 'x', name: 'Bad id', 'apt-address': 'SB100001', 'output-index': 1 },
          { id: 3, name: 'Bad address', 'apt-address': '../x', 'output-index': 1 },
          { id: 4, name: 'Bad output', 'apt-address': 'SB100001', 'output-index': 300 },
          { id: 5, name: 'Porte\u0007', 'apt-address': 'SB100001', 'output-index': 0 },
        ],
      },
    },
  });
  assert.deepEqual(config.vip, vip);
  assert.deepEqual(
    config.doors.map((d) => [d.id, d.name]),
    [
      [1, 'Portail'],
      [5, 'Porte'],
    ],
  );
  assert.throws(() => parseConfiguration({ vip: { 'apt-address': 'SB0', 'apt-subaddress': '2' } }));
  assert.throws(() => parseConfiguration({}));
});
