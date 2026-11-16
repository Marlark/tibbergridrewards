'use strict';

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const GridRewardSubscription = require('../lib/GridRewardSubscription');
const { TibberAuthError } = require('../lib/TibberAppClient');

// Never touch the network: capture subscriptions instead of connecting.
const subs = [];
GridRewardSubscription.prototype.start = function start() { this._stopped = false; subs.push(this); };

const GridRewardDevice = require('../drivers/grid-reward/device');

const status = (typename, month, extra = {}) => ({
  homeId: 'h1',
  state: { __typename: typename, ...extra },
  rewardCurrency: 'SEK',
  rewardCurrentMonth: month,
  rewardAllTime: 900 + month,
});

async function makeDevice(opts = {}) {
  subs.length = 0;
  const homey = makeHomey();
  const device = new GridRewardDevice({
    homey, data: { id: 'h1' }, store: { email: 'a@example.com', password: 'pw' }, ...opts,
  });
  await device.onInit();
  return { device, homey, sub: subs[0] };
}

const settle = (device) => device._queue;

test('updates capabilities from a status', async () => {
  const { device, sub } = await makeDevice();
  sub.emit('data', status('GridRewardAvailable', 40, { kind: 'vehicle' }));
  await settle(device);
  assert.strictEqual(device.getCapabilityValue('grid_reward_state'), 'available');
  assert.strictEqual(device.getCapabilityValue('grid_reward_active'), false);
  assert.strictEqual(device.getCapabilityValue('grid_reward_reason'), 'vehicle');
  assert.strictEqual(device.getCapabilityValue('grid_reward_month'), 40);
  assert.strictEqual(device.getCapabilityValue('grid_reward_today'), 0);
  assert.strictEqual(device.getCapabilityValue('grid_reward_all_time'), 940);
  assert.strictEqual(device.getStoreValue('tracker').lastMonth, 40);
});

test('rapid duplicate updates trigger state_changed and session_started only once', async () => {
  const { device, homey, sub } = await makeDevice({ capabilities: { grid_reward_state: 'available' } });
  sub.emit('data', status('GridRewardDelivering', 40, { reason: 'frequencyRegulation' }));
  sub.emit('data', status('GridRewardDelivering', 40, { reason: 'frequencyRegulation' }));
  await settle(device);
  assert.deepStrictEqual(homey.triggered.map((t) => t.id), ['state_changed', 'session_started']);
  assert.deepStrictEqual(homey.triggered[0].tokens, { state: 'delivering', reason: 'frequencyRegulation' });
});

test('session_ended carries reward and duration', async (t) => {
  let now = Date.parse('2026-11-16T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const { device, homey, sub } = await makeDevice({ capabilities: { grid_reward_state: 'available' } });
  sub.emit('data', status('GridRewardDelivering', 40));
  await settle(device);
  now += 20 * 60000;
  sub.emit('data', status('GridRewardDelivering', 41.25));
  await settle(device);
  assert.strictEqual(device.getCapabilityValue('grid_reward_session'), 1.25);
  now += 10 * 60000;
  sub.emit('data', status('GridRewardAvailable', 41.5));
  await settle(device);
  const ended = homey.triggered.find((x) => x.id === 'session_ended');
  assert.deepStrictEqual(ended.tokens, { reward: 1.5, minutes: 30 });
  assert.strictEqual(device.getCapabilityValue('grid_reward_session'), 0);
});

test('auth error makes the device unavailable; connected makes it available again', async () => {
  const { device, sub } = await makeDevice();
  sub.emit('error', new TibberAuthError('Login failed (401)'));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(device.available, false);
  assert.strictEqual(device.unavailableMessage, 'error.auth');
  sub.emit('connected');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(device.available, true);
});

test('updateCredentials stores new login and restarts the subscription', async () => {
  const { device, sub } = await makeDevice();
  await device.updateCredentials({ email: 'new@example.com', password: 'new' });
  assert.strictEqual(sub._stopped, true);
  assert.strictEqual(subs.length, 2);
  assert.strictEqual(device.getStoreValue('password'), 'new');
  assert.strictEqual(device.client.email, 'new@example.com');
});

test('record_raw logs each update as a [REC] line', async () => {
  const { device, sub } = await makeDevice({ settings: { record_raw: true } });
  sub.emit('data', status('GridRewardAvailable', 40));
  await settle(device);
  const line = device.logs.find((l) => l.startsWith('[REC] '));
  const rec = JSON.parse(line.slice(6));
  assert.strictEqual(rec.tz, 'Europe/Stockholm');
  assert.strictEqual(rec.status.rewardCurrentMonth, 40);
});

test('onUninit stops subscription and day timer', async () => {
  const { device, homey, sub } = await makeDevice();
  await device.onUninit();
  assert.strictEqual(sub._stopped, true);
  assert.ok(homey.timers.every((x) => x.cleared));
});
