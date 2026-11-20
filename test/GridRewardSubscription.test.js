'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

// Replace the ws module with a fake before loading the subscription.
const created = [];
class FakeWebSocket extends EventEmitter {
  constructor(...args) {
    super();
    this.args = args;
    this.sent = [];
    created.push(this);
  }

  send(data) { this.sent.push(JSON.parse(data)); }

  close() { this.emit('close'); }

  terminate() { this.emit('close'); }
}
require.cache[require.resolve('ws')] = { exports: FakeWebSocket, loaded: true };

const GridRewardSubscription = require('../lib/GridRewardSubscription');
const { TibberAuthError } = require('../lib/TibberAppClient');

function fakeHomey() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout(t) { if (t) t.cleared = true; },
    setInterval(fn, ms) {
      const t = { fn, ms, cleared: false, interval: true };
      timers.push(t);
      return t;
    },
    clearInterval(t) { if (t) t.cleared = true; },
  };
}

test('stop() during getToken: no WebSocket is opened afterwards', async () => {
  created.length = 0;
  let resolveToken;
  const client = { getToken: () => new Promise((r) => { resolveToken = r; }) };
  const sub = new GridRewardSubscription({ client, homeId: 'h1', homey: fakeHomey() });
  sub.start();
  sub.stop();
  resolveToken('tok');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(created.length, 0);
});

test('auth error: retries only after 6 h, not with the fast backoff', async () => {
  const homey = fakeHomey();
  const client = { getToken: async () => { throw new TibberAuthError('Login failed (401)'); } };
  const sub = new GridRewardSubscription({ client, homeId: 'h1', homey });
  const errors = [];
  sub.on('error', (e) => errors.push(e));
  sub.start();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(errors.length, 1);
  const retry = homey.timers.filter((t) => !t.cleared);
  assert.strictEqual(retry.length, 1);
  assert.strictEqual(retry[0].ms, 6 * 60 * 60 * 1000);
  assert.strictEqual(sub._retryMs, 5000); // fast backoff untouched
  sub.stop();
});

test('network error: fast exponential backoff', async () => {
  const homey = fakeHomey();
  const client = { getToken: async () => { throw new Error('ECONNRESET'); } };
  const sub = new GridRewardSubscription({ client, homeId: 'h1', homey });
  sub.on('error', () => {});
  sub.start();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(homey.timers[0].ms, 5000);
  assert.strictEqual(sub._retryMs, 10000);
  sub.stop();
});

const live = (homey, pred) => homey.timers.filter((t) => !t.cleared && pred(t));

async function connected() {
  created.length = 0;
  const homey = fakeHomey();
  const sub = new GridRewardSubscription({ client: { getToken: async () => 'tok' }, homeId: 'h1', homey });
  sub.on('error', () => {});
  sub.start();
  await new Promise((r) => setImmediate(r));
  const ws = created[0];
  ws.emit('open');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'connection_ack' })));
  return { homey, sub, ws };
}

test('after ack: client pings every 60 s', async () => {
  const { homey, sub, ws } = await connected();
  const pinger = live(homey, (t) => t.interval);
  assert.strictEqual(pinger.length, 1);
  assert.strictEqual(pinger[0].ms, 60 * 1000);
  pinger[0].fn();
  assert.deepStrictEqual(ws.sent.at(-1), { type: 'ping' });
  sub.stop();
  assert.strictEqual(live(homey, (t) => t.interval).length, 0);
});

test('watchdog is 3 min and is kicked by pong', async () => {
  const { homey, sub, ws } = await connected();
  const before = live(homey, (t) => !t.interval && t.ms === 3 * 60 * 1000);
  assert.strictEqual(before.length, 1);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'pong' })));
  assert.ok(before[0].cleared);
  assert.strictEqual(live(homey, (t) => !t.interval && t.ms === 3 * 60 * 1000).length, 1);
  sub.stop();
});

test('dead connection: watchdog terminates, pinger stops, reconnect is scheduled', async () => {
  const { homey, sub } = await connected();
  live(homey, (t) => !t.interval && t.ms === 3 * 60 * 1000)[0].fn();
  assert.strictEqual(live(homey, (t) => t.interval).length, 0);
  assert.strictEqual(live(homey, (t) => !t.interval && t.ms === 5000).length, 1);
  sub.stop();
});

// --- API changes ---

const { TibberApiChangedError, graphqlError } = require('../lib/TibberAppClient');

const send = (ws, msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));

test('graphqlError: schema errors become TibberApiChangedError', () => {
  assert.ok(graphqlError([{ message: 'Cannot query field "rewardCurrentMonth" on type "GridReward".' }]) instanceof TibberApiChangedError);
  assert.ok(graphqlError([{ message: 'x', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }]) instanceof TibberApiChangedError);
  assert.ok(graphqlError([{ message: 'Unknown type "GridRewardBattery".' }]) instanceof TibberApiChangedError);
  const other = graphqlError([{ message: 'Internal server error' }]);
  assert.ok(!(other instanceof TibberApiChangedError));
  assert.match(other.message, /Internal server error/);
});

test('subscription error with schema problem: emits API change, closes, retries in 1 h', async () => {
  const { homey, sub, ws } = await connected();
  const errors = [];
  sub.on('error', (e) => errors.push(e));
  send(ws, { id: 'grid-h1', type: 'error', payload: [{ message: 'Cannot query field "rewardAllTime" on type "GridReward".' }] });
  assert.ok(errors[0] instanceof TibberApiChangedError);
  assert.strictEqual(live(homey, (t) => !t.interval && t.ms === 60 * 60 * 1000).length, 1);
  sub.stop();
});

test('other subscription error: closes and reconnects with normal backoff', async () => {
  const { homey, sub, ws } = await connected();
  sub.on('error', () => {});
  send(ws, { id: 'grid-h1', type: 'error', payload: [{ message: 'Internal server error' }] });
  assert.strictEqual(live(homey, (t) => !t.interval && t.ms === 5000).length, 1);
  sub.stop();
});

test('next with errors and no data counts as a failed subscription', async () => {
  const { homey, sub, ws } = await connected();
  const errors = [];
  sub.on('error', (e) => errors.push(e));
  send(ws, { id: 'grid-h1', type: 'next', payload: { data: null, errors: [{ message: 'Unknown argument "homeId"' }] } });
  assert.ok(errors[0] instanceof TibberApiChangedError);
  assert.strictEqual(live(homey, (t) => !t.interval && t.ms === 60 * 60 * 1000).length, 1);
  sub.stop();
});

test('login endpoint gone (404) counts as an API change and retries in 1 h', async () => {
  const homey = fakeHomey();
  const client = { getToken: async () => { throw new TibberApiChangedError('Login endpoint gone (404)'); } };
  const sub = new GridRewardSubscription({ client, homeId: 'h1', homey });
  sub.on('error', () => {});
  sub.start();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(homey.timers.filter((t) => !t.cleared)[0].ms, 60 * 60 * 1000);
  sub.stop();
});

// --- Why the server closed the connection ---

test('describeClose: code, meaning, reason and how long the connection lived', () => {
  const { describeClose } = GridRewardSubscription;
  const t0 = Date.parse('2026-11-18T09:00:00Z');
  assert.strictEqual(describeClose(1000, Buffer.from(''), t0, t0 + 62 * 60000), 'Connection closed: 1000 normal closure, after 62 min');
  assert.strictEqual(describeClose(4401, Buffer.from('Unauthorized'), t0, t0 + 180 * 60000),
    'Connection closed: 4401 unauthorized (token expired?), "Unauthorized", after 180 min');
  assert.strictEqual(describeClose(4999, '', null), 'Connection closed: 4999, before it was ready');
});

test('a server close is logged with its code before reconnecting', async () => {
  created.length = 0;
  const lines = [];
  const homey = fakeHomey();
  homey.setInterval = () => ({});
  homey.clearInterval = () => {};
  const sub = new GridRewardSubscription({
    client: { getToken: async () => 'tok' }, homeId: 'h1', homey, log: (l) => lines.push(l),
  });
  sub.on('error', () => {});
  sub.start();
  await new Promise((r) => setImmediate(r));
  const ws = created[0];
  ws.emit('open');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'connection_ack' })));
  ws.emit('close', 1001, Buffer.from(''));
  assert.match(lines.find((l) => l.startsWith('Connection closed')), /^Connection closed: 1001 server going away, after 0 min$/);
  assert.ok(lines.some((l) => l.startsWith('Reconnecting in 5 s')));
  sub.stop();
});

// --- Several homes on one socket ---

test('several homes: one subscribe per home on connect, data routed by subscription id', async () => {
  const { sub, ws } = await connected(); // connected() starts with home h1
  sub.addHome('h2'); // added after connect: subscribes at once
  const subscribes = ws.sent.filter((m) => m.type === 'subscribe');
  assert.deepStrictEqual(subscribes.map((m) => [m.id, m.payload.variables.homeId]), [['grid-h1', 'h1'], ['grid-h2', 'h2']]);
  const got = [];
  sub.on('data', (status, homeId) => got.push([homeId, status.rewardCurrentMonth]));
  send(ws, { id: 'grid-h2', type: 'next', payload: { data: { gridRewardStatus: { homeId: 'h2', rewardCurrentMonth: 7 } } } });
  send(ws, { id: 'grid-h1', type: 'next', payload: { data: { gridRewardStatus: { homeId: 'h1', rewardCurrentMonth: 3 } } } });
  assert.deepStrictEqual(got, [['h2', 7], ['h1', 3]]);
  sub.stop();
});

test('removing a home ends only its subscription; the socket stays for the others', async () => {
  const { sub, ws } = await connected();
  sub.addHome('h2');
  let closed = false;
  ws.on('close', () => { closed = true; });
  sub.removeHome('h2');
  assert.deepStrictEqual(ws.sent.at(-1), { type: 'complete', id: 'grid-h2' });
  send(ws, { id: 'grid-h2', type: 'complete' }); // the server confirms: no reconnect
  assert.strictEqual(closed, false);
  send(ws, { id: 'grid-h1', type: 'complete' }); // a home we still want ended: reconnect
  assert.strictEqual(closed, true);
  sub.stop();
});
