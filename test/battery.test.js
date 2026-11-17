'use strict';

// Home battery. The response below is SYNTHETIC: shaped after the query used by
// the HA integration, not recorded from Tibber. Replace with a real one when available.

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const {
  batteryVariables, parseBattery, activityCode, humanize, BATTERY_QUERY,
} = require('../lib/battery');
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
  });
});

test('parseBattery: tolerates missing parts', () => {
  assert.strictEqual(parseBattery({}), null);
  assert.deepStrictEqual(parseBattery({ me: { home: {} } }), {
    savingsToday: null, savingsWeek: null, savingsMonth: null, unit: '', activity: null, nextPlanned: null,
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
