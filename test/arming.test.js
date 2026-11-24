// -----------------------------------------------------------------------------
// Arming is protective: on a slow Vedo (each request answered in 700-900 ms,
// production TIMINGS, real timers), every arm asked leaves, never "nothing
// was sent" because the line was busy with confirmation reads, polls or a
// disarm; an arm total leaves even when the area state cannot be read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ComelitApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FakeBridge, FakeIcona, quietLogger, settle, sleep, until } from './helpers/fakeComelit.js';

const BASE = { host: '192.0.2.10', bridge_pin: '1234', vedo_pin: '5678', language: 'en' };

/**
 * The app on a bridge that, once the startup is over, answers every request
 * after `latency` ms (the startup itself runs at full speed: a dozen requests
 * and the Vedo login waits, not what is measured here).
 */
async function setup(t, latency, config = {}, prepare = () => {}) {
  const gladys = createFakeGladys({ config: { ...BASE, ...config } });
  const fake = new FakeBridge();
  prepare(fake);
  const slow = { latency: 0 };
  const transport = async (req) => {
    const res = await fake.transport(req);
    if (slow.latency) await sleep(slow.latency);
    return res;
  };
  const logger = quietLogger();
  const app = new ComelitApp({
    gladys,
    logger,
    transport,
    connectIcona: new FakeIcona().connect,
    store: memoryStore(),
    timings: { ...TIMINGS, backoff: [60_000] },
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop({ final: true }));
  await gladys.connect();
  const ids = (kind, i) => gladys.externalIds(kind, String(i));
  const set = (kind, i, key, value) => {
    const d = gladys.fake.discoveredDevices.find((x) => x.external_id === ids(kind, i).device);
    const f = d.features.find((x) => x.external_id === ids(kind, i).feature(key));
    return gladys.fake.setValue(d, f, value);
  };
  await until(() => app.bridgeOnline && app.vedoOnline, 20_000);
  await app.chain;
  await settle();
  slow.latency = latency;
  return { gladys, fake, app, logger, set };
}

const actions = (ctx) => ctx.fake.log.filter((l) => l.includes('action.cgi'));
const armsOf = (ctx) => actions(ctx).filter((l) => /tot=|p1=|p12=/.test(l));

test('three areas armed together on a 700 ms Vedo: all three written', async (t) => {
  const ctx = await setup(t, 700, {}, (f) => {
    f.areas.present[2] = 1;
    f.areas.description[2] = 'Bureau';
  });
  const started = Date.now();
  const acks = await Promise.all([0, 1, 2].map((i) => ctx.set('area', i, 'arm-total', 1)));
  const took = Date.now() - started;
  for (const [i, ack] of acks.entries()) {
    assert.ok(ack.success || /without confirmation/.test(ack.error), `area ${i}: ${ack.error}`);
    assert.doesNotMatch(ack.error ?? '', /nothing was sent/i, `area ${i}`);
  }
  assert.deepEqual(ctx.fake.areas.armed.slice(0, 3), [4, 4, 4], 'the Vedo armed the three');
  assert.equal(armsOf(ctx).length, 3, 'three arm requests');
  assert.ok(took < 5_000, `acks within Gladys' 5 s (${took} ms)`);
});

test('two areas armed together on a 900 ms Vedo: both written', async (t) => {
  const ctx = await setup(t, 900);
  const acks = await Promise.all([0, 1].map((i) => ctx.set('area', i, 'arm-total', 1)));
  for (const [i, ack] of acks.entries()) {
    assert.doesNotMatch(ack.error ?? '', /nothing was sent/i, `area ${i}: ${ack.error}`);
  }
  assert.deepEqual(ctx.fake.areas.armed.slice(0, 2), [4, 4]);
  assert.equal(ctx.fake.log.filter((l) => l.includes('area_stat')).length > 0, true);
});

test('an arm asked while an allowed disarm of another area is under way (700 ms): both go', async (t) => {
  const ctx = await setup(t, 700, { allow_disarm: true }, (f) => {
    f.areas.armed[1] = 4;
  });
  const disarm = ctx.set('area', 1, 'disarm', 1);
  await sleep(100);
  const arm = ctx.set('area', 0, 'arm-total', 1);
  const [d, a] = await Promise.all([disarm, arm]);
  // The arm goes, ahead of the disarm and its confirmation reads. The disarm
  // (sensitive) is done, or honestly refused "nothing was sent" when the arm
  // and a poll took its time on the line: the area then stays armed.
  assert.doesNotMatch(a.error ?? '', /nothing was sent/i, `arm: ${a.error}`);
  assert.equal(ctx.fake.areas.armed[0], 4, 'area 1 armed');
  assert.ok(armsOf(ctx).length === 1, 'one arm request');
  if (d.success || /without confirmation/.test(d.error)) {
    assert.equal(ctx.fake.areas.armed[1], 0, 'area 2 disarmed');
  } else {
    assert.match(d.error, /nothing was sent/);
    assert.equal(ctx.fake.areas.armed[1], 4, 'area 2 untouched');
  }
});

test('arm total when the fresh area read answers garbage: sent anyway', async (t) => {
  const ctx = await setup(t, 0);
  ctx.fake.hook = async (entry) => {
    if (entry.path.includes('area_stat')) {
      ctx.fake.hook = undefined;
      return { response: { status: 200, headers: {}, text: 'not json' } };
    }
    return undefined;
  };
  const ack = await ctx.set('area', 0, 'arm-total', 1);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(armsOf(ctx), ['GET user/action.cgi?vedo=1&tot=0&force=0']);
  assert.ok(ctx.logger.lines.some((l) => /could not be read .*sent anyway/.test(l)));
});

test('arm P1 on an unreadable state with "armed total" in memory: refused, nothing sent', async (t) => {
  const ctx = await setup(t, 0, {}, (f) => {
    f.areas.armed[0] = 4;
  });
  assert.equal(ctx.app.model.vedo.areas.get(0).status.level, 4);
  ctx.fake.hook = async (entry) =>
    entry.path.includes('area_stat')
      ? { response: { status: 200, headers: {}, text: '{"logged":1' } }
      : undefined;
  const ack = await ctx.set('area', 0, 'arm-p1', 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /last state known protects as much: nothing was sent/);
  assert.deepEqual(armsOf(ctx), []);
});
