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
