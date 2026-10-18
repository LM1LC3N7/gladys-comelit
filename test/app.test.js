// ComelitApp with the SDK's fake Gladys (createFakeGladys), the in-memory
// bridge and intercom (test/helpers/fakeComelit.js): the whole chain from the
// bridge pages to the Gladys devices, states, scene events and commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ComelitApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FakeBridge, FakeIcona, quietLogger, settle, sleep, until } from './helpers/fakeComelit.js';

const BASE = {
  host: '192.0.2.10',
  bridge_pin: '1234',
  vedo_pin: '5678',
  language: 'en',
};

/** Real timers, short: a test never waits seconds. */
export const FAST = {
  ...TIMINGS,
  gap: 0,
  vedoLoginWait: 0,
  loginCheckWait: 0,
  climaGap: 0,
  backoff: [60_000],
  sendBy: 400,
  answerBy: 600,
  readBefore: 300,
  readBack: 20,
  iconaConnect: 300,
  iconaRead: 150,
  testWait: 1_000,
};

async function setup(t, { config = {}, bridge, icona, store, devices, timings = FAST } = {}) {
  const gladys = createFakeGladys({ config: { ...BASE, ...config }, devices });
  const fake = bridge ?? new FakeBridge();
  const intercom = icona ?? new FakeIcona();
  const logger = quietLogger();
  const memory = store ?? memoryStore();
  const app = new ComelitApp({
    gladys,
    logger,
    transport: fake.transport,
    connectIcona: intercom.connect,
    store: memory,
    timings,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop({ final: true }));
  const device = (externalId) =>
    gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
  const ids = (kind, index) => gladys.externalIds(kind, String(index));
  const ctx = {
    gladys,
    fake,
    intercom,
    app,
    logger,
    store: memory,
    device,
    ids,
    state: (id) => gladys.fake.lastState(id),
    events: () => gladys.fake.sceneEvents,
    set: (kind, index, key, value) => {
      const d = device(ids(kind, index).device);
      const feature = d.features.find((f) => f.external_id === ids(kind, index).feature(key));
      return gladys.fake.setValue(d, feature, value);
    },
    config: (patch) => app.configUpdated({ ...BASE, ...config, ...patch }),
  };
  return ctx;
}

const up = async (ctx) => {
  await until(() => ctx.app.bridgeOnline);
  await ctx.app.chain;
  await settle();
};

const commands = (ctx) => ctx.fake.log.filter((line) => line.includes('action.cgi'));

test('start: devices, categories, states, status', async (t) => {
  const ctx = await setup(t, {
    config: {
      zone_kinds: '2:motion',
      intercom_host: '192.0.2.11',
      intercom_token: 'icona-token-0123456789',
    },
  });
  await up(ctx);
  await until(() => ctx.app.doorState === 'ok');
  await ctx.app.chain;
  const { gladys, ids } = ctx;
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => [d.external_id, d.name]),
    [
      [gladys.externalIds('bridge', 'comelit').device, 'Comelit bridge'],
      [ids('light', 0).device, 'Salon'],
      [ids('light', 1).device, 'Cuisine'],
      [ids('plug', 0).device, 'Prise TV'],
      [ids('shutter', 0).device, 'Volet salon'],
      [ids('thermostat', 0).device, 'Thermostat séjour'],
      [ids('area', 0).device, 'Maison'],
      [ids('area', 1).device, 'Garage'],
      [ids('zone', 0).device, 'Porte entrée'],
      [ids('zone', 1).device, 'Couloir'],
      [ids('zone', 2).device, 'Garage'],
      [ids('door', 'SB100001-1').device, 'Porte immeuble'],
      [ids('door', 'SB100001-2').device, 'Portail'],
    ],
    'the dehumidifier only is left out',
  );
  const categories = (d) => d.features.map((f) => `${f.category}/${f.type}`);
  assert.deepEqual(categories(ctx.device(ids('light', 0).device)), ['light/binary']);
  assert.deepEqual(categories(ctx.device(ids('plug', 0).device)), ['switch/binary']);
  assert.deepEqual(categories(ctx.device(ids('shutter', 0).device)), ['shutter/state']);
  assert.deepEqual(categories(ctx.device(ids('thermostat', 0).device)), [
    'temperature-sensor/decimal',
    'thermostat/target-temperature',
  ]);
  for (const kind of ['area', 'zone', 'door']) {
    for (const d of devices.filter((x) => x.external_id.includes(`:${kind}:`))) {
      for (const f of d.features) {
        assert.notEqual(f.category, 'switch', `${f.external_id}: never a switch`);
        if (!f.read_only) assert.deepEqual([f.category, f.type], ['button', 'push'], f.external_id);
      }
    }
  }
  assert.deepEqual(
    ctx
      .device(ids('area', 0).device)
      .features.filter((f) => !f.read_only)
      .map((f) => f.external_id.split(':').at(-1)),
    ['arm-total', 'arm-p1', 'arm-p12', 'disarm'],
  );
  assert.ok(
    !ctx.device(ids('area', 1).device).features.some((f) => f.external_id.endsWith(':arm-p12')),
    'no P2 on the garage: no P1 + P2 button',
  );
  assert.equal(ctx.device(ids('zone', 1).device).features[0].category, 'motion-sensor');
  assert.equal(ctx.state(ids('light', 1).feature('state')), 1);
  assert.equal(ctx.state(ids('shutter', 0).feature('state')), 0);
  assert.equal(ctx.state(ids('thermostat', 0).feature('temperature')), 21.5);
  assert.equal(ctx.state(ids('thermostat', 0).feature('setpoint')), 20);
  assert.equal(ctx.state(ids('area', 0).feature('mode')), 'Disarmed');
  assert.equal(ctx.state(ids('zone', 0).feature('opening')), 1, 'closed (core value 1)');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /bridge \(5 devices\), alarm \(2 areas, 3 zones\), intercom \(2 doors\)/,
  );
  assert.ok(gladys.fake.transports.every((e) => e.transport === 'local'));
  assert.deepEqual(ctx.fake.logins, ['dom', 'alm'], 'one login each, the PINs in the body');
});

test('lights and plugs: absolute commands, strict values, read back', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const ack = await ctx.set('light', 0, 'state', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(commands(ctx), ['GET user/action.cgi?type=light&num1=0']);
  await sleep(60);
  await settle();
  assert.equal(ctx.state(ctx.ids('light', 0).feature('state')), 1);
  assert.equal((await ctx.set('plug', 0, 'state', '1')).success, true);
  assert.equal(commands(ctx).at(-1), 'GET user/action.cgi?type=other&num1=0');
  for (const value of [null, '', 2, 'on', true]) {
    const bad = await ctx.set('light', 0, 'state', value);
    assert.equal(bad.success, false, JSON.stringify(value));
  }
  assert.equal(commands(ctx).length, 2, 'nothing sent for a value not understood');
});

test('shutters: open, refused against a movement, stop guarded', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  assert.equal((await ctx.set('shutter', 0, 'state', 1)).success, true);
  assert.deepEqual(commands(ctx), ['GET user/action.cgi?type=shutter&num1=0']);
  assert.equal(ctx.fake.objects.shutter.status[0], 1, 'opening');
  // Close while opening: the bridge would only stop it.
  const opposite = await ctx.set('shutter', 0, 'state', -1);
  assert.equal(opposite.success, false);
  assert.match(opposite.error, /moves the other way/);
  assert.equal(commands(ctx).length, 1);
  // Stop: the reverse of the movement read now.
  assert.equal((await ctx.set('shutter', 0, 'state', 0)).success, true);
  assert.equal(commands(ctx).at(-1), 'GET user/action.cgi?type=shutter&num0=0');
  // The fake shutter does not stop at once: a second stop would reverse it.
  ctx.fake.objects.shutter.status[0] = 1;
  const again = await ctx.set('shutter', 0, 'state', 0);
  assert.equal(again.success, false);
  assert.match(again.error, /previous stop/);
  assert.equal(commands(ctx).length, 2);
  // Seen stopped: the guard falls, a stop of a stopped shutter sends nothing.
  ctx.fake.objects.shutter.status[0] = 0;
  assert.equal((await ctx.set('shutter', 0, 'state', 0)).success, true);
  assert.equal(commands(ctx).length, 2);
  assert.equal(ctx.app.stopGuards.size, 0);
});

test('setpoint: off by default, then decided on the thermostat read now', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const off = await ctx.set('thermostat', 0, 'setpoint', 21);
  assert.equal(off.success, false);
  assert.match(off.error, /disabled in the configuration/);
  assert.equal(commands(ctx).length, 0);
  await ctx.config({ allow_setpoint: true });
  await up(ctx);
  assert.equal((await ctx.set('thermostat', 0, 'setpoint', 21.5)).success, true);
  assert.deepEqual(commands(ctx), ['GET user/action.cgi?clima=0&thermo=set&val=215']);
  for (const value of [31, 4, null, '', 'x']) {
    assert.equal((await ctx.set('thermostat', 0, 'setpoint', value)).success, false, String(value));
  }
  ctx.fake.objects.clima.val[0][0][3] = 'A';
  const auto = await ctx.set('thermostat', 0, 'setpoint', 22);
  assert.match(auto.error, /automatic mode/);
  ctx.fake.objects.clima.val[0][0][3] = 'M';
  ctx.fake.objects.clima.val[0][0][2] = 'O';
  const stopped = await ctx.set('thermostat', 0, 'setpoint', 22);
  assert.match(stopped.error, /is off/);
  assert.equal(commands(ctx).length, 1);
});

test('alarm: arming and disarming are both off by default, nothing sent', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  const reads = () => ctx.fake.log.filter((l) => l.includes('area_stat')).length;
  const before = reads();
  for (const key of ['arm-total', 'arm-p1', 'arm-p12', 'disarm']) {
    const ack = await ctx.set('area', 0, key, 1);
    assert.equal(ack.success, false, key);
    assert.match(ack.error, /disabled in the configuration/);
  }
  assert.equal(commands(ctx).length, 0);
  assert.equal(reads(), before, 'not even read');
  // Allowing arming does not allow disarming.
  await ctx.config({ allow_arm: true });
  await up(ctx);
  assert.equal((await ctx.set('area', 0, 'arm-total', 1)).success, true);
  const disarm = await ctx.set('area', 0, 'disarm', 1);
  assert.match(disarm.error, /Disarming is disabled/);
  assert.deepEqual(commands(ctx), ['GET user/action.cgi?vedo=1&tot=0&force=0']);
});

test('arm: decided on the area read now, once, credited to Gladys; buttons only', async (t) => {
  const ctx = await setup(t, { config: { allow_arm: true, allow_disarm: true } });
  await up(ctx);
  const before = ctx.fake.log.length;
  assert.equal((await ctx.set('area', 0, 'arm-p1', 1)).success, true);
  assert.deepEqual(
    ctx.fake.log.slice(before),
    [
      'GET user/vedo_area_stat.json',
      'GET user/action.cgi?vedo=1&p1=0&force=0',
      'GET user/vedo_area_stat.json',
    ],
    'read, sent, then confirmed by a second read',
  );
  await sleep(60);
  await settle();
  assert.equal(ctx.state(ctx.ids('area', 0).feature('mode')), 'Armed (partial P1)');
  assert.deepEqual(ctx.events().at(-1), {
    key: 'armed',
    data: { area: '1', name: 'Maison', mode: 'armed_p1', by_gladys: true },
  });
  // Same mode: nothing sent. Another mode: refused, disarm first.
  assert.equal((await ctx.set('area', 0, 'arm-p1', 1)).success, true);
  const other = await ctx.set('area', 0, 'arm-total', 1);
  assert.match(other.error, /armed in another mode/);
  assert.equal(commands(ctx).length, 1);
  // A value other than a push is no command.
  assert.equal((await ctx.set('area', 0, 'disarm', 0)).success, false);
  assert.equal((await ctx.set('area', 0, 'disarm', 1)).success, true);
  assert.equal(commands(ctx).at(-1), 'GET user/action.cgi?vedo=1&dis=0&force=0');
  // P1 + P2 on an area without P2 is refused even if asked by id.
  assert.equal((await ctx.app.arm(1, 'armed_p12').catch((e) => e)).constructor.name, 'Refused');
});

test('keypad changes and alarms become scene events', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.fake.areas.armed[0] = 4;
  await ctx.app.bridge.readAreas();
  await settle();
  assert.deepEqual(ctx.events().at(-1), {
    key: 'armed',
    data: { area: '1', name: 'Maison', mode: 'armed_total', by_gladys: false },
  });
  ctx.fake.zones.status[1] = '0x0023';
  ctx.fake.areas.alarm[0] = 1;
  await ctx.app.bridge.readZones();
  await ctx.app.bridge.readAreas();
  await settle();
  assert.deepEqual(ctx.events().at(-1), {
    key: 'alarm_triggered',
    data: { area: '1', name: 'Maison', zone: 2 },
  });
  assert.equal(ctx.state(ctx.ids('area', 0).feature('alarm')), 1);
  assert.equal(ctx.state(ctx.ids('zone', 1).feature('alarm')), 1);
  ctx.fake.areas.armed[0] = 0;
  ctx.fake.areas.alarm[0] = 0;
  await ctx.app.bridge.readAreas();
  await settle();
  assert.deepEqual(ctx.events().at(-1), {
    key: 'disarmed',
    data: { area: '1', name: 'Maison', by_gladys: false },
  });
});

test('an option switched off while the command waits is refused, nothing sent', async (t) => {
  const ctx = await setup(t, { config: { allow_arm: true } });
  await up(ctx);
  ctx.fake.hook = async (entry) => {
    if (entry.path.includes('area_stat')) {
      ctx.fake.hook = undefined;
      // Switched off while the fresh read is on its way.
      ctx.app.config = { ...ctx.app.config, allowArm: false };
    }
    return undefined;
  };
  const ack = await ctx.set('area', 0, 'arm-total', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Arming is disabled/);
  assert.equal(commands(ctx).length, 0);
  // And right before the write (after the queue): the transport is vetoed.
  ctx.app.config = { ...ctx.app.config, allowArm: true };
  ctx.fake.hook = async (entry) => {
    if (entry.path.includes('action.cgi')) {
      ctx.fake.hook = undefined;
      ctx.app.config = { ...ctx.app.config, allowArm: false };
      return { veto: true };
    }
    return undefined;
  };
  const late = await ctx.set('area', 0, 'arm-total', 1);
  assert.match(late.error, /Arming is disabled/);
  assert.equal(commands(ctx).length, 0);
});

test('no clear answer: "sent, without confirmation", never "not sent"', async (t) => {
  const ctx = await setup(t, { config: { allow_arm: true } });
  await up(ctx);
  ctx.fake.hook = async (entry, req) => {
    if (!entry.path.includes('action.cgi')) return undefined;
    ctx.fake.hook = undefined;
    req.beforeSend();
    await sleep(FAST.answerBy + 100);
    return { error: Object.assign(new Error('timeout'), { kind: 'timeout', sent: true }) };
  };
  const ack = await ctx.set('area', 0, 'arm-total', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent, without confirmation/);
  assert.equal(ctx.app.commanded.get(0)?.mode, 'armed_total', 'credited to Gladys all the same');
  // A clear refusal of the bridge is a refusal.
  ctx.fake.hook = async (entry) =>
    entry.path.includes('action.cgi')
      ? { response: { status: 403, headers: {}, text: '' } }
      : undefined;
  const refused = await ctx.set('area', 0, 'arm-total', 1);
  assert.match(refused.error, /Refused by the bridge .*HTTP 403/);
});

test('new Vedo firmware: actions by POST, its 404 confirmed by the state read', async (t) => {
  const ctx = await setup(t, {
    config: { allow_arm: true },
    bridge: new FakeBridge({ newFirmware: true }),
  });
  await up(ctx);
  const ack = await ctx.set('area', 0, 'arm-total', 1);
  assert.equal(ack.success, true, ack.error);
  assert.match(
    commands(ctx)[0],
    /^POST user\/action\.cgi forced=0&vedo_param=1&type_param=tot&area_param=0$/,
  );
  // The action did nothing: the read shows it, not confirmed.
  ctx.fake.areas.armed[0] = 0;
  ctx.fake.hook = async (entry) =>
    entry.path.includes('action.cgi')
      ? { response: { status: 404, headers: {}, text: '' } }
      : undefined;
  const unclear = await ctx.set('area', 0, 'arm-total', 1);
  assert.match(unclear.error, /Sent, without confirmation/);
});

test('acks never wait for the publication to Gladys', async (t) => {
  const ctx = await setup(t, { config: { allow_arm: true } });
  await up(ctx);
  ctx.gladys.publishStates = () => new Promise(() => {});
  ctx.gladys.publishSceneEvent = () => new Promise(() => {});
  const ack = await Promise.race([
    ctx.set('area', 0, 'arm-total', 1),
    sleep(1500).then(() => 'stuck'),
  ]);
  assert.notEqual(ack, 'stuck');
  assert.equal(ack.success, true, ack.error);
  const light = await Promise.race([
    ctx.set('light', 0, 'state', 1),
    sleep(1500).then(() => 'stuck'),
  ]);
  assert.equal(light.success, true);
});

test('the model follows the answers in the order they came', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  // A read answered with "armed", then a later read with "disarmed".
  ctx.fake.areas.armed[0] = 4;
  const first = ctx.app.bridge.readAreas();
  const second = (async () => {
    await first;
    ctx.fake.areas.armed[0] = 0;
    return ctx.app.bridge.readAreas();
  })();
  await Promise.all([first, second]);
  await settle();
  assert.equal(ctx.state(ctx.ids('area', 0).feature('mode')), 'Disarmed');
  assert.deepEqual(
    ctx.events().map((e) => e.key),
    ['armed', 'disarmed'],
  );
});

test('a bridge PIN refused stops the logins, across restarts too', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: { bridge_pin: '9999' }, store });
  await until(
    () =>
      ctx.gladys.fake.connectionStatus.connected === false &&
      /refused/.test(ctx.gladys.fake.connectionStatus.message.en),
  );
  assert.deepEqual(ctx.fake.logins, ['dom'], 'one try only');
  assert.deepEqual(
    store.data.stops.map((s) => [s.kind, s.place]),
    [['bridge_pin', '192.0.2.10:80']],
  );
  assert.ok(!JSON.stringify(store.data).includes('9999'), 'never the PIN in /data');
  // A restart (or another setting saved) never sends it again.
  await ctx.config({ bridge_pin: '9999', poll_interval: 30 });
  await sleep(30);
  assert.deepEqual(ctx.fake.logins, ['dom']);
  const other = await setup(t, { config: { bridge_pin: '9999' }, store, bridge: ctx.fake });
  await sleep(30);
  await other.app.chain;
  assert.deepEqual(ctx.fake.logins, ['dom']);
  // A new PIN lifts the stop.
  await other.config({ bridge_pin: '1234' });
  await up(other);
  assert.deepEqual(store.data.stops, []);
});

test('a refused Vedo PIN stops the alarm only; the lights go on', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: { vedo_pin: '0000', allow_disarm: true }, store });
  await up(ctx);
  assert.equal(ctx.app.vedoState, 'refused');
  assert.deepEqual(
    store.data.stops.map((s) => s.kind),
    ['vedo_pin'],
  );
  assert.equal((await ctx.set('light', 0, 'state', 1)).success, true);
  assert.match(ctx.gladys.fake.connectionStatus.message.en, /alarm: PIN refused/);
  // The next polls never post the refused PIN again.
  await ctx.app.bridge.poll(ctx.app.bridge.generation);
  assert.deepEqual(ctx.fake.logins, ['dom', 'alm']);
  // Nor a new session of the bridge (after a network cut).
  ctx.app.bridge.cookies.clear();
  await ctx.app.bridge.session(ctx.app.bridge.generation);
  assert.deepEqual(ctx.fake.logins, ['dom', 'alm', 'dom']);
  // "Test the connection" lifts it.
  ctx.fake.vedoPin = '0000';
  const result = await ctx.gladys.fake.action('test_connection');
  assert.equal(result.success, true, result.error);
  assert.equal(ctx.app.vedoState, 'ok');
});

test('a reconnection to Gladys keeps the stops', async (t) => {
  const store = memoryStore({ stops: [{ kind: 'bridge_pin', place: '192.0.2.10:80', at: 1 }] });
  const ctx = await setup(t, { store });
  await sleep(30);
  await ctx.app.connected({ ...BASE });
  await sleep(30);
  assert.deepEqual(ctx.fake.logins, []);
  assert.equal(store.data?.stops?.length ?? 1, 1);
});

test('the bridge answers are read without prototype keys', async (t) => {
  const bridge = new FakeBridge();
  const original = bridge.answer.bind(bridge);
  bridge.answer = (...args) => {
    const res = original(...args);
    if (res.text.startsWith('{')) {
      res.text = res.text.replace(
        /^\{/,
        '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},',
      );
    }
    return res;
  };
  bridge.objects.light.desc[0] = '__proto__';
  const ctx = await setup(t, { bridge });
  await up(ctx);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(ctx.device(ctx.ids('light', 0).device).name, '__proto__', 'a name, nothing more');
});

test('door: off by default; when allowed, decided on the fresh configuration, guarded', async (t) => {
  const config = { intercom_host: '192.0.2.11', intercom_token: 'icona-token-0123456789' };
  const ctx = await setup(t, { config });
  await up(ctx);
  await until(() => ctx.app.doorState === 'ok');
  const connections = ctx.intercom.connections;
  const off = await ctx.set('door', 'SB100001-2', 'open', 1);
  assert.match(off.error, /Opening doors is disabled/);
  assert.equal(ctx.intercom.connections, connections, 'not even connected');
  await ctx.config({ ...config, allow_door: true });
  await until(() => ctx.app.doorState === 'ok');
  await ctx.app.queues.get('door');
  ctx.intercom.received = [];
  const ack = await ctx.set('door', 'SB100001-2', 'open', 1);
  // Every frame written, still no confirmation from the bridge.
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent, without confirmation/);
  assert.deepEqual(ctx.intercom.log, [
    'open UAUT',
    'access',
    'end',
    'open UCFG',
    'get-configuration',
    'open INFO',
    'server-info',
    'get-configuration',
    'server-info',
    'end',
    'open CTPP',
    'bin c0185c8b',
    'bin 005c8b2c',
    'bin 205c8b2c',
    'bin c01870ab',
    'bin 005c8b2c',
    'bin 205c8b2c',
  ]);
  const again = await ctx.set('door', 'SB100001-2', 'open', 1);
  assert.match(again.error, /just opened/);
  // Switched off during the sequence: stopped before the first opening frame.
  ctx.app.doorGuards.clear();
  ctx.intercom.received = [];
  ctx.intercom.onJson = (message) => {
    if (message.message === 'server-info') ctx.app.config = { ...ctx.app.config, allowDoor: false };
  };
  const withdrawn = await ctx.set('door', 'SB100001-1', 'open', 1);
  assert.match(withdrawn.error, /Opening doors is disabled/);
  assert.ok(!ctx.intercom.log.some((l) => l.startsWith('bin')), 'no frame of the opening');
});

test('door: a refused token stops the intercom, persisted', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, {
    config: { intercom_host: '192.0.2.11', intercom_token: 'wrong-token-000', allow_door: true },
    store,
  });
  await up(ctx);
  await until(() => ctx.app.doorState === 'refused');
  assert.deepEqual(
    store.data.stops.map((s) => s.kind),
    ['icona_token'],
  );
  const connections = ctx.intercom.connections;
  await ctx.app.scan();
  await sleep(30);
  assert.equal(ctx.intercom.connections, connections, 'no new try');
});

test('the PINs and the token never reach the logs', async (t) => {
  const ctx = await setup(t, {
    config: {
      bridge_pin: '424242',
      vedo_pin: '0000',
      intercom_host: '192.0.2.11',
      intercom_token: 'secret-token-abcdef',
      allow_door: true,
    },
    bridge: new FakeBridge({ pin: '424242' }),
  });
  await up(ctx);
  await until(() => ctx.app.doorState === 'refused');
  await ctx.set('light', 0, 'state', 1);
  const text = ctx.logger.lines.join('\n');
  for (const secret of ['424242', '0000', 'secret-token-abcdef', 'uid=s1']) {
    assert.ok(!text.includes(secret), `${secret} in the logs`);
  }
});

test('a Vedo IP of its own: its own session, its own link device', async (t) => {
  const bridge = new FakeBridge();
  const vedo = new FakeBridge({ kind: 'vedo', vedoPin: '5678' });
  const transport = (req) =>
    req.host === '192.0.2.20' ? vedo.transport(req) : bridge.transport(req);
  const ctx = await setup(t, {
    config: { vedo_host: '192.0.2.20', allow_disarm: true },
    bridge: { transport, log: [], logins: [] },
  });
  await until(() => ctx.app.bridgeOnline && ctx.app.vedoOnline);
  await ctx.app.chain;
  assert.deepEqual(vedo.logins, ['code']);
  assert.deepEqual(bridge.logins, ['dom'], 'no alarm login on the bridge');
  vedo.areas.armed[1] = 4;
  const ack = await ctx.set('area', 1, 'disarm', 1);
  assert.equal(ack.success, true, ack.error);
  assert.ok(vedo.log.includes('GET action.cgi?vedo=1&dis=1&force=0'));
  assert.ok(ctx.device(ctx.gladys.externalIds('vedo', 'comelit').device));
});

test('"Test the connection" never brings back an option switched off', async (t) => {
  const ctx = await setup(t, { config: { allow_arm: true } });
  await up(ctx);
  await ctx.gladys.fake.configUpdated({ ...BASE, allow_arm: false });
  assert.equal(ctx.app.config.allowArm, false, 'applied at once');
  // The bridge is cut: the button restarts the session.
  ctx.fake.hook = async () => ({
    error: Object.assign(new Error('cut'), { kind: 'offline', sent: false }),
  });
  ctx.app.bridge.lost(ctx.app.bridge.generation, 'cut');
  await settle();
  ctx.fake.hook = undefined;
  const result = await ctx.gladys.fake.action('test_connection');
  assert.equal(result.success, true, result.error);
  assert.equal(ctx.app.config.allowArm, false, 'still off after the restart');
  await up(ctx);
  const ack = await ctx.set('area', 0, 'arm-total', 1);
  assert.match(ack.error, /Arming is disabled/);
  assert.equal(commands(ctx).length, 0);
});

test('B2: a slot of the intercom book given to another target: the old device opens nothing', async (t) => {
  const config = {
    intercom_host: '192.0.2.11',
    intercom_token: 'icona-token-0123456789',
    allow_door: true,
  };
  const ctx = await setup(t, { config });
  await up(ctx);
  await until(() => ctx.app.doorState === 'ok');
  await ctx.app.chain;
  const old = ctx.device(ctx.ids('door', 'SB100001-2').device);
  assert.ok(old, 'the id names the target: address and output');
  // The same slot (id 1) now opens output 3.
  ctx.intercom.configuration.vip['user-parameters']['opendoor-address-book'][0]['output-index'] = 3;
  ctx.intercom.received = [];
  const press = () =>
    ctx.gladys.fake.setValue(
      old,
      old.features.find((f) => f.external_id.endsWith(':open')),
      1,
    );
  const first = await press();
  assert.match(first.error, /no longer in the intercom configuration/);
  await until(() => ctx.app.model.doors.has('SB100001-3'));
  await ctx.app.chain;
  const second = await press();
  assert.match(second.error, /no longer in the intercom configuration/);
  assert.ok(!ctx.intercom.log.some((l) => l.startsWith('bin')), 'no frame to any target');
  assert.ok(ctx.device(ctx.ids('door', 'SB100001-3').device), 'a new device for the new target');
});

test('S: "stop everything" while a shutter reaches its end: no reverse command', async (t) => {
  const bridge = new FakeBridge();
  bridge.objects.shutter = { desc: ['Volet 1', 'Volet 2'], status: [2, 2] };
  const ctx = await setup(t, { bridge });
  await up(ctx);
  // While the first stop goes, the second shutter arrives at its end.
  bridge.hook = async (entry) => {
    if (entry.path.includes('action.cgi') && entry.query.num1 === '0') {
      bridge.hook = undefined;
      bridge.objects.shutter.status[1] = 0;
    }
    return undefined;
  };
  const acks = await Promise.all([
    ctx.set('shutter', 0, 'state', 0),
    ctx.set('shutter', 1, 'state', 0),
  ]);
  assert.deepEqual(
    acks.map((a) => a.success),
    [true, true],
  );
  assert.deepEqual(
    commands(ctx),
    ['GET user/action.cgi?type=shutter&num1=0'],
    'nothing to shutter 2',
  );
});

test('A3: a start queued behind a newer save uses the newer configuration', async (t) => {
  const ctx = await setup(t, { config: { allow_arm: false } });
  await up(ctx);
  const first = ctx.app.configUpdated({ ...BASE, allow_arm: true, poll_interval: 20 });
  const second = ctx.app.configUpdated({ ...BASE, allow_arm: false });
  await Promise.all([first, second]);
  await ctx.app.starting;
  assert.equal(ctx.app.config.allowArm, false);
  assert.equal(ctx.app.rawConfig.allow_arm, false);
});

test('"Test the connection" never starts on an empty configuration', async (t) => {
  const ctx = await setup(t);
  await up(ctx);
  ctx.gladys.getConfig = async () => ({});
  const result = await ctx.gladys.fake.action('test_connection');
  assert.equal(result.success, false);
  assert.match(result.error, /could not be read/);
  assert.equal(ctx.app.bridge.connected, true, 'the running session is kept');
});
test('alarm: a 200 alone, or a state read that did not change, is no confirmation', async (t) => {
  const ctx = await setup(t, { config: { allow_arm: true, allow_disarm: true } });
  await up(ctx);
  // Older firmware: 200, but the Vedo did nothing.
  ctx.fake.hook = async (entry) =>
    entry.path.includes('action.cgi')
      ? { response: { status: 200, headers: {}, text: '' } }
      : undefined;
  const arm = await ctx.set('area', 0, 'arm-total', 1);
  assert.match(arm.error, /Sent, without confirmation/);
  // Disarm: the alarm still rings after it, nothing changed.
  ctx.fake.areas.armed[0] = 0;
  ctx.fake.areas.alarm[0] = 1;
  await ctx.app.bridge.readAreas();
  const disarm = await ctx.set('area', 0, 'disarm', 1);
  assert.match(disarm.error, /Sent, without confirmation/);
  ctx.fake.hook = undefined;
});

test('"close everything": eight shutters at once all leave in time', async (t) => {
  const bridge = new FakeBridge();
  bridge.objects.shutter = {
    desc: Array.from({ length: 8 }, (_, i) => `Volet ${i + 1}`),
    status: Array(8).fill(0),
  };
  const timings = { ...FAST, gap: 250, sendBy: 3_500, answerBy: 4_500, readBefore: 1_500 };
  const ctx = await setup(t, { bridge, timings });
  await up(ctx);
  const acks = await Promise.all(
    Array.from({ length: 8 }, (_, i) => ctx.set('shutter', i, 'state', -1)),
  );
  assert.deepEqual(
    acks.map((a) => a.success),
    Array(8).fill(true),
    JSON.stringify(acks.map((a) => a.error)),
  );
  assert.deepEqual(bridge.objects.shutter.status, Array(8).fill(2), 'all closing');
});

test('arm buttons follow P1 and P2 of each area; open refused while a stop is pending', async (t) => {
  const bridge = new FakeBridge();
  bridge.areas.p1_pres = [1, 0, 0];
  const ctx = await setup(t, { bridge });
  await up(ctx);
  const keys = (i) =>
    ctx.device(ctx.ids('area', i).device).features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(keys(0).includes('arm-p1'));
  assert.ok(!keys(1).includes('arm-p1'));
  ctx.fake.objects.shutter.status[0] = 2;
  assert.equal((await ctx.set('shutter', 0, 'state', 0)).success, true);
  // The fake shutter has not stopped yet.
  ctx.fake.objects.shutter.status[0] = 2;
  const open = await ctx.set('shutter', 0, 'state', 1);
  assert.match(open.error, /previous stop/);
  assert.ok(ctx.logger.lines.some((l) => /Command REFUSED \(.*shutter:0:state\)/.test(l)));
});
