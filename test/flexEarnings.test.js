'use strict';

// What each car/battery earned: the home's sessions credited to the device that delivered.

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeHomey } = require('./helpers/homey-stub');
const {
  addEarning, splitSession, liveShares, earningsOf,
} = require('../lib/flexEarnings');
const { applyUpdate } = require('../lib/RewardTracker');
const GridRewardSubscription = require('../lib/GridRewardSubscription');

const subs = [];
GridRewardSubscription.prototype.start = function start() { this._stopped = false; subs.push(this); };

const GridRewardDevice = require('../drivers/grid-reward/device');
const FlexDevice = require('../drivers/flex-device/device');

// --- Pure functions ---

test('addEarning: today, month and total; new day and new month start from 0', () => {
  let s = addEarning({}, 'car', 1.234, '2026-11-17');
  s = addEarning(s, 'car', 1, '2026-11-17');
  assert.deepStrictEqual(s.car, {
    dayKey: '2026-11-17',
    today: 2.23,
    todaySessions: 2,
    todayMinutes: 0,
    monthKey: '2026-11',
    month: 2.23,
    monthSessions: 2,
    monthMinutes: 0,
    total: 2.23,
  });
  s = addEarning(s, 'car', 0.5, '2026-11-18');
  assert.deepStrictEqual([s.car.today, s.car.month, s.car.total], [0.5, 2.73, 2.73]);
  s = addEarning(s, 'car', 1, '2026-12-01');
  assert.deepStrictEqual([s.car.today, s.car.month, s.car.total], [1, 1, 3.73]);
});

test('splitSession: evenly over the devices that delivered; nothing without devices or reward', () => {
  const s = splitSession({}, { reward: 3, flex: ['car', 'bat'] }, '2026-11-17');
  assert.strictEqual(s.car.today, 1.5);
  assert.strictEqual(s.bat.today, 1.5);
  assert.deepStrictEqual(splitSession({}, { reward: 3 }, '2026-11-17'), {});
  assert.deepStrictEqual(splitSession({}, { reward: 0, flex: ['car'] }, '2026-11-17'), {});
});

test('earningsOf: old days and months count as 0, the running session is added', () => {
  const s = addEarning({}, 'car', 2, '2026-11-17', 30);
  assert.deepStrictEqual(earningsOf(s, 'car', '2026-11-17', { car: 0.5 }), {
    today: 2.5, month: 2.5, total: 2.5, sessionsToday: 1, minutesToday: 30, sessionsMonth: 1, minutesMonth: 30, share: 100,
  });
  assert.deepStrictEqual(earningsOf(s, 'car', '2026-11-18'), {
    today: 0, month: 2, total: 2, sessionsToday: 0, minutesToday: 0, sessionsMonth: 1, minutesMonth: 30, share: 100,
  });
  assert.strictEqual(earningsOf(s, 'car', '2026-12-01').share, null, 'nothing earned yet this month');
});

test('share: each device against what the cars/batteries earned this month, live included', () => {
  let s = addEarning({}, 'car', 1, '2026-11-17', 15);
  s = addEarning(s, 'bat', 9, '2026-11-17', 60);
  assert.strictEqual(earningsOf(s, 'car', '2026-11-17').share, 10);
  assert.strictEqual(earningsOf(s, 'bat', '2026-11-17').share, 90);
  assert.strictEqual(earningsOf(s, 'car', '2026-11-17', { car: 10 }).share, 55);
  s = addEarning(s, 'old', 4, '2026-10-31'); // a device that only earned last month does not count
  assert.strictEqual(earningsOf(s, 'bat', '2026-11-17').share, 90);
});

test('the tracker remembers which devices delivered during the session', () => {
  const at = (prev, month, gridState, flexDelivering, now) => applyUpdate(prev, {
    month, gridState, dayKey: '2026-11-17', now, flexDelivering,
  });
  let r = at(undefined, 10, 'available', [], 0);
  r = at(r.state, 10, 'delivering', ['car'], 1000);
  assert.deepStrictEqual(r.state.session.flex, ['car']);
  r = at(r.state, 11, 'delivering', ['car', 'bat'], 2000); // the battery joins
  assert.deepStrictEqual(r.state.session.flex, ['car', 'bat']);
  assert.deepStrictEqual(liveShares(r.state), { car: 0.5, bat: 0.5 });
  r = at(r.state, 12, 'available', [], 3000);
  assert.deepStrictEqual(r.state.pending.flex, ['car', 'bat']);
  r = at(r.state, 12.2, 'available', [], 4000); // settlement
  const ended = r.events.find((e) => e.type === 'session_ended');
  assert.deepStrictEqual(ended.flex, ['car', 'bat']);
  assert.strictEqual(ended.reward, 2.2);
});

test('liveShares: an unsettled session stops where the next one started', () => {
  const tracker = {
    lastMonth: 15,
    session: { startMonth: 12, flex: ['bat'] },
    pending: { startMonth: 10, flex: ['car'] },
  };
  assert.deepStrictEqual(liveShares(tracker), { bat: 3, car: 2 });
  assert.deepStrictEqual(liveShares({ lastMonth: 5, session: { startMonth: 4 } }), {});
});

// --- On the devices, with a real day (anonymised recording) ---

function setup(t) {
  let now = Date.parse('2026-11-17T08:00:00Z');
  t.mock.method(Date, 'now', () => now);
  subs.length = 0;
  const homey = makeHomey();
  const home = new GridRewardDevice({ homey, data: { id: 'home-1' }, store: { email: 'a@example.com', password: 'pw' } });
  const car = new FlexDevice({ homey, data: { id: 'vehicle-1', homeId: 'home-1', kind: 'vehicle' } });
  const flex = [car];
  homey.drivers.registry['grid-reward'] = { getDevices: () => [home] };
  homey.drivers.registry['flex-device'] = { getDevices: () => flex };
  return {
    homey, home, car, flex, setNow: (v) => { now = v; },
  };
}

test('real day: car and battery each get their own sessions, and together the home total', async (t) => {
  const {
    homey, home, car, flex, setNow,
  } = setup(t);
  await home.onInit();
  await car.onInit();
  const battery = new FlexDevice({ homey, data: { id: 'battery-1', homeId: 'home-1', kind: 'battery' } });
  battery._pollBattery = async () => {}; // no battery details in this test
  flex.push(battery);
  await battery.onInit();

  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'real-2026-11-17.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  for (const l of lines) {
    setNow(l.t);
    subs[0].emit('data', l.status, 'home-1');
    await home._queue;
  }
  setNow(lines[lines.length - 1].t + 10 * 60 * 1000);
  await home._settle();

  const sessions = home.getHistory();
  const sum = (kind) => Math.round(sessions.filter((s) => (s.flex || []).includes(kind))
    .reduce((a, s) => a + s.reward, 0) * 100) / 100;
  const carTotal = car.getCapabilityValue('flex_reward_total');
  const batTotal = battery.getCapabilityValue('flex_reward_total');
  assert.ok(carTotal > 0, 'the car delivered in one session (23:13–00:19)');
  assert.ok(batTotal > carTotal);
  assert.strictEqual(carTotal, sum('vehicle-1'));
  assert.strictEqual(batTotal, sum('battery-1'));
  const homeTotal = Math.round(sessions.reduce((a, s) => a + s.reward, 0) * 100) / 100;
  assert.strictEqual(Math.round((carTotal + batTotal) * 100) / 100, homeTotal, 'nothing lost or counted twice');

  const carSessions = homey.triggered.filter((x) => x.id === 'flex_session_ended' && x.device === car);
  assert.strictEqual(carSessions.length, 1);
  assert.strictEqual(carSessions[0].tokens.reward, carTotal);
  assert.strictEqual(car.getCapabilityValue('grid_reward_sessions_month'), 1);
  assert.strictEqual(battery.getCapabilityValue('grid_reward_sessions_month'), 8);
  assert.strictEqual(car.getCapabilityValue('flex_reward_share'), 10); // 1.73 of 16.64
  assert.strictEqual(battery.getCapabilityValue('flex_reward_share'), 90);

  await home.onUninit();
  await car.onUninit();
  await battery.onUninit();
});

test('the car shows the running session live, and keeps its earnings after being re-added', async (t) => {
  const {
    homey, home, car, setNow,
  } = setup(t);
  await home.onInit();
  await car.onInit();
  const st = (typename, month, carState) => ({
    homeId: 'home-1',
    state: { __typename: typename },
    rewardCurrentMonth: month,
    rewardAllTime: 100,
    flexDevices: [{
      __typename: 'GridRewardVehicle', kind: 'vehicle', vehicleId: 'vehicle-1', isPluggedIn: true, state: { __typename: carState },
    }],
  });
  const send = async (s) => { subs[0].emit('data', s, 'home-1'); await home._queue; };
  await send(st('GridRewardAvailable', 10, 'GridRewardAvailable'));
  await send(st('GridRewardDelivering', 10, 'GridRewardDelivering'));
  await send(st('GridRewardDelivering', 11.5, 'GridRewardDelivering'));
  assert.strictEqual(car.getCapabilityValue('flex_reward_today'), 1.5, 'live during the session');
  setNow(Date.now() + 15 * 60 * 1000);
  await send(st('GridRewardAvailable', 11.5, 'GridRewardAvailable'));
  await send(st('GridRewardAvailable', 11.7, 'GridRewardAvailable')); // settlement
  assert.strictEqual(car.getCapabilityValue('flex_reward_today'), 1.7);
  assert.strictEqual(car.getCapabilityValue('flex_reward_month'), 1.7);

  // Removed and added again: the earnings are kept per home in the app settings.
  await car.onDeleted();
  const again = new FlexDevice({ homey, data: { id: 'vehicle-1', homeId: 'home-1', kind: 'vehicle' } });
  homey.drivers.registry['flex-device'] = { getDevices: () => [again] };
  await again.onInit();
  assert.strictEqual(again.getCapabilityValue('flex_reward_total'), 1.7);

  await home.onUninit();
  await again.onUninit();
});
