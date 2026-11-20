'use strict';

// Dashboard widget API

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey, Device } = require('./helpers/homey-stub');
const { getStatus } = require('../widgets/grid-rewards/api');

function device(homey, { id, data, caps, name = 'Home' }) {
  const d = new Device({ homey, data, capabilities: caps });
  d.getId = () => id;
  d.getName = () => name;
  return d;
}

function setup() {
  const homey = makeHomey();
  const home = device(homey, {
    id: 'dev-1',
    data: { id: 'h1' },
    caps: {
      grid_reward_state: 'delivering', grid_reward_reason: 'Excess power in the grid', grid_reward_active: true, grid_reward_today: 16.64, grid_reward_month: 679.69, grid_reward_session: 1.25, grid_reward_last_session: 2.53, grid_reward_sessions_today: 9, grid_reward_minutes_today: 438,
    },
  });
  const other = device(homey, { id: 'dev-2', data: { id: 'h2' }, caps: { grid_reward_state: 'available', grid_reward_today: 1 }, name: 'Cabin' });
  const battery = device(homey, {
    id: 'dev-3', data: { id: 'b1', homeId: 'h1', kind: 'battery' }, caps: { battery_activity: 'Charging for Grid Rewards', battery_savings_today: 3.21 },
  });
  homey.drivers.registry['grid-reward'] = { getDevices: () => [home, other] };
  homey.drivers.registry['flex-device'] = { getDevices: () => [battery] };
  return homey;
}

test('widget: values of the chosen home device with translated labels and its battery', async () => {
  const s = await getStatus({ homey: setup(), query: { deviceId: 'dev-1' } });
  assert.strictEqual(s.stateText, 'Delivering');
  assert.strictEqual(s.today, 16.64);
  assert.strictEqual(s.session, 1.25);
  assert.strictEqual(s.sessionsToday, 9);
  assert.deepStrictEqual(s.battery, { activity: 'Charging for Grid Rewards', savingsToday: 3.21 });
  assert.strictEqual(s.labels.month, 'This month');
});

test('widget: another home, no battery; unknown id falls back to the first home', async () => {
  const homey = setup();
  const s = await getStatus({ homey, query: { deviceId: 'dev-2' } });
  assert.strictEqual(s.name, 'Cabin');
  assert.strictEqual(s.battery, null);
  assert.strictEqual((await getStatus({ homey, query: { deviceId: 'nope' } })).name, 'Home');
});

test('widget: without a home device it explains what to do', async () => {
  const homey = makeHomey();
  const s = await getStatus({ homey, query: {} });
  assert.match(s.error, /Add a Grid Rewards home device first/);
});

// --- Last 7 days widget ---

const { getWeek } = require('../widgets/grid-rewards-week/api');

test('week widget: 7 days oldest first, today live, days before the app as null', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-20T10:00:00Z') });
  const homey = makeHomey();
  const home = device(homey, { id: 'dev-1', data: { id: 'h1' }, caps: { grid_reward_today: 3.5 } });
  home.getDays = () => [
    { date: '2026-11-19', reward: 12.25 },
    { date: '2026-11-18', reward: 8 },
    { date: '2026-11-10', reward: 99 }, // outside the window
  ];
  home.getCurrencyUnit = () => 'kr';
  homey.drivers.registry['grid-reward'] = { getDevices: () => [home] };
  const w = await getWeek({ homey, query: { deviceId: 'dev-1' } });
  assert.deepStrictEqual(w.days.map((d) => d.date),
    ['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
  assert.deepStrictEqual(w.days.map((d) => d.reward), [null, null, null, null, 8, 12.25, 3.5]);
  assert.deepStrictEqual(w.days.map((d) => d.today), [false, false, false, false, false, false, true]);
  assert.strictEqual(w.days[6].label, 'Fri'); // en-GB weekday, 2026-11-20 is a Friday
  assert.strictEqual(w.total, 23.75);
  assert.strictEqual(w.labels.title, 'Last 7 days');
});

test('week widget: crosses a month boundary', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-12-02T10:00:00Z') });
  const homey = makeHomey();
  const home = device(homey, { id: 'dev-1', data: { id: 'h1' }, caps: {} });
  home.getDays = () => [];
  homey.drivers.registry['grid-reward'] = { getDevices: () => [home] };
  const w = await getWeek({ homey, query: {} });
  assert.deepStrictEqual(w.days.map((d) => d.date),
    ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  assert.strictEqual(w.days[6].reward, 0);
});

// --- Battery plan widget (#15) ---

const { getPlan } = require('../widgets/grid-rewards-battery-plan/api');
const { planSvg } = require('../lib/planChart');

function battery(homey, id, name, points) {
  return {
    getId: () => id,
    getName: () => name,
    getData: () => ({ id: `b-${id}`, kind: 'battery' }),
    getPlan: () => ({ points, updatedAt: Date.parse('2026-11-20T10:07:00Z') }),
  };
}

const planPoints = [
  { time: '2026-11-20T22:45:00Z', soc: 40, powerW: 0, forecast: true },
  { time: '2026-11-20T23:00:00Z', soc: 48.4, powerW: 3000, forecast: true },
  { time: '2026-11-20T23:15:00Z', soc: 40, powerW: -2500, forecast: true },
];

test('battery plan widget: the chosen battery, its current level and a compact SVG', async () => {
  const homey = makeHomey();
  homey.drivers.registry['flex-device'] = {
    getDevices: () => [battery(homey, 'dev-b1', 'Garage', []), battery(homey, 'dev-b2', 'Basement', planPoints)],
  };
  const w = await getPlan({ homey, query: { deviceId: 'dev-b2' } });
  assert.strictEqual(w.name, 'Basement');
  assert.strictEqual(w.soc, 40);
  assert.strictEqual(w.labels.plan_title, 'Planned charge level');
  assert.match(w.svg, /^<svg viewBox="0 0 320 /);
  assert.match(w.svg, /class="charge"/);
  assert.match(w.svg, /class="discharge"/);
  assert.match(w.svg, /class="day"/, 'a line where the next day starts (00:00 Stockholm)');
  assert.match(w.svg, /<text[^>]*>00:00<\/text>/);

  const empty = await getPlan({ homey, query: { deviceId: 'dev-b1' } });
  assert.strictEqual(empty.svg, '');
  const fallback = await getPlan({ homey, query: { deviceId: 'gone' } });
  assert.strictEqual(fallback.name, 'Garage');
});

test('battery plan widget: without a battery it explains what to do', async () => {
  const homey = makeHomey();
  assert.deepStrictEqual(await getPlan({ homey, query: {} }), { error: 'Add a home battery from Tibber to see its plan.' });
});

test('plan chart escapes text and draws nothing without points', () => {
  assert.strictEqual(planSvg([]), '');
  const svg = planSvg([{ label: '<b>', day: 'x', dayKey: 'a', soc: 50, powerW: 0 }], { title: '"t"' });
  assert.ok(!svg.includes('<b>'));
  assert.match(svg, /aria-label="&quot;t&quot;"/);
});
