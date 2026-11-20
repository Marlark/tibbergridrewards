'use strict';

// Home battery. The response below is SYNTHETIC: shaped after the query used by
// the HA integration, not recorded from Tibber. Replace with a real one when available.

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const {
  batteryVariables, parseBattery, parsePlan, activityCode, humanize, BATTERY_QUERY,
} = require('../lib/battery');
const history = require('../lib/history');
const { TibberApiChangedError } = require('../lib/TibberAppClient');
const FlexDevice = require('../drivers/flex-device/device');

const NOW = Date.parse('2026-11-17T10:07:12.345Z');

const response = (overrides = {}) => ({
  me: {
    home: {
      battery: {
        aggregatedHistory: {
          periods: [
            { key: 'TODAY', batteryValueItems: [{ value: 3.21, unit: 'kr', kind: 'TOTAL' }, { value: 1, unit: 'kr', kind: 'OTHER' }] },
            { key: 'WEEK', batteryValueItems: [{ value: 12.5, unit: 'kr', kind: 'TOTAL' }] },
            { key: 'MONTH', batteryValueItems: [{ value: 48.75, unit: 'kr', kind: 'TOTAL' }] },
          ],
        },
      },
      batteryActivityHistory: {
        items: [
          { from: '2026-11-17T08:00:00Z', to: '2026-11-17T09:00:00Z', reason: { __typename: 'HomeBatteryIdle' }, secondaryReason: null },
          { from: '2026-11-17T09:00:00Z', to: null, reason: { __typename: 'HomeBatteryChargingForGridRewards' }, secondaryReason: null },
        ],
      },
      batteryTimeline: {
        energyFlow: {
          items: [
            { kind: 'ACTUAL', time: '2026-11-17T10:00:00Z', charged: 3000, discharged: 0 },
            { kind: 'FORECAST', time: '2026-11-17T10:15:00Z', charged: 40, discharged: 0 },
            { kind: 'FORECAST', time: '2026-11-17T13:30:00Z', charged: 0, discharged: 2500 },
          ],
        },
        stateOfCharge: { items: [{ kind: 'FORECAST', time: '2026-11-17T13:30:00Z', stateOfCharge: 81.26 }] },
      },
      ...overrides,
    },
  },
});

test('query asks for savings, activity and timeline', () => {
  for (const part of ['GetBatteryDetails', 'aggregatedHistory', 'batteryActivityHistory', 'batteryTimeline', 'BatteryTimelineResolution!']) {
    assert.ok(BATTERY_QUERY.includes(part), part);
  }
});

test('variables: time windows in UTC without milliseconds', () => {
  assert.deepStrictEqual(batteryVariables({ homeId: 'h1', batteryId: 'b1', now: NOW }), {
    homeId: 'h1',
    deviceId: 'b1',
    activityFrom: '2026-11-17T04:07:12Z',
    activityTo: '2026-11-17T11:07:12Z',
    timelineFrom: '2026-11-17T10:07:12Z',
    timelineTo: '2026-11-18T23:59:59Z',
    resolution: 'QUARTER_HOURLY',
  });
});

test('parseBattery: savings, current activity, next planned', () => {
  assert.deepStrictEqual(parseBattery(response()), {
    savingsToday: 3.21,
    savingsWeek: 12.5,
    savingsMonth: 48.75,
    unit: 'kr',
    activity: { code: 'ChargingForGridRewards', secondary: '', since: '2026-11-17T09:00:00Z' },
    nextPlanned: {
      time: '2026-11-17T13:30:00Z', action: 'discharge', powerW: 2500, stateOfCharge: 81.3,
    },
    plan: [
      { time: '2026-11-17T10:00:00Z', soc: null, powerW: 3000, forecast: false },
      { time: '2026-11-17T10:15:00Z', soc: null, powerW: 40, forecast: true },
      { time: '2026-11-17T13:30:00Z', soc: 81.3, powerW: -2500, forecast: true },
    ],
  });
});

test('parseBattery: tolerates missing parts', () => {
  assert.strictEqual(parseBattery({}), null);
  assert.deepStrictEqual(parseBattery({ me: { home: {} } }), {
    savingsToday: null, savingsWeek: null, savingsMonth: null, unit: '', activity: null, nextPlanned: null, plan: [],
  });
});

test('activity codes and fallback text', () => {
  assert.strictEqual(activityCode('HomeBatteryChargingForGridRewards'), 'ChargingForGridRewards');
  assert.strictEqual(humanize('DischargingToHome'), 'Discharging to home');
});

// --- Battery device ---

async function batteryDevice(query) {
  const homey = makeHomey();
  const home = {
    client: { query }, problem: null, getData: () => ({ id: 'h1' }), getFlexDevices: () => [],
  };
  homey.drivers.registry['grid-reward'] = { getDevices: () => [home] };
  const device = new FlexDevice({ homey, data: { id: 'b1', homeId: 'h1', kind: 'battery' }, capabilityList: ['grid_reward_state', 'grid_reward_reason', 'flex_smart_enabled'] });
  await device.onInit();
  return { homey, device, home };
}

test('battery device polls every 5 min and fills its values', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const calls = [];
  const { homey, device } = await batteryDevice(async (q, v) => { calls.push(v); return response(); });
  assert.ok(device.hasCapability('battery_savings_today'), 'old battery device gets new capabilities');
  assert.ok(homey.timers.some((x) => x.ms === 5 * 60 * 1000));
  await device._pollBattery();
  assert.strictEqual(calls[0].deviceId, 'b1');
  assert.strictEqual(device.getCapabilityValue('battery_savings_today'), 3.21);
  assert.strictEqual(device.getCapabilityValue('battery_savings_month'), 48.75);
  assert.strictEqual(device.getCapabilityValue('battery_activity'), 'Charging for Grid Rewards');
  assert.strictEqual(device.getCapabilityValue('battery_next_activity'), 'Discharge at 14:30 (2.5 kW)');
});

test('activity change triggers a flow; unknown activity is readable', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  let typename = 'HomeBatteryChargingForGridRewards';
  const { homey, device } = await batteryDevice(async () => response({
    batteryActivityHistory: { items: [{ from: 'x', to: null, reason: { __typename: typename } }] },
  }));
  await device._pollBattery();
  assert.strictEqual(homey.triggered.length, 0); // first poll only sets the baseline
  typename = 'HomeBatteryDischargingToHome';
  await device._pollBattery();
  assert.deepStrictEqual(homey.triggered.map((x) => [x.id, x.tokens]), [
    ['battery_activity_changed', { activity: 'Discharging to home', activity_code: 'DischargingToHome' }],
  ]);
});

test('poll errors give a warning, not an unavailable device', async () => {
  const { device } = await batteryDevice(async () => { throw new TibberApiChangedError('API changed: Cannot query field "batteryTimeline"'); });
  await device._pollBattery();
  assert.match(device.warning, /changed its API/);
  assert.strictEqual(device.available, true);
});

test('no poll while the home device has a login or API problem', async () => {
  let called = false;
  const { device, home } = await batteryDevice(async () => { called = true; return response(); });
  home.problem = 'auth';
  await device._pollBattery();
  assert.strictEqual(called, false);
});

test('temporary errors ("Circuit breaker open"): warning only after 3 in a row, cleared on success', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  let fail = false;
  const { device } = await batteryDevice(async () => {
    if (fail) throw new Error('GraphQL: Circuit breaker open; Circuit breaker open');
    return response();
  });
  await device._pollBattery();
  assert.strictEqual(device.getCapabilityValue('battery_savings_today'), 3.21);

  fail = true;
  await device._pollBattery();
  await device._pollBattery();
  assert.ok(!device.warning, 'no warning after 2 failures');
  assert.strictEqual(device.getCapabilityValue('battery_savings_today'), 3.21, 'last values are kept');
  await device._pollBattery();
  assert.match(device.warning, /Could not read battery details/);

  fail = false;
  await device._pollBattery();
  assert.strictEqual(device.warning, null);
  assert.ok(device.logs.some((l) => /OK again after 3 failed/.test(l)));
});

test('a single temporary error is only logged', async () => {
  let calls = 0;
  const { device } = await batteryDevice(async () => {
    calls += 1;
    if (calls === 1) throw new Error('GraphQL: Circuit breaker open');
    return response();
  });
  await device._pollBattery();
  await device._pollBattery();
  assert.ok(!device.warning);
  assert.ok(device.logs.some((l) => /failed \(1 in a row\): GraphQL: Circuit breaker open/.test(l)));
});

// --- Faster battery update when the Grid Rewards status changes (#27) ---

const flexInfo = (gridState) => ({
  id: 'b1', kind: 'battery', gridState, reasonCodes: [], pluggedIn: null, smartEnabled: true,
});
const soonTimers = (homey) => homey.timers.filter((x) => !x.cleared && x.ms !== 5 * 60 * 1000 && x.ms !== 60 * 1000 && x.ms !== 15 * 1000);

test('battery status change: details are fetched after 10 s, only one pending fetch', async (t) => {
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const { homey, device } = await batteryDevice(async () => { calls += 1; return response(); });
  await device.onFlexStatus(flexInfo('available'));
  await device.onFlexStatus(flexInfo('delivering'));
  await device.onFlexStatus(flexInfo('available'));
  const pending = soonTimers(homey);
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].ms, 10 * 1000);
  pending[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls, 1);
  assert.ok(device.logs.some((l) => /Fetching battery details in 10 s \(battery status changed\)/.test(l)));
});

test('never more than one extra fetch per minute', async (t) => {
  let now = NOW;
  t.mock.method(Date, 'now', () => now);
  const { homey, device } = await batteryDevice(async () => response());
  await device._pollBattery(); // a regular poll just now
  now += 20 * 1000;
  device.pollSoon('test');
  assert.strictEqual(soonTimers(homey)[0].ms, 40 * 1000); // 60 s after the last poll
});

test('the car never fetches battery details', async () => {
  const homey = makeHomey();
  homey.drivers.registry['grid-reward'] = { getDevices: () => [] };
  const car = new FlexDevice({ homey, data: { id: 'v1', homeId: 'h1', kind: 'vehicle' } });
  await car.onInit();
  car.pollSoon('test');
  assert.strictEqual(car.pollSoonTimer, undefined);
  await car.onUninit();
});

test('a regular poll and a soon poll never run at the same time', async () => {
  let release;
  let calls = 0;
  const { device } = await batteryDevice(() => { calls += 1; return new Promise((r) => { release = () => r(response()); }); });
  const first = device._pollBattery();
  await device._pollBattery(); // skipped while the first is running
  release();
  await first;
  assert.strictEqual(calls, 1);
});

// --- Planned charge level (#15) ---

test('parsePlan: charge level and power per quarter, sorted, gaps tolerated', () => {
  assert.deepStrictEqual(parsePlan({
    energyFlow: { items: [{ kind: 'FORECAST', time: '2026-11-17T10:30:00Z', charged: 0, discharged: 1200.4 }, null] },
    stateOfCharge: {
      items: [
        { kind: 'FORECAST', time: '2026-11-17T10:30:00Z', stateOfCharge: 55.55 },
        { kind: 'FORECAST', time: '2026-11-17T10:15:00Z', stateOfCharge: 60 },
        { kind: 'FORECAST', time: '2026-11-17T10:45:00Z', stateOfCharge: null },
      ],
    },
  }), [
    { time: '2026-11-17T10:15:00Z', soc: 60, powerW: 0, forecast: true },
    { time: '2026-11-17T10:30:00Z', soc: 55.6, powerW: -1200, forecast: true },
  ]);
  assert.deepStrictEqual(parsePlan(undefined), []);
});

test('the battery keeps its latest plan; the history API shows it in local time', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  let fail = false;
  const { homey, device } = await batteryDevice(async () => {
    if (fail) throw new Error('GraphQL: Circuit breaker open');
    return response();
  });
  assert.deepStrictEqual(device.getPlan(), { points: [], updatedAt: null });
  await device._pollBattery();
  assert.strictEqual(device.getPlan().points.length, 3);
  fail = true;
  await device._pollBattery();
  assert.strictEqual(device.getPlan().points.length, 3, 'a failed poll keeps the last plan');

  device.getName = () => 'Battery';
  homey.drivers.registry['flex-device'] = { getDevices: () => [device] };
  const [b] = history.batteryPlans(homey, 'Europe/Stockholm', 'sv-SE');
  assert.strictEqual(b.name, 'Battery');
  assert.strictEqual(b.updated, '11:07');
  assert.deepStrictEqual(b.points.map((p) => [p.label, p.dayKey, p.soc, p.powerW]), [
    ['11:00', '2026-11-17', null, 3000],
    ['11:15', '2026-11-17', null, 40],
    ['14:30', '2026-11-17', 81.3, -2500],
  ]);
  await device.onUninit();
});

test('a car has no plan on the history page', () => {
  const homey = makeHomey();
  const car = { getData: () => ({ id: 'v1', kind: 'vehicle' }), getPlan: () => ({ points: [] }) };
  homey.drivers.registry['flex-device'] = { getDevices: () => [car] };
  assert.deepStrictEqual(history.batteryPlans(homey, 'Europe/Stockholm', 'sv-SE'), []);
});
