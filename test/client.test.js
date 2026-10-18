// The HTTP session of src/comelit/client.js against the in-memory bridge:
// login and its refusals, one request at a time, priorities, deadlines,
// cookies, reconnection, the alarm behind the bridge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComelitClient } from '../src/comelit/client.js';
import { TIMINGS } from '../src/constants.js';
import { ComelitError } from '../src/http.js';
import { normalizeConfig, stopKeys, vedoSource } from '../src/config.js';
import { memoryStore, normalizeMemory } from '../src/store.js';
import { FakeBridge, quietLogger, sleep, until } from './helpers/fakeComelit.js';

const FAST = {
  ...TIMINGS,
  gap: 0,
  vedoLoginWait: 0,
  loginCheckWait: 0,
  backoff: [30, 60],
};

function client(t, fake, { kind = 'bridge', pin = '1234', vedoPin = '', timings = FAST } = {}) {
  const logger = quietLogger();
  const c = new ComelitClient({ kind, transport: fake.transport, logger, timings });
  c.configure({ host: '192.0.2.10', port: 80, pin, vedoPin, pollInterval: 60_000 });
  const events = [];
  for (const name of ['up', 'down', 'vedo']) c.on(name, (e) => events.push([name, e]));
  t.after(() => c.stop());
  return { c, events, logger };
}

test('login: once, then the objects of each type; the PIN only in the body', async (t) => {
  const fake = new FakeBridge();
  const { c, events, logger } = client(t, fake);
  c.start();
  await until(() => c.connected);
  assert.deepEqual(fake.log, [
    'GET login.json',
    'POST login.cgi dom=1234',
    'GET login.json',
    'GET user/icon_desc.json?type=clima',
    'GET user/icon_desc.json?type=shutter',
    'GET user/icon_desc.json?type=light',
    'GET user/icon_desc.json?type=other',
  ]);
  assert.equal(events[0][0], 'up');
  assert.deepEqual([...events[0][1].snapshot.objects.light.keys()], [0, 1]);
  assert.ok(
    fake.requests.slice(2).every((r) => r.cookie === 'uid=s1'),
    'the session cookie',
  );
  assert.ok(!logger.lines.join('\n').includes('1234'), 'never the PIN in the logs');
});

test('a 200 without cookie, or a session never seen, is a refused PIN: stop, no timer', async (t) => {
  const fake = new FakeBridge();
  const { c, events } = client(t, fake, { pin: '0000' });
  c.start();
  await until(() => events.length > 0);
  assert.deepEqual(events[0][1].refused, true);
  assert.equal(events[0][1].retryIn, undefined);
  await sleep(100);
  assert.deepEqual(fake.logins, ['dom'], 'one try only');
  // A cookie, but the session never shows: refused after a second look.
  const lying = new FakeBridge();
  const original = lying.answer.bind(lying);
  lying.answer = (method, path, ...rest) =>
    path === 'login.json'
      ? { status: 200, headers: {}, text: '{"domus":"000000000000"}' }
      : original(method, path, ...rest);
  const second = client(t, lying);
  second.c.start();
  await until(() => second.events.length > 0);
  assert.equal(second.events[0][1].refused, true);
  assert.equal(lying.log.filter((l) => l === 'GET login.json').length, 3);
});

test('a failure that is not a refusal: new tries, spaced', async (t) => {
  const fake = new FakeBridge();
  let fails = 2;
  fake.hook = async () => {
    if (fails > 0) {
      fails -= 1;
      return { error: new ComelitError('ECONNREFUSED', 'offline') };
    }
    return undefined;
  };
  const { c, events } = client(t, fake);
  c.start();
  await until(() => c.connected);
  assert.deepEqual(
    events.map(([name, e]) => [name, e.retryIn]),
    [
      ['down', 30],
      ['down', 60],
      ['up', undefined],
    ],
  );
});

test('one request at a time; commands before the polling; never written after sendBy', async (t) => {
  const fake = new FakeBridge();
  const { c } = client(t, fake);
  c.start();
  await until(() => c.connected);
  let release;
  fake.hook = async (entry) => {
    if (entry.path.includes('type=clima')) await new Promise((r) => (release = r));
    return undefined;
  };
  const order = [];
  const slow = c.readStatus('thermostat').then(() => order.push('clima'));
  await until(() => release);
  const poll = c.readStatus('light').then(() => order.push('light'));
  const command = c.deviceAction('light', 0, 1).then(() => order.push('command'));
  const late = c.readStatus('shutter', { sendBy: Date.now() + 10 }).catch((e) => e);
  await sleep(30);
  release();
  await Promise.all([slow, poll, command]);
  const lateError = await late;
  assert.deepEqual(order, ['clima', 'command', 'light']);
  assert.equal(lateError.kind, 'late');
  assert.equal(lateError.sent, false);
  assert.ok(!fake.log.some((l) => l.includes('type=shutter') && l.includes('icon_status')));
});

test('a request withdrawn by its ticket while connecting is never written', async (t) => {
  const fake = new FakeBridge();
  const { c } = client(t, fake);
  c.start();
  await until(() => c.connected);
  const ticket = {};
  fake.hook = async () => {
    fake.hook = undefined;
    assert.equal(ticket.cancel(), true);
    return { veto: true };
  };
  const err = await c.deviceAction('light', 0, 1, { ticket }).catch((e) => e);
  assert.equal(err.kind, 'late');
  assert.equal(err.sent, false);
  assert.equal(ticket.written, false);
});

test('an expired session is logged in again by the poll; the alarm part never stops the bridge', async (t) => {
  const fake = new FakeBridge({ vedoPin: '5678' });
  const { c, events } = client(t, fake, { vedoPin: '5678' });
  c.start();
  await until(() => c.connected);
  assert.equal(c.vedoReady, true);
  fake.session = undefined;
  fake.vedo = false;
  await c.poll(c.generation);
  assert.equal(c.connected, true, 'the lights go on');
  assert.equal(c.vedoReady, false);
  assert.deepEqual(events.at(-1)[0], 'vedo');
  assert.equal(events.at(-1)[1].refused, false);
  fake.vedo = true;
  await c.poll(c.generation);
  assert.equal(c.vedoReady, true, 'back at the next poll');
  assert.equal(events.at(-1)[1].available, true);
});

test('the configuration: defaults, secrets checked, the alarm source, the stop keys', () => {
  const config = normalizeConfig({
    host: 'http://192.0.2.10:8080/',
    bridge_pin: ' 1234 ',
    vedo_pin: 'abcd',
  });
  assert.equal(config.host, '192.0.2.10');
  assert.equal(config.port, 8080);
  assert.equal(config.bridgePin, '1234');
  assert.equal(config.vedoPin, '');
  assert.deepEqual(config.invalid, ['vedo_pin']);
  assert.equal(
    config.allowArm || config.allowDisarm || config.allowDoor || config.allowSetpoint,
    false,
  );
  assert.equal(config.pollInterval, 10_000);
  assert.equal(vedoSource(config), 'none');
  assert.equal(vedoSource(normalizeConfig({ host: 'a', vedo_pin: '1' })), 'bridge');
  assert.equal(
    vedoSource(normalizeConfig({ host: 'a', vedo_host: 'b', vedo_pin: '1' })),
    'standalone',
  );
  const a = stopKeys(normalizeConfig({ host: 'a', bridge_pin: '1', poll_interval: 10 }));
  const b = stopKeys(normalizeConfig({ host: 'a', bridge_pin: '1', poll_interval: 60 }));
  assert.deepEqual(a, b, 'another poll interval never lifts a stop');
  assert.equal(normalizeConfig({ intercom_token: 'short' }).intercomToken, '');
  assert.equal(normalizeConfig({ host: 'bad host!' }).host, '');
});

test('the persisted state: stops only, repaired, never a secret', async () => {
  assert.deepEqual(normalizeMemory(null), { stops: [] });
  assert.deepEqual(
    normalizeMemory({
      stops: [
        { kind: 'bridge_pin', place: 'a:80', at: 5, pin: '1234' },
        { kind: 'bridge_pin', place: 'b:80' },
        { kind: 'other', place: 'c' },
        { kind: 'icona_token', place: '' },
      ],
      __proto__: { x: 1 },
    }),
    { stops: [{ kind: 'bridge_pin', place: 'a:80', at: 5 }] },
  );
  const store = memoryStore();
  await store.save({ stops: [] });
  assert.deepEqual(await store.load(), { stops: [] });
});
