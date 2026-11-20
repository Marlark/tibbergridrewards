'use strict';

// One login and WebSocket per Tibber account, shared by its homes (#22).

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const GridRewardSubscription = require('../lib/GridRewardSubscription');
const ConnectionPool = require('../lib/ConnectionPool');

// Never touch the network: capture subscriptions instead of connecting.
const subs = [];
GridRewardSubscription.prototype.start = function start() { this._stopped = false; subs.push(this); };

const GridRewardDevice = require('../drivers/grid-reward/device');

const status = (homeId, month) => ({
  homeId, state: { __typename: 'GridRewardAvailable', kind: 'available' }, rewardCurrentMonth: month, rewardAllTime: 100,
});

async function home(homey, id, email = 'a@example.com', password = 'pw') {
  const d = new GridRewardDevice({ homey, data: { id }, store: { email, password } });
  await d.onInit();
  return d;
}

test('two homes on the same account share one login and one WebSocket', async () => {
  subs.length = 0;
  const homey = makeHomey();
  const a = await home(homey, 'h1');
  const b = await home(homey, 'h2', 'A@Example.com'); // same account, other case
  assert.strictEqual(subs.length, 1);
  assert.strictEqual(a.client, b.client);
  assert.strictEqual(a.sub, b.sub);
  assert.deepStrictEqual([...subs[0].homeIds].sort(), ['h1', 'h2']);
  await a.onUninit();
  await b.onUninit();
});

test('each home only takes its own data', async () => {
  subs.length = 0;
  const homey = makeHomey();
  const a = await home(homey, 'h1');
  const b = await home(homey, 'h2');
  subs[0].emit('data', status('h2', 22), 'h2');
  subs[0].emit('data', status('h1', 11), 'h1');
  await a._queue;
  await b._queue;
  assert.strictEqual(a.getCapabilityValue('grid_reward_month'), 11);
  assert.strictEqual(b.getCapabilityValue('grid_reward_month'), 22);
  await a.onUninit();
  await b.onUninit();
});

test('different accounts get their own connection', async () => {
  subs.length = 0;
  const homey = makeHomey();
  const a = await home(homey, 'h1', 'a@example.com');
  const c = await home(homey, 'h3', 'c@example.com');
  assert.strictEqual(subs.length, 2);
  assert.notStrictEqual(a.client, c.client);
  await a.onUninit();
  await c.onUninit();
});

test('the connection stays while one home is left, and stops with the last', async () => {
  subs.length = 0;
  const homey = makeHomey();
  const a = await home(homey, 'h1');
  const b = await home(homey, 'h2');
  const sub = subs[0];
  await a.onDeleted();
  assert.strictEqual(sub._stopped, false);
  assert.deepStrictEqual([...sub.homeIds], ['h2']);
  assert.strictEqual(sub.listenerCount('data'), 1, 'the removed home stops listening');
  await b.onDeleted();
  assert.strictEqual(sub._stopped, true);
  assert.strictEqual(ConnectionPool.for(homey).accounts.size, 0);
});

test('a home joining an open connection shows "Connected" at once', async () => {
  subs.length = 0;
  const homey = makeHomey();
  const a = await home(homey, 'h1');
  subs[0].connected = true;
  subs[0].emit('connected');
  const b = await home(homey, 'h2');
  assert.strictEqual(a.getSetting('conn_status'), 'Connected');
  assert.strictEqual(b.getSetting('conn_status'), 'Connected');
  await a.onUninit();
  await b.onUninit();
});

test('a new password from one home is used for the shared login', async () => {
  subs.length = 0;
  const homey = makeHomey();
  const a = await home(homey, 'h1', 'a@example.com', 'old');
  a.client._token = 'cached';
  const b = await home(homey, 'h2', 'a@example.com', 'new');
  assert.strictEqual(b.client.password, 'new');
  assert.strictEqual(a.client._token, null, 'logs in again with the new password');
  await a.onUninit();
  await b.onUninit();
});
