'use strict';

// "Available today" for the home (#30) and for cars/batteries (#68)

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeHomey } = require('./helpers/homey-stub');
const { step, percent, MAX_GAP_MS } = require('../lib/availability');
const GridRewardSubscription = require('../lib/GridRewardSubscription');

const subs = [];
GridRewardSubscription.prototype.start = function start() { this._stopped = false; subs.push(this); };

const GridRewardDevice = require('../drivers/grid-reward/device');
const FlexDevice = require('../drivers/flex-device/device');

const MIN = 60 * 1000;
const DAY = '2026-11-17';

test('step: time counts for the state it was spent in', () => {
  let s = step(null, { gridState: 'available', now: 0, dayKey: DAY });
  s = step(s, { gridState: 'delivering', now: 3 * MIN, dayKey: DAY }); // 3 min available
  s = step(s, { gridState: 'unavailable', now: 4 * MIN, dayKey: DAY }); // 1 min delivering
  s = step(s, { gridState: 'unavailable', now: 8 * MIN, dayKey: DAY }); // 4 min unavailable
  assert.strictEqual(s.observedMs, 8 * MIN);
  assert.strictEqual(s.availableMs, 4 * MIN);
  assert.strictEqual(percent(s), 50);
});

test('step: long gaps (Homey off) and unknown states are not counted', () => {
  let s = step(null, { gridState: 'available', now: 0, dayKey: DAY });
  s = step(s, { gridState: 'available', now: MAX_GAP_MS + 1, dayKey: DAY });
  assert.strictEqual(s.observedMs, 0);
  s = step(s, { gridState: 'unknown', now: MAX_GAP_MS + MIN + 1, dayKey: DAY });
  s = step(s, { gridState: 'available', now: MAX_GAP_MS + 2 * MIN + 1, dayKey: DAY });
  assert.strictEqual(s.observedMs, MIN, 'the minute in "unknown" is left out');
  assert.strictEqual(percent(s), 100);
});

test('a new day starts from 0; nothing to show before a minute is observed', () => {
  let s = step(null, { gridState: 'available', now: 0, dayKey: DAY });
  s = step(s, { gridState: 'available', now: 2 * MIN, dayKey: DAY });
  s = step(s, { gridState: 'available', now: 3 * MIN, dayKey: '2026-11-18' });
  assert.strictEqual(s.dayKey, '2026-11-18');
  assert.strictEqual(s.observedMs, MIN, 'the minute across midnight goes to the new day');
  assert.strictEqual(percent(null), null);
  assert.strictEqual(percent(step(null, { gridState: 'available', now: 0, dayKey: DAY })), null);
});

test('real day: home and battery always available, the car only until it was unplugged', async (t) => {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'real-2026-11-17.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  let now = lines[0].t;
  t.mock.method(Date, 'now', () => now);
  // new Date() is not mocked: give the devices a fixed day.
  t.mock.method(GridRewardDevice.prototype, '_dayKey', () => DAY);
  t.mock.method(FlexDevice.prototype, '_dayKey', () => DAY);
  subs.length = 0;
  const homey = makeHomey();
  const home = new GridRewardDevice({ homey, data: { id: 'home-1' }, store: { email: 'a@example.com', password: 'pw' } });
  const car = new FlexDevice({ homey, data: { id: 'vehicle-1', homeId: 'home-1', kind: 'vehicle' } });
  homey.drivers.registry['grid-reward'] = { getDevices: () => [home] };
  homey.drivers.registry['flex-device'] = { getDevices: () => [car] };
  await home.onInit();
  const homeTick = homey.timers.filter((x) => x.ms === MIN && !x.cleared).pop();
  await car.onInit();
  const carTick = homey.timers.filter((x) => x.ms === MIN && !x.cleared).pop();

  // Updates as recorded, with the minute ticks in between.
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    while (now + MIN < l.t) {
      now += MIN;
      homeTick.fn();
      await home._queue;
      await carTick.fn();
    }
    now = l.t;
    subs[0].emit('data', l.status, 'home-1');
    await home._queue;
  }

  assert.strictEqual(home.getCapabilityValue('grid_reward_availability'), 100);
  // The car was available 20:20–07:09 UTC (10.8 h) of the 21.7 h recording, then unplugged.
  assert.strictEqual(car.getCapabilityValue('grid_reward_availability'), 50);
  await home.onUninit();
  await car.onUninit();
  assert.ok(car.getStoreValue('availability').observedMs > 10 * 60 * MIN, 'saved when the device stops');
});
