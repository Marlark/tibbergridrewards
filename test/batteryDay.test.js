'use strict';

// The battery's day (#29) and energy through the battery (#48)

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const {
  reasonOf, directionOf, dayStats, startOfLocalDay,
} = require('../lib/batteryDay');
const { batteryVariables } = require('../lib/battery');
const history = require('../lib/history');
const FlexDevice = require('../drivers/flex-device/device');

const TZ = 'Europe/Stockholm';
const H = 3600 * 1000;

test('every known activity code gets a reason and a direction', () => {
  const codes = Object.keys(require('../locales/en.json').battery_activity);
  const seen = codes.map((c) => [c, reasonOf(c), directionOf(c)]);
  assert.deepStrictEqual(seen, [
    ['ChargingForGridRewards', 'gridRewards', 'charging'],
    ['IdleWithUpcomingLowPrice', 'price', 'idle'],
    ['DischargingForGridRewards', 'gridRewards', 'discharging'],
    ['IdleForGridRewards', 'gridRewards', 'idle'],
    ['IdleWithUpcomingHighPrice', 'price', 'idle'],
    ['ChargingWithSolarProduction', 'solar', 'charging'],
    ['DischargingAtHighPrice', 'price', 'discharging'],
    ['ChargingAtLowPrice', 'price', 'charging'],
    ['DischargingWithUpcomingSolar', 'solar', 'discharging'],
  ]);
  assert.strictEqual(reasonOf('SomethingNew'), 'other');
});

test('startOfLocalDay: local midnight, also on the day summer time ends', () => {
  assert.strictEqual(new Date(startOfLocalDay(Date.parse('2026-11-21T15:30:00Z'), TZ)).toISOString(), '2026-11-20T23:00:00.000Z');
  assert.strictEqual(new Date(startOfLocalDay(Date.parse('2026-07-01T00:30:00Z'), TZ)).toISOString(), '2026-06-30T22:00:00.000Z');
  assert.strictEqual(new Date(startOfLocalDay(Date.parse('2026-10-25T12:00:00Z'), TZ)).toISOString(), '2026-10-24T22:00:00.000Z');
});

test('dayStats: hours charging/discharging per reason, idle left out, clipped to the day', () => {
  const dayStart = Date.parse('2026-11-20T23:00:00Z');
  const dayEnd = dayStart + 24 * H;
  const now = dayStart + 12 * H;
  const at = (h) => new Date(dayStart + h * H).toISOString();
  const s = dayStats({
    intervals: [
      { from: at(-2), to: at(1), code: 'ChargingAtLowPrice' }, // only 1 h is today
      { from: at(1), to: at(3), code: 'IdleForGridRewards' }, // idle: no hours
      { from: at(3), to: at(4.5), code: 'DischargingForGridRewards' },
      { from: at(4.5), to: at(5), code: 'ChargingWithSolarProduction' },
      { from: at(11), to: null, code: 'ChargingForGridRewards' }, // running: until now
    ],
    flow: [
      { time: at(3), charged: 0, discharged: 4000 }, // during Grid Rewards: 1 kWh
      { time: at(4.5), charged: 2000, discharged: 0 }, // solar: 0.5 kWh
      { time: at(-1), charged: 8000, discharged: 0 }, // yesterday: left out
    ],
    dayStart,
    dayEnd,
    now,
  });
  assert.deepStrictEqual(s.hours, {
    gridRewards: 2.5, price: 1, solar: 0.5, other: 0,
  });
  assert.deepStrictEqual(s.kwh, {
    charged: 0.5, discharged: 1, gridRewardsCharged: 0, gridRewardsDischarged: 1,
  });
});

test('the query fetches from midnight when the day is given', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');
  const v = batteryVariables({
    homeId: 'h1', batteryId: 'b1', now, dayStart: startOfLocalDay(now, TZ),
  });
  assert.strictEqual(v.activityFrom, '2026-11-20T23:00:00Z');
  assert.strictEqual(v.timelineFrom, '2026-11-20T23:00:00Z');
  const early = Date.parse('2026-11-21T00:30:00Z'); // 01:30 local: six hours back is earlier
  assert.strictEqual(batteryVariables({
    homeId: 'h1', batteryId: 'b1', now: early, dayStart: startOfLocalDay(early, TZ),
  }).activityFrom, '2026-11-20T18:30:00Z');
});

// --- On the battery device ---

function response(dayStartIso, { gr = 2, discharged = 4000 } = {}) {
  const start = Date.parse(dayStartIso);
  const at = (h) => new Date(start + h * H).toISOString();
  return {
    me: {
      home: {
        battery: { aggregatedHistory: { periods: [{ key: 'TODAY', batteryValueItems: [{ value: 3.21, unit: 'kr', kind: 'TOTAL' }] }] } },
        batteryActivityHistory: {
          items: [
            { from: at(1), to: at(1 + gr), reason: { __typename: 'HomeBatteryDischargingForGridRewards' } },
            { from: at(1 + gr), to: null, reason: { __typename: 'HomeBatteryIdleForGridRewards' } },
          ],
        },
        batteryTimeline: {
          energyFlow: { items: [{ kind: 'ACTUAL', time: at(1), charged: 0, discharged }] },
          stateOfCharge: { items: [] },
        },
      },
    },
  };
}

test('battery: today on the device, and at a new day the summary card and the history', async (t) => {
  let now = Date.parse('2026-11-21T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const homey = makeHomey();
  let data = response('2026-11-20T23:00:00Z');
  const vars = [];
  const home = {
    client: { query: async (q, v) => { vars.push(v); return data; } },
    problem: null,
    getData: () => ({ id: 'h1' }),
    getFlexDevices: () => [],
  };
  homey.drivers.registry['grid-reward'] = { getDevices: () => [home] };
  const battery = new FlexDevice({ homey, data: { id: 'b1', homeId: 'h1', kind: 'battery' } });
  battery.getName = () => 'Battery';
  await battery.onInit();
  await battery._pollBattery();
  assert.strictEqual(vars[0].timelineFrom, '2026-11-20T23:00:00Z');
  assert.strictEqual(battery.getCapabilityValue('battery_hours_grid_rewards'), 2);
  assert.strictEqual(battery.getCapabilityValue('battery_discharged_today'), 1);
  assert.strictEqual(battery.getCapabilityValue('battery_hours_price'), 0);

  // The next day: yesterday is finished.
  now = Date.parse('2026-11-22T08:00:00Z');
  data = response('2026-11-21T23:00:00Z', { gr: 1, discharged: 2000 });
  battery.lastPollAt = 0;
  await battery._pollBattery();
  const [summary] = homey.triggered.filter((x) => x.id === 'battery_daily_summary');
  assert.deepStrictEqual(summary.tokens, {
    date: '2026-11-21', hours_grid_rewards: 2, hours_price: 0, hours_solar: 0, charged_kwh: 0, discharged_kwh: 1, savings: 3.21,
  });
  assert.strictEqual(battery.getCapabilityValue('battery_hours_grid_rewards'), 1);
  assert.deepStrictEqual(homey.settings.get('batterydays:h1:b1').map((d) => d.date), ['2026-11-21']);

  // The history page lists today first, then the finished days.
  homey.drivers.registry['flex-device'] = { getDevices: () => [battery] };
  const [b] = history.batteryPlans(homey, TZ, 'sv-SE');
  assert.deepStrictEqual(b.days.map((d) => [d.date, Boolean(d.today), d.hours.gridRewards]), [
    ['2026-11-22', true, 1],
    ['2026-11-21', false, 2],
  ]);
  await battery.onUninit();
});
