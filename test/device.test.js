'use strict';

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const GridRewardSubscription = require('../lib/GridRewardSubscription');
const { TibberAuthError, TibberApiChangedError } = require('../lib/TibberAppClient');

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
  sub.emit('data', status('GridRewardDelivering', 40, { reason: 'excess' }));
  sub.emit('data', status('GridRewardDelivering', 40, { reason: 'excess' }));
  await settle(device);
  assert.deepStrictEqual(homey.triggered.map((t) => t.id), ['state_changed', 'session_started']);
  assert.deepStrictEqual(homey.triggered[0].tokens, {
    state: 'delivering', reason: 'Excess power in the grid', reason_code: 'excess',
  });
  assert.deepStrictEqual(homey.triggered[1].tokens, { reason: 'Excess power in the grid', reason_code: 'excess' });
});

test('reason is translated; an unknown code is shown as it is', async () => {
  const { device, sub } = await makeDevice();
  sub.emit('data', status('GridRewardDelivering', 40, { reason: 'shortage' }));
  await settle(device);
  assert.strictEqual(device.getCapabilityValue('grid_reward_reason'), 'Power shortage in the grid');
  sub.emit('data', status('GridRewardUnavailable', 40, { reasons: ['brandNewCode'] }));
  await settle(device);
  assert.strictEqual(device.getCapabilityValue('grid_reward_reason'), 'brandNewCode');
});

test('midnight timer fires daily_summary and resets today', async (t) => {
  let now = Date.parse('2026-11-16T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['Date'], now });
  const { device, homey, sub } = await makeDevice();
  sub.emit('data', status('GridRewardAvailable', 40));
  sub.emit('data', status('GridRewardAvailable', 43.5));
  await settle(device);
  assert.strictEqual(device.getCapabilityValue('grid_reward_today'), 3.5);
  now = Date.parse('2026-11-16T23:00:30Z'); // 00:00:30 in Stockholm
  t.mock.timers.setTime(now);
  homey.timers.find((x) => x.ms === 60 * 1000).fn();
  await settle(device);
  const summary = homey.triggered.find((x) => x.id === 'daily_summary');
  assert.deepStrictEqual(summary.tokens, {
    reward: 3.5, sessions: 0, minutes: 0, date: '2026-11-16',
  });
  assert.strictEqual(device.getCapabilityValue('grid_reward_today'), 0);
});

test('API change: unavailable with message, one notification, recovers on data', async () => {
  const { device, homey, sub } = await makeDevice();
  const err = new TibberApiChangedError('API changed: Cannot query field "rewardCurrentMonth"');
  sub.emit('error', err);
  sub.emit('connected'); // hourly retry: login works, subscription fails again
  sub.emit('error', err);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(device.available, false);
  assert.match(device.unavailableMessage, /changed its API/);
  assert.strictEqual(homey.notifications.sent.length, 1);
  sub.emit('data', status('GridRewardAvailable', 40));
  await settle(device);
  assert.strictEqual(device.available, true);
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
  assert.strictEqual(device.getCapabilityValue('grid_reward_session'), 0);
  // Waits for Tibber's settlement of the last quarter
  assert.strictEqual(homey.triggered.find((x) => x.id === 'session_ended'), undefined);
  now += 40000;
  sub.emit('data', status('GridRewardAvailable', 41.6));
  await settle(device);
  const ended = homey.triggered.find((x) => x.id === 'session_ended');
  assert.deepStrictEqual(ended.tokens, { reward: 1.6, minutes: 30 });
});

test('without a settlement, the timer fires session_ended after SETTLE_MS', async (t) => {
  let now = Date.parse('2026-11-16T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const { device, homey, sub } = await makeDevice({ capabilities: { grid_reward_state: 'available' } });
  sub.emit('data', status('GridRewardDelivering', 40));
  await settle(device);
  now += 15 * 60000;
  sub.emit('data', status('GridRewardAvailable', 41));
  await settle(device);
  const timer = homey.timers.find((x) => !x.cleared && x.ms > 3 * 60000 && x.ms < 4 * 60000);
  assert.ok(timer, 'settle timer scheduled');
  now += timer.ms;
  timer.fn();
  await settle(device);
  const ended = homey.triggered.find((x) => x.id === 'session_ended');
  assert.deepStrictEqual(ended.tokens, { reward: 1, minutes: 15 });
  assert.strictEqual(device.getStoreValue('tracker').pending, null);
});

test('auth error makes the device unavailable; connected makes it available again', async () => {
  const { device, sub } = await makeDevice();
  sub.emit('error', new TibberAuthError('Login failed (401)'));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(device.available, false);
  assert.match(device.unavailableMessage, /Tibber login failed/);
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

async function recLines(env, envJson = {}) {
  const homeyModule = require('./helpers/homey-stub');
  const saved = process.env.DEBUG;
  if (env === undefined) delete process.env.DEBUG; else process.env.DEBUG = env;
  Object.assign(homeyModule.env, envJson);
  try {
    const { device, sub } = await makeDevice();
    sub.emit('data', status('GridRewardAvailable', 40));
    await settle(device);
    return device.logs.filter((l) => l.startsWith('[REC] '));
  } finally {
    if (saved === undefined) delete process.env.DEBUG; else process.env.DEBUG = saved;
    for (const k of Object.keys(envJson)) delete homeyModule.env[k];
  }
}

test('homey app run (DEBUG=1) records each update as a [REC] line', async () => {
  const [line] = await recLines('1');
  const rec = JSON.parse(line.slice(6));
  assert.strictEqual(rec.tz, 'Europe/Stockholm');
  assert.strictEqual(rec.status.rewardCurrentMonth, 40);
});

test('a published app (no DEBUG) never records', async () => {
  assert.deepStrictEqual(await recLines(undefined), []);
});

test('without RECORD_RAW in env.json, the variable is never read (Homey warns on that)', async () => {
  const homeyModule = require('./helpers/homey-stub');
  const real = homeyModule.env;
  const reads = [];
  // Like Homey.env: reading a missing key logs a warning
  homeyModule.env = new Proxy({}, { get: (o, k) => { if (!(k in o)) reads.push(k); return o[k]; } });
  try {
    assert.strictEqual((await recLines('1')).length, 1);
    assert.deepStrictEqual(reads, []);
  } finally {
    homeyModule.env = real;
  }
});

test('RECORD_RAW=0 in env.json turns recording off during homey app run', async () => {
  assert.deepStrictEqual(await recLines('1', { RECORD_RAW: '0' }), []);
});

test('onUninit stops subscription and day timer', async () => {
  const { device, homey, sub } = await makeDevice();
  await device.onUninit();
  assert.strictEqual(sub._stopped, true);
  assert.ok(homey.timers.every((x) => x.cleared));
});

test('statistics capabilities follow sessions; old devices get them added', async (t) => {
  let now = Date.parse('2026-11-16T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const capabilityList = ['grid_reward_state', 'grid_reward_active', 'grid_reward_reason', 'grid_reward_session',
    'grid_reward_today', 'grid_reward_month', 'grid_reward_all_time'];
  const { device, sub } = await makeDevice({ capabilityList });
  assert.ok(device.hasCapability('grid_reward_sessions_month'));
  sub.emit('data', status('GridRewardDelivering', 40));
  await settle(device);
  now += 20 * 60000;
  sub.emit('data', status('GridRewardAvailable', 41));
  await settle(device);
  now += 40000;
  sub.emit('data', status('GridRewardAvailable', 41.3));
  await settle(device);
  assert.strictEqual(device.getCapabilityValue('grid_reward_last_session'), 1.3);
  assert.strictEqual(device.getCapabilityValue('grid_reward_sessions_today'), 1);
  assert.strictEqual(device.getCapabilityValue('grid_reward_minutes_today'), 20);
  assert.strictEqual(device.getCapabilityValue('grid_reward_sessions_month'), 1);
});
