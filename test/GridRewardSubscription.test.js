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
