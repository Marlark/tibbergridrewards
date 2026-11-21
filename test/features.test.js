'use strict';

// Status condition, unavailable for a long time, session history, connection status

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const unavailable = require('../lib/unavailable');
const GridRewardSubscription = require('../lib/GridRewardSubscription');

const subs = [];
GridRewardSubscription.prototype.start = function start() { this._stopped = false; subs.push(this); };

const GridRewardDevice = require('../drivers/grid-reward/device');
const GridRewardDriver = require('../drivers/grid-reward/driver');
const FlexDevice = require('../drivers/flex-device/device');
const FlexDeviceDriver = require('../drivers/flex-device/driver');
const appApi = require('../api');

const T0 = Date.parse('2026-11-17T08:00:00Z');
const MIN = 60 * 1000;
const status = (typename, month, extra = {}) => ({
  homeId: 'h1', state: { __typename: typename, ...extra }, rewardCurrentMonth: month, rewardAllTime: 900,
});

async function makeHome(t, opts = {}) {
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  subs.length = 0;
  const homey = makeHomey();
  const device = new GridRewardDevice({
    homey, data: { id: 'h1' }, store: { email: 'a@example.com', password: 'pw' }, ...opts,
  });
  device.getName = () => 'Home';
  homey.drivers.registry['grid-reward'] = { getDevices: () => [device] };
  await device.onInit();
  return {
    homey, device, sub: subs[0], setNow: (v) => { now = v; },
  };
}

const minuteTick = (homey) => homey.timers.find((x) => x.ms === MIN && !x.cleared).fn();

// --- unavailable ---

test('unavailable.step: fires minute ranges; each threshold is crossed exactly once', () => {
  let w = { since: null, lastMin: 0 };
  const fires = [];
  w = unavailable.step(w, 'unavailable', T0).watch;
  for (let m = 1; m <= 200; m += 7) {
    const r = unavailable.step(w, 'unavailable', T0 + m * MIN);
    w = r.watch;
    if (r.fire) fires.push(r.fire);
  }
  assert.strictEqual(fires.filter((f) => unavailable.crossed(f, 3)).length, 1); // 180 min
  assert.strictEqual(fires.filter((f) => unavailable.crossed(f, 0.5)).length, 1); // 30 min
  assert.strictEqual(fires.filter((f) => unavailable.crossed(f, 5)).length, 0); // not reached
  assert.deepStrictEqual(unavailable.step(w, 'available', T0 + 300 * MIN).watch, { since: null, lastMin: 0 });
});

test('unavailable.restore: thresholds passed while stopped are not fired afterwards', () => {
  const w = unavailable.restore(T0, T0 + 200 * MIN);
  const r = unavailable.step(w, 'unavailable', T0 + 201 * MIN);
  assert.ok(!unavailable.crossed(r.fire, 3));
  assert.deepStrictEqual(unavailable.restore(null, T0), { since: null, lastMin: 0 });
});

test('home device: unavailable_for fires with hours and reason; the 2 h flow runs once', async (t) => {
  const { homey, device, sub, setNow } = await makeHome(t);
  await new GridRewardDriver({ homey }).onInit();
  sub.emit('data', status('GridRewardUnavailable', 10, { reasons: ['noVehiclesPluggedIn'] }));
  await device._queue;
  assert.strictEqual(device.getStoreValue('unavailableSince'), T0);
  for (let m = 1; m <= 150; m += 1) {
    setNow(T0 + m * MIN);
    minuteTick(homey);
    await device._queue;
  }
  const listener = homey.triggerListeners.unavailable_for;
  const runs = [];
  for (const x of homey.triggered.filter((e) => e.id === 'unavailable_for')) {
    if (await listener({ hours: 2 }, x.state)) runs.push(x.tokens);
  }
  assert.deepStrictEqual(runs, [{ hours: 2, reason: 'No car plugged in', reason_code: 'noVehiclesPluggedIn' }]);

  // Back to available: the period ends
  sub.emit('data', status('GridRewardAvailable', 10));
  await device._queue;
  assert.strictEqual(device.getStoreValue('unavailableSince'), null);
});

// --- status condition ---

test('condition state_is on home and car', async () => {
  const homey = makeHomey();
  await new GridRewardDriver({ homey }).onInit();
  await new FlexDeviceDriver({ homey }).onInit();
  const dev = (state) => ({ getCapabilityValue: () => state });
  assert.strictEqual(await homey.conditions.state_is({ device: dev('delivering'), state: 'delivering' }), true);
  assert.strictEqual(await homey.conditions.state_is({ device: dev('available'), state: 'delivering' }), false);
  assert.strictEqual(await homey.conditions.flex_state_is({ device: dev('unavailable'), state: 'unavailable' }), true);
});

test('car device: flex_unavailable_for is triggered while unavailable', async (t) => {
  let now = T0;
  t.mock.method(Date, 'now', () => now);
  const homey = makeHomey();
  homey.drivers.registry['grid-reward'] = { getDevices: () => [] };
  const car = new FlexDevice({ homey, data: { id: 'v1', homeId: 'h1', kind: 'vehicle' } });
  await car.onInit();
  await car.onFlexStatus({
    id: 'v1', kind: 'vehicle', gridState: 'unavailable', reasonCodes: ['noVehiclesPluggedIn'], pluggedIn: false, smartEnabled: true,
  });
  now = T0 + 61 * MIN;
  await car._checkUnavailable('unavailable');
  const fired = homey.triggered.filter((x) => x.id === 'flex_unavailable_for');
  assert.strictEqual(fired.length, 1);
  assert.ok(unavailable.crossed(fired[0].state, 1));
  assert.strictEqual(fired[0].tokens.reason, 'No car plugged in');
  await car.onUninit();
});

// --- history ---

async function sessionOn(device, sub, setNow, startMin, endMin, month0, month1, reason = 'excess') {
  setNow(T0 + startMin * MIN);
  sub.emit('data', status('GridRewardDelivering', month0, { reason }));
  await device._queue;
  setNow(T0 + endMin * MIN);
  sub.emit('data', status('GridRewardAvailable', month1));
  await device._queue;
  setNow(T0 + endMin * MIN + 40000);
  sub.emit('data', status('GridRewardAvailable', month1 + 0.1)); // settlement
  await device._queue;
}

test('history: finished sessions with time, reward, minutes and reason, newest first', async (t) => {
  const { device, sub, setNow } = await makeHome(t);
  sub.emit('data', status('GridRewardAvailable', 10));
  await device._queue;
  await sessionOn(device, sub, setNow, 10, 40, 10, 11, 'excess');
  await sessionOn(device, sub, setNow, 60, 75, 11.1, 11.5, 'shortage');
  const h = device.getHistory();
  assert.deepStrictEqual(h.map((s) => [s.reward, s.minutes, s.reason]), [[0.5, 15, 'shortage'], [1.1, 30, 'excess']]);
  assert.strictEqual(h[1].startedAt, T0 + 10 * MIN);
});

test('history keeps at most 100 sessions', async (t) => {
  const old = Array.from({ length: 100 }, (_, i) => ({
    startedAt: i, endedAt: i, reward: 0.1, minutes: 1, reason: '',
  }));
  const { device, sub, setNow } = await makeHome(t, { store: { email: 'a@example.com', password: 'pw', history: old } });
  sub.emit('data', status('GridRewardAvailable', 10));
  await device._queue;
  await sessionOn(device, sub, setNow, 10, 20, 10, 10.5);
  assert.strictEqual(device.getHistory().length, 100);
  assert.strictEqual(device.getHistory()[0].reward, 0.6);
});

test('app API: history per home, per day, translated reasons', async (t) => {
  const { homey, device, sub, setNow } = await makeHome(t);
  sub.emit('data', status('GridRewardAvailable', 10));
  await device._queue;
  await sessionOn(device, sub, setNow, 10, 40, 10, 11, 'excess');
  await sessionOn(device, sub, setNow, 60, 75, 11.1, 11.5, 'shortage');
  const data = await appApi.getHistory({ homey });
  assert.strictEqual(data.labels.per_day, 'Per day');
  const [home] = data.homes;
  assert.strictEqual(home.name, 'Home');
  assert.strictEqual(home.total, 1.6);
  assert.deepStrictEqual(home.days, [{
    date: '2026-11-17', reward: 1.6, sessions: 2, minutes: 45,
  }]);
  assert.strictEqual(home.sessions[0].reasonText, 'Power shortage in the grid');
  assert.match(home.sessions[0].when, /10:00/); // 08:00Z + 60 min = 09:00Z = 10:00 in Stockholm
});

test('perDay groups by local day of the end time', () => {
  const s = (iso, reward) => ({ endedAt: Date.parse(iso), reward, minutes: 10 });
  assert.deepStrictEqual(require('../lib/history').perDay([s('2026-11-16T22:30:00Z', 1), s('2026-11-16T23:30:00Z', 2)], 'Europe/Stockholm')
    .map((d) => [d.date, d.reward]), [['2026-11-17', 2], ['2026-11-16', 1]]);
});

// --- connection status ---

test('connection status is shown in the device settings', async (t) => {
  const { device, sub, setNow } = await makeHome(t);
  sub.emit('connected');
  assert.strictEqual(device.getSetting('conn_status'), 'Connected');
  assert.notStrictEqual(device.getSetting('conn_connected_since'), '–');
  sub.emit('disconnected');
  assert.strictEqual(device.getSetting('conn_status'), 'Reconnecting…');
  assert.strictEqual(device.getSetting('conn_reconnects'), '1');
  assert.strictEqual(device.getSetting('conn_connected_since'), '–');
  sub.emit('connected');
  setNow(T0 + 2 * MIN);
  sub.emit('data', status('GridRewardAvailable', 10));
  await device._queue;
  assert.match(device.getSetting('conn_last_update'), /09:02/);
});

test('connection status shows login and API problems', async (t) => {
  const { TibberAuthError, TibberApiChangedError } = require('../lib/TibberAppClient');
  const { device, sub } = await makeHome(t);
  sub.emit('error', new TibberAuthError('Login failed (401)'));
  assert.match(device.getSetting('conn_status'), /Login failed/);
  sub.emit('error', new TibberApiChangedError('API changed'));
  assert.match(device.getSetting('conn_status'), /changed its API/);
});

// --- monthly summary ---

test('month_ended: summary of the calendar month that ended', () => {
  const { rollDayEvents } = require('../lib/RewardTracker');
  const s = {
    dayKey: '2026-11-30', dayStart: 670, lastMonth: 679.69, dayStats: { sessions: 3, minutes: 90 },
    monthStats: { month: '2026-11', sessions: 270, minutes: 13140 },
  };
  const { events } = rollDayEvents(s, '2026-12-01');
  assert.deepStrictEqual(events.map((e) => e.type), ['day_ended', 'month_ended']);
  assert.deepStrictEqual(events[1], {
    type: 'month_ended', month: '2026-11', reward: 679.69, sessions: 270, minutes: 13140,
  });
  assert.strictEqual(rollDayEvents({ ...s, dayKey: '2026-11-29' }, '2026-11-30').events.length, 1);
});

test('home device: monthly_summary fires at midnight on the 1st', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-30T20:00:00Z') });
  const { homey, device, sub, setNow: setNowMock } = await makeHome(t);
  const setNow = (v) => { setNowMock(v); t.mock.timers.setTime(v); };
  setNow(Date.parse('2026-11-30T20:00:00Z'));
  sub.emit('data', status('GridRewardAvailable', 679.69));
  await device._queue;
  setNow(Date.parse('2026-11-30T23:00:30Z')); // 00:00:30 on 1 Dec in Stockholm
  minuteTick(homey);
  await device._queue;
  const m = homey.triggered.find((x) => x.id === 'monthly_summary');
  assert.deepStrictEqual(m.tokens, {
    reward: 679.69, sessions: 0, minutes: 0, month: '2026-11',
  });
});

// --- thresholds ---

test('reward_today_passed: each amount fires once per day; resets do not fire', async (t) => {
  const { homey, device, sub, setNow } = await makeHome(t);
  await new GridRewardDriver({ homey }).onInit();
  const steps = [10, 12.5, 14, 16.4, 16.2, 20];
  for (const [i, m] of steps.entries()) {
    setNow(T0 + i * MIN);
    sub.emit('data', status('GridRewardAvailable', m));
    await device._queue;
  }
  const listener = homey.triggerListeners.reward_today_passed;
  const runsFor = async (amount) => {
    let n = 0;
    for (const x of homey.triggered.filter((e) => e.id === 'reward_today_passed')) {
      if (await listener({ amount }, x.state)) n += 1;
    }
    return n;
  };
  assert.strictEqual(await runsFor(5), 1); // today goes 0 → 2.5 → 4 → 6.4 → 6.2 → 10
  assert.strictEqual(await runsFor(6.3), 1); // passed on 6.4; the dip to 6.2 and rise again does not fire twice
  assert.strictEqual(await runsFor(10), 1);
  assert.strictEqual(await runsFor(11), 0);
  assert.strictEqual(homey.triggered.find((e) => e.id === 'reward_today_passed').tokens.today, 2.5);
});

test('reward_month_passed ignores the month reset and fires again in the new month', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-30T20:00:00Z') });
  const { homey, device, sub, setNow: setNowMock } = await makeHome(t);
  await new GridRewardDriver({ homey }).onInit();
  const setNow = (v) => { setNowMock(v); t.mock.timers.setTime(v); };
  setNow(Date.parse('2026-11-30T20:00:00Z'));
  sub.emit('data', status('GridRewardAvailable', 679));
  await device._queue;
  setNow(Date.parse('2026-12-01T05:00:00Z'));
  sub.emit('data', status('GridRewardAvailable', 0.5));
  await device._queue;
  assert.deepStrictEqual(homey.triggered.filter((e) => e.id === 'reward_month_passed'), []);
  setNow(Date.parse('2026-12-01T09:00:00Z'));
  sub.emit('data', status('GridRewardAvailable', 12));
  await device._queue;
  const fired = homey.triggered.filter((e) => e.id === 'reward_month_passed');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(await homey.triggerListeners.reward_month_passed({ amount: 10 }, fired[0].state), true);
});

test('condition reward_today_above', async () => {
  const homey = makeHomey();
  await new GridRewardDriver({ homey }).onInit();
  const dev = (v) => ({ getCapabilityValue: () => v });
  assert.strictEqual(await homey.conditions.reward_today_above({ device: dev(12), amount: 10 }), true);
  assert.strictEqual(await homey.conditions.reward_today_above({ device: dev(8), amount: 10 }), false);
  assert.strictEqual(await homey.conditions.reward_today_above({ device: dev(null), amount: 0 }), false);
});

// --- why unavailable ---

const carFlex = (state) => ({
  __typename: 'GridRewardVehicle', kind: 'vehicle', vehicleId: 'v1', shortName: 'Car', make: 'EV3', isPluggedIn: false, isSmartChargingEnabled: true, state,
});

test('home unavailable: the car\'s reason is shown on the home', async (t) => {
  const { device, sub } = await makeHome(t);
  sub.emit('data', {
    ...status('GridRewardUnavailable', 10, { reasons: [] }),
    flexDevices: [carFlex({ __typename: 'GridRewardUnavailable', reasons: ['noVehiclesPluggedIn'] })],
  });
  await device._queue;
  assert.strictEqual(device.getCapabilityValue('grid_reward_reason'), 'No car plugged in');
});

test('home available: the car\'s reason is not added', async (t) => {
  const { device, sub } = await makeHome(t);
  sub.emit('data', {
    ...status('GridRewardAvailable', 10, { kind: 'available' }),
    flexDevices: [carFlex({ __typename: 'GridRewardUnavailable', reasons: ['noVehiclesPluggedIn'] })],
  });
  await device._queue;
  assert.strictEqual(device.getCapabilityValue('grid_reward_reason'), 'Available');
});

test('an update without flexDevices leaves cars and batteries alone', async (t) => {
  const { homey, device, sub } = await makeHome(t);
  let called = 0;
  homey.drivers.registry['flex-device'] = { getDevices: () => [{ getData: () => ({ id: 'v1', homeId: 'h1' }), onFlexStatus: async () => { called += 1; } }] };
  sub.emit('data', status('GridRewardAvailable', 10));
  await device._queue;
  assert.strictEqual(called, 0);
});

// --- currency ---

test('currency: EUR sets € as unit on money capabilities, once', async (t) => {
  const { homey, device, sub } = await makeHome(t);
  sub.emit('data', { ...status('GridRewardAvailable', 10), rewardCurrency: 'EUR' });
  await device._queue;
  assert.deepStrictEqual(device.capabilityOptions.grid_reward_today, { units: { en: '€' } });
  assert.deepStrictEqual(device.capabilityOptions.grid_reward_last_session, { units: { en: '€' } });
  assert.strictEqual(device.getCurrencyUnit(), '€');
  device.capabilityOptions = {};
  sub.emit('data', { ...status('GridRewardAvailable', 11), rewardCurrency: 'EUR' });
  await device._queue;
  assert.deepStrictEqual(device.capabilityOptions, {});
  const { getStatus } = require('../widgets/grid-rewards/api');
  device.getId = () => 'dev-1';
  assert.strictEqual((await getStatus({ homey, query: {} })).unit, '€');
});

test('currency: SEK, NOK and DKK are shown as kr', () => {
  const { unitFor } = require('../lib/currency');
  assert.deepStrictEqual(['SEK', 'NOK', 'DKK', 'EUR', 'GBP', null].map(unitFor), ['kr', 'kr', 'kr', '€', 'GBP', 'kr']);
});

// --- History survives removing and adding the home device (#20) ---

test('history and daily totals are kept per home in the app settings, not in the device', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const { homey, device, sub, setNow: setNowMock } = await makeHome(t);
  const setNow = (v) => { setNowMock(v); t.mock.timers.setTime(v); };
  sub.emit('data', status('GridRewardAvailable', 10));
  await device._queue;
  await sessionOn(device, sub, setNow, 10, 40, 10, 11);
  // Next day: the daily total is stored
  setNow(Date.parse('2026-11-17T23:00:30Z'));
  minuteTick(homey);
  await device._queue;
  assert.deepStrictEqual(device.getDays(), [{
    date: '2026-11-17', reward: 1.1, sessions: 1, minutes: 30,
  }]);
  assert.strictEqual(device.getStoreValue('history'), undefined);
  await device.onDeleted();

  // The same Tibber home added again as a new device, on the same Homey
  subs.length = 0;
  const again = new GridRewardDevice({ homey, data: { id: 'h1' }, store: { email: 'a@example.com', password: 'pw' } });
  await again.onInit();
  assert.strictEqual(again.getHistory().length, 1);
  assert.strictEqual(again.getHistory()[0].reward, 1.1);
  assert.strictEqual(again.getDays().length, 1);
  await again.onUninit();
});

test('history saved in the device store by an older version is moved to the app settings', async (t) => {
  const old = [{
    startedAt: 1, endedAt: 2, reward: 0.5, minutes: 10, reason: 'excess',
  }];
  const { homey, device } = await makeHome(t, { store: { email: 'a@example.com', password: 'pw', history: old } });
  assert.deepStrictEqual(device.getHistory(), old);
  assert.deepStrictEqual(homey.settings.get('history:h1'), old);
  assert.strictEqual(device.getStoreValue('history'), null);
});

test('daily totals: one entry per date, newest first, at most 400', async (t) => {
  const { device } = await makeHome(t);
  for (const date of ['2026-11-15', '2026-11-16', '2026-11-16']) {
    device.store.addDay({
      date, reward: 1, sessions: 1, minutes: 10,
    });
  }
  assert.deepStrictEqual(device.getDays().map((d) => d.date), ['2026-11-16', '2026-11-15']);
});
