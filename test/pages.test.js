// The bridge and Vedo pages, read as aiocomelit 3.0.0 reads them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  areaState,
  bridgeLogged,
  parseAreaDescription,
  parseAreaStatus,
  parseClima,
  parseDescription,
  parsePage,
  parseZoneDescription,
  parseZoneStatus,
  zoneFlags,
} from '../src/comelit/pages.js';

test('login.json: logged unless domus is twelve zeros', () => {
  assert.equal(bridgeLogged({ domus: '000000000000' }), false);
  assert.equal(bridgeLogged({ domus: '0a1b2c3d4e5f' }), true);
  assert.throws(() => bridgeLogged({}), /unexpected/);
});

test('icon_desc: names, rooms, statuses; placeholders skipped; an empty desc is an error', () => {
  const objects = parseDescription(
    {
      num: 3,
      desc: ['Salon', '', 'Cuisine'],
      env: [1, 0, 2],
      env_desc: ['', 'Séjour', 'Cuisine'],
      status: [1, 0, '0'],
      val: [0, 0, 0],
      protected: [0, 0, 1],
    },
    'light',
  );
  assert.deepEqual([...objects.keys()], [0, 2]);
  assert.deepEqual(objects.get(0), {
    name: 'Salon',
    room: 'Séjour',
    status: 1,
    val: 0,
    protected: false,
  });
  assert.equal(objects.get(2).status, 0);
  assert.equal(objects.get(2).protected, true);
  assert.throws(() => parseDescription({ num: 2, desc: [], status: [] }, 'light'), /empty/);
  assert.throws(() => parseDescription({ num: 2, desc: ['a'], status: [] }, 'light'));
  assert.equal(parseDescription({ num: 0, desc: [], status: [] }, 'light').size, 0);
});

test('clima: tenths of a degree, mode, manual or automatic, humidifier only', () => {
  assert.deepEqual(parseClima([[221, 0, 'U', 'M', 50, 0, 0, 'U'], [650], [0, 0]]), {
    temperature: 22.1,
    setpoint: 5,
    active: false,
    mode: 'U',
    automatic: false,
    thermostat: true,
  });
  assert.equal(parseClima([[0, 0, 'O', 'A', 0]]).thermostat, false);
  assert.equal(parseClima([[200, 1, 'X', 'Z', 210]]).mode, undefined);
  assert.equal(parseClima('nope'), undefined);
});

test('areas: present only, levels, delays; aiocomelit state order', () => {
  const areas = parseAreaDescription({
    present: [1, 0, 1],
    description: ['Maison', 'x', 'Garage'],
    p1_pres: [1, 0, 1],
    p2_pres: [1, 0, 0],
  });
  assert.deepEqual(
    [...areas.entries()],
    [
      [0, { name: 'Maison', p1: true, p2: true }],
      [2, { name: 'Garage', p1: true, p2: false }],
    ],
  );
  const zeros = [0, 0];
  const status = parseAreaStatus({
    ready: zeros,
    armed: [3, 9],
    alarm: [0, 1],
    alarm_memory: zeros,
    sabotage: zeros,
    anomaly: zeros,
    in_time: zeros,
    out_time: [1, 0],
  });
  assert.equal(status.get(0).mode, 'armed_p12');
  assert.equal(status.get(1).mode, undefined, 'an unknown level is no mode');
  assert.equal(areaState(status.get(0)), 'exit_delay');
  assert.equal(areaState(status.get(1)), 'triggered');
  assert.equal(areaState({ mode: 'disarmed' }), 'disarmed');
  assert.equal(areaState({ mode: 'armed_total' }), 'armed');
  assert.throws(() => parseAreaStatus({ armed: [0] }), /unexpected/);
});

test('zones: present as a list or a string, hexadecimal statuses, bits', () => {
  const zones = parseZoneDescription({ present: ['1', '0', 1], description: ['A', 'B', 'C'] });
  assert.deepEqual([...zones.keys()], [0, 2]);
  assert.deepEqual(
    [...parseZoneDescription({ present: '0,1', description: ['A', 'B'] }).keys()],
    [1],
  );
  assert.deepEqual(parseZoneStatus({ status: '0x0000,0x0023,zz,0x8000' }), [
    0,
    0x23,
    undefined,
    0x8000,
  ]);
  assert.deepEqual(zoneFlags(0x23), {
    open: true,
    alarm: true,
    faulty: false,
    sabotage: false,
    excluded: false,
    unavailable: false,
  });
  assert.equal(zoneFlags(0x100).excluded, true, 'isolated counts as excluded');
  assert.equal(zoneFlags(undefined), undefined);
});

test('pages: JSON only, no prototype keys', () => {
  assert.throws(() => parsePage('<html>', 'x'), /not JSON/);
  assert.throws(() => parsePage('[1]', 'x'), /not an object/);
  const page = parsePage(
    '{"__proto__":{"polluted":1},"a":{"constructor":{"prototype":{"p":1}}}}',
    'x',
  );
  assert.equal(page.polluted, undefined);
  assert.equal(Object.hasOwn(page, '__proto__'), false);
  assert.equal({}.polluted, undefined);
  assert.equal({}.p, undefined);
});
