'use strict';

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const { TibberAppClient, TibberAuthError } = require('../lib/TibberAppClient');

// Fake Tibber: password "right" works, homes are configurable.
let homes = [{ id: 'h1', title: 'Home' }];
TibberAppClient.prototype.getToken = async function getToken() {
  if (this.password !== 'right') throw new TibberAuthError('Login failed (401)');
  return 'tok';
};
TibberAppClient.prototype.getHomes = async () => homes;

const GridRewardDriver = require('../drivers/grid-reward/driver');

function session() {
  const handlers = {};
  return { handlers, setHandler: (name, fn) => { handlers[name] = fn; } };
}

function fakeDevice(id = 'h1', email = 'a@example.com') {
  return {
    updated: null,
    store: { email },
    getData: () => ({ id }),
    getStore() { return this.store; },
    async updateCredentials(c) { this.updated = c; this.store = { ...c }; },
  };
}

test('pair: wrong password returns false, right one lists homes with credentials', async () => {
  const driver = new GridRewardDriver({ homey: makeHomey() });
  const s = session();
  await driver.onPair(s);
  assert.strictEqual(await s.handlers.login({ username: 'a@example.com', password: 'wrong' }), false);
  assert.strictEqual(await s.handlers.login({ username: 'a@example.com', password: 'right' }), true);
  assert.deepStrictEqual(await s.handlers.list_devices(), [{
    name: 'Grid Rewards – Home',
    data: { id: 'h1' },
    store: { email: 'a@example.com', password: 'right' },
  }]);
});

test('repair: wrong password returns false and does not touch the device', async () => {
  const driver = new GridRewardDriver({ homey: makeHomey() });
  const s = session();
  const device = fakeDevice();
  await driver.onRepair(s, device);
  assert.strictEqual(await s.handlers.login({ username: 'a@example.com', password: 'wrong' }), false);
  assert.strictEqual(device.updated, null);
});

test('repair: account without the home is rejected', async () => {
  homes = [{ id: 'other' }];
  try {
    const driver = new GridRewardDriver({ homey: makeHomey() });
    const s = session();
    const device = fakeDevice();
    await driver.onRepair(s, device);
    await assert.rejects(s.handlers.login({ username: 'b@example.com', password: 'right' }), /has no access to the home/);
    assert.strictEqual(device.updated, null);
  } finally {
    homes = [{ id: 'h1', title: 'Home' }];
  }
});

test('repair: valid login updates the device credentials', async () => {
  const driver = new GridRewardDriver({ homey: makeHomey() });
  const s = session();
  const device = fakeDevice();
  await driver.onRepair(s, device);
  assert.strictEqual(await s.handlers.login({ username: 'a@example.com', password: 'right' }), true);
  assert.deepStrictEqual(device.updated, { email: 'a@example.com', password: 'right' });
});

test('condition is_delivering reads grid_reward_active', async () => {
  const homey = makeHomey();
  const driver = new GridRewardDriver({ homey });
  await driver.onInit();
  const run = homey.conditions.is_delivering;
  assert.strictEqual(await run({ device: { getCapabilityValue: () => true } }), true);
  assert.strictEqual(await run({ device: { getCapabilityValue: () => false } }), false);
});

test('repair: other homes on the same account get the new password too', async () => {
  homes = [{ id: 'h1' }, { id: 'h2' }];
  try {
    const repaired = fakeDevice('h1', 'A@example.com');
    const sibling = fakeDevice('h2', 'a@example.com'); // same account, other case
    const otherAccount = fakeDevice('h3', 'someone@example.com');
    const notInAccount = fakeDevice('h9', 'a@example.com'); // the account no longer has this home
    const driver = new GridRewardDriver({ homey: makeHomey(), devices: [repaired, sibling, otherAccount, notInAccount] });
    const s = session();
    await driver.onRepair(s, repaired);
    assert.strictEqual(await s.handlers.login({ username: 'a@example.com', password: 'right' }), true);
    assert.deepStrictEqual(repaired.updated, { email: 'a@example.com', password: 'right' });
    assert.deepStrictEqual(sibling.updated, { email: 'a@example.com', password: 'right' });
    assert.strictEqual(otherAccount.updated, null);
    assert.strictEqual(notInAccount.updated, null);
  } finally {
    homes = [{ id: 'h1', title: 'Home' }];
  }
});
