'use strict';

// Shared device helpers, and how many writes a real day causes.

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeHomey, Device } = require('./helpers/homey-stub');
const { setIfChanged, applyCurrency, UnavailableWatch } = require('../lib/deviceUtils');
const { parseJsonl } = require('../tools/replay');
const GridRewardSubscription = require('../lib/GridRewardSubscription');

const subs = [];
GridRewardSubscription.prototype.start = function start() { this._stopped = false; subs.push(this); };
const GridRewardDevice = require('../drivers/grid-reward/device');

test('setIfChanged writes only changed values and skips null and missing capabilities', async () => {
  const d = new Device({
    homey: makeHomey(), data: {}, capabilities: { a: 1, b: 'x' }, capabilityList: ['a', 'b', 'c'],
  });
  const writes = [];
  const orig = d.setCapabilityValue.bind(d);
  d.setCapabilityValue = (k, v) => { writes.push(k); return orig(k, v); };
  assert.strictEqual(await setIfChanged(d, {
    a: 1, b: 'y', c: null, missing: 5,
  }), 1);
  assert.deepStrictEqual(writes, ['b']);
  assert.strictEqual(d.getCapabilityValue('b'), 'y');
});

test('applyCurrency sets the unit once and accepts ISO codes or ready units', async () => {
  const d = new Device({ homey: makeHomey(), data: {}, capabilityList: ['m'] });
  await applyCurrency(d, ['m', 'not_there'], 'EUR');
  assert.deepStrictEqual(d.capabilityOptions, { m: { units: { en: '€' } } });
  d.capabilityOptions = {};
  await applyCurrency(d, ['m'], 'EUR');
  assert.deepStrictEqual(d.capabilityOptions, {});
  await applyCurrency(d, ['m'], 'kr');
  assert.deepStrictEqual(d.capabilityOptions, { m: { units: { en: 'kr' } } });
  await applyCurrency(d, ['m'], null);
});

test('UnavailableWatch keeps the start in the store and triggers its card', async (t) => {
  let now = Date.parse('2026-11-17T08:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const homey = makeHomey();
  const d = new Device({ homey, data: {} });
  const w = new UnavailableWatch(d, 'my_card');
  await w.check('unavailable', { text: 'T', code: 'c' });
  assert.strictEqual(d.getStoreValue('unavailableSince'), now);
  now += 90 * 60 * 1000;
  await w.check('unavailable', { text: 'T', code: 'c' });
  assert.deepStrictEqual(homey.triggered.map((x) => [x.id, x.tokens.hours]), [['my_card', 1.5]]);
  // A new watch after a restart continues the period
  assert.strictEqual(new UnavailableWatch(d, 'my_card').watch.since, now - 90 * 60 * 1000);
  await w.check('available', { text: '', code: '' });
  assert.strictEqual(d.getStoreValue('unavailableSince'), null);
});

test('real day through the home device: writes only what changed', async (t) => {
  const recs = parseJsonl(fs.readFileSync(path.join(__dirname, 'fixtures', 'real-2026-11-17.jsonl'), 'utf8'));
  let now = recs[0].t;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['Date'], now });
  subs.length = 0;
  const homey = makeHomey();
  const device = new GridRewardDevice({ homey, data: { id: 'home-1' }, store: { email: 'a@example.com', password: 'pw' } });
  homey.drivers.registry['grid-reward'] = { getDevices: () => [device] };
  await device.onInit();
  const count = { caps: 0, tracker: 0 };
  const setCap = device.setCapabilityValue.bind(device);
  const setStore = device.setStoreValue.bind(device);
  device.setCapabilityValue = (k, v) => { count.caps += 1; return setCap(k, v); };
  device.setStoreValue = (k, v) => { if (k === 'tracker') count.tracker += 1; return setStore(k, v); };

  for (const r of recs) {
    now = r.t;
    t.mock.timers.setTime(now);
    subs[0].emit('data', r.status);
    await device._queue;
  }
  // Measured on the previous version: 1 502 capability writes and 209 tracker writes.
  // Now: 404 and 95.
  assert.ok(count.caps < 500, `capability writes: ${count.caps}`);
  assert.ok(count.tracker <= 100, `tracker writes: ${count.tracker}`);
  assert.strictEqual(device.getCapabilityValue('grid_reward_sessions_month'), 9);
  t.diagnostic(`capability writes ${count.caps}, tracker writes ${count.tracker}`);
  await device.onUninit();
});
