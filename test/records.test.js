'use strict';

// Records for the home (#31) and for each car/battery (#73)

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const { onSession, onDay, seed } = require('../lib/records');
const GridRewardSubscription = require('../lib/GridRewardSubscription');

const subs = [];
GridRewardSubscription.prototype.start = function start() { this._stopped = false; subs.push(this); };

const GridRewardDevice = require('../drivers/grid-reward/device');
const FlexDevice = require('../drivers/flex-device/device');
const history = require('../lib/history');

test('the first values are set quietly; only beating a record counts', () => {
  let r = onSession(undefined, { reward: 1.2, minutes: 30, endedAt: 1 });
  assert.deepStrictEqual(r.broken, []);
  r = onSession(r.rec, { reward: 1.2, minutes: 45, endedAt: 2 }); // equal reward is no record
  assert.deepStrictEqual(r.broken, [{ type: 'longestSession', value: 45, previous: 30 }]);
  r = onSession(r.rec, { reward: 2.555, minutes: 10, endedAt: 3 });
  assert.deepStrictEqual(r.broken, [{ type: 'bestSession', value: 2.56, previous: 1.2 }]);
  assert.deepStrictEqual(r.rec.bestSession, { value: 2.56, at: 3 });
  let d = onDay(r.rec, { reward: 10, date: '2026-11-17' });
  assert.deepStrictEqual(d.broken, []);
  d = onDay(d.rec, { reward: 12.4, date: '2026-11-18' });
  assert.deepStrictEqual(d.broken, [{ type: 'bestDay', value: 12.4, previous: 10 }]);
  assert.deepStrictEqual(onDay(d.rec, { reward: 0, date: 'x' }).rec, d.rec, 'a day without reward changes nothing');
});

test('seed: from the history, for the home and for one device (its share)', () => {
  const sessions = [
    { reward: 2, minutes: 30, endedAt: 1, flex: ['car', 'bat'] },
    { reward: 1.5, minutes: 60, endedAt: 2, flex: ['car'] },
    { reward: 5, minutes: 20, endedAt: 3 },
  ];
  const days = [{ date: '2026-11-17', reward: 8.5 }];
  assert.deepStrictEqual(seed({ sessions, days }), {
    bestSession: { value: 5, at: 3 },
    longestSession: { value: 60, at: 2 },
    bestDay: { value: 8.5, at: '2026-11-17' },
  });
  assert.deepStrictEqual(seed({ sessions, days, flexId: 'car' }), {
    bestSession: { value: 1.5, at: 2 },
    longestSession: { value: 60, at: 2 },
  });
});

// --- On the devices ---

const st = (typename, month, carState) => ({
  homeId: 'h1',
  state: { __typename: typename },
  rewardCurrentMonth: month,
  rewardAllTime: 100,
  flexDevices: [{
    __typename: 'GridRewardVehicle', kind: 'vehicle', vehicleId: 'v1', shortName: 'Car', isPluggedIn: true, state: { __typename: carState },
  }],
});

async function setup(t, settings = {}) {
  let now = Date.parse('2026-11-17T08:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(GridRewardDevice.prototype, '_dayKey', () => '2026-11-17');
  subs.length = 0;
  const homey = makeHomey();
  Object.assign(homey.settings.values, settings);
  const home = new GridRewardDevice({ homey, data: { id: 'h1' }, store: { email: 'a@example.com', password: 'pw' } });
  home.getName = () => 'Home';
  const car = new FlexDevice({ homey, data: { id: 'v1', homeId: 'h1', kind: 'vehicle' } });
  car.getName = () => 'My car';
  homey.drivers.registry['grid-reward'] = { getDevices: () => [home] };
  homey.drivers.registry['flex-device'] = { getDevices: () => [car] };
  await home.onInit();
  await car.onInit();
  const send = async (s) => { subs[0].emit('data', s, 'h1'); await home._queue; };
  const session = async (from, to, minutes) => {
    await send(st('GridRewardDelivering', from, 'GridRewardDelivering'));
    now += minutes * 60 * 1000;
    await send(st('GridRewardAvailable', to, 'GridRewardAvailable'));
    now += 60 * 1000;
    await send(st('GridRewardAvailable', to + 0.01, 'GridRewardAvailable')); // settlement
  };
  return {
    homey, home, car, send, session,
  };
}

test('existing history becomes the starting records, so updating does not fire cards', async (t) => {
  const { homey } = await setup(t, {
    'history:h1': [{
      reward: 3, minutes: 40, endedAt: 1, flex: ['v1'],
    }],
  });
  assert.deepStrictEqual(homey.settings.get('records:h1').v1.bestSession, { value: 3, at: 1 });
  assert.strictEqual(homey.triggered.filter((x) => /record/.test(x.id)).length, 0);
});

test('a better session fires the record card on the home and on the car', async (t) => {
  const {
    homey, home, car, send, session,
  } = await setup(t);
  await send(st('GridRewardAvailable', 10, 'GridRewardAvailable'));
  await session(10, 11, 15); // first: sets the records quietly
  assert.strictEqual(homey.triggered.filter((x) => /record/.test(x.id)).length, 0);
  await session(11.01, 13, 30); // better and longer
  const fired = homey.triggered.filter((x) => /record/.test(x.id));
  assert.deepStrictEqual(fired.map((x) => [x.id, x.device === car ? 'car' : 'home', x.tokens.record, x.tokens.value]), [
    ['record_broken', 'home', 'Best session', 2],
    ['record_broken', 'home', 'Longest session', 30],
    ['flex_record_broken', 'car', 'Best session', 2],
    ['flex_record_broken', 'car', 'Longest session', 30],
  ]);
  assert.strictEqual(fired[0].tokens.previous, 1.01);

  // The history page lists them, with the car under its own name.
  const page = history.getHistory({ homey });
  assert.deepStrictEqual(page.homes[0].records.map((r) => [r.name, r.items.map((i) => i.type)]), [
    ['Home', ['bestSession', 'longestSession']],
    ['My car', ['bestSession', 'longestSession']],
  ]);
  assert.deepStrictEqual(page.homes[0].devices, ['My car']);
  assert.deepStrictEqual(page.homes[0].sessions[0].devices, ['My car']);
  await home.onUninit();
  await car.onUninit();
});

test('best day: the home and the car, when the day ends', async (t) => {
  const {
    homey, home, car, send, session,
  } = await setup(t, {
    'records:h1': { home: { bestDay: { value: 1, at: '2026-11-16' } }, v1: { bestDay: { value: 0.5, at: '2026-11-16' } } },
  });
  await send(st('GridRewardAvailable', 10, 'GridRewardAvailable'));
  await session(10, 12, 15);
  t.mock.method(GridRewardDevice.prototype, '_dayKey', () => '2026-11-18');
  await home._tickDay();
  const fired = homey.triggered.filter((x) => /record/.test(x.id) && x.tokens.record === 'Best day');
  assert.deepStrictEqual(fired.map((x) => [x.id, x.tokens.value, x.tokens.previous]), [
    ['record_broken', 2.01, 1],
    ['flex_record_broken', 2.01, 0.5],
  ]);
  await home.onUninit();
  await car.onUninit();
});
