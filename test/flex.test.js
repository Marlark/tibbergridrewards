'use strict';

// Cars and batteries: forwarded from the home device, paired from its cache.

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const GridRewardSubscription = require('../lib/GridRewardSubscription');

const subs = [];
GridRewardSubscription.prototype.start = function start() { this._stopped = false; subs.push(this); };

const GridRewardDevice = require('../drivers/grid-reward/device');
const FlexDevice = require('../drivers/flex-device/device');
const FlexDeviceDriver = require('../drivers/flex-device/driver');

// Shapes as in the real recording of 2026-11-17 (anonymised).
const car = (plugged, state = { __typename: 'GridRewardUnavailable', reasons: ['noVehiclesPluggedIn'] }) => ({
  __typename: 'GridRewardVehicle', kind: 'vehicle', vehicleId: 'v1', shortName: 'Car', make: 'EV3', isPluggedIn: plugged, isSmartChargingEnabled: true, state,
});
const battery = {
  __typename: 'GridRewardBattery', kind: 'battery', batteryId: 'b1', shortName: 'Battery', make: 'Huawei', isSmartModeEnabled: true, state: { __typename: 'GridRewardAvailable', kind: 'available' },
};
const status = (flexDevices) => ({
  homeId: 'h1', state: { __typename: 'GridRewardAvailable', kind: 'available' }, rewardCurrentMonth: 10, rewardAllTime: 100, flexDevices,
});

async function setup({ flexData = [] } = {}) {
  subs.length = 0;
  const homey = makeHomey();
  const home = new GridRewardDevice({ homey, data: { id: 'h1' }, store: { email: 'a@example.com', password: 'pw' } });
  const flex = flexData.map((data) => new FlexDevice({
    homey,
    data,
    capabilityList: data.kind === 'vehicle'
      ? ['grid_reward_state', 'grid_reward_reason', 'flex_plugged_in', 'flex_smart_enabled']
      : ['grid_reward_state', 'grid_reward_reason', 'flex_smart_enabled'],
  }));
  homey.drivers.registry['grid-reward'] = { getDevices: () => [home] };
  homey.drivers.registry['flex-device'] = { getDevices: () => flex };
  await home.onInit();
  for (const f of flex) await f.onInit();
  return {
    homey, home, flex, sub: subs[0],
  };
}

test('home device caches flex devices for pairing', async () => {
  const { home, sub } = await setup();
  sub.emit('data', status([car(false), battery]));
  await home._queue;
  assert.deepStrictEqual(home.getFlexDevices().map((f) => [f.id, f.kind, f.name]), [['v1', 'vehicle', 'Car'], ['b1', 'battery', 'Battery']]);
});

const EARNED = [
  'flex_reward_today', 'flex_reward_month', 'flex_reward_total', 'flex_reward_share',
  'grid_reward_sessions_today', 'grid_reward_minutes_today', 'grid_reward_sessions_month', 'grid_reward_availability',
];

test('pairing lists car and battery with the right capabilities', async () => {
  const { homey, home, sub } = await setup();
  sub.emit('data', status([car(false), battery]));
  await home._queue;
  const driver = new FlexDeviceDriver({ homey });
  const list = await driver.onPairListDevices();
  assert.deepStrictEqual(list, [
    {
      name: 'Car (EV3)',
      data: { id: 'v1', homeId: 'h1', kind: 'vehicle' },
      capabilities: ['grid_reward_state', 'grid_reward_reason', ...EARNED, 'flex_plugged_in', 'flex_smart_enabled'],
      icon: '/vehicle.svg',
    },
    {
      name: 'Battery (Huawei)',
      data: { id: 'b1', homeId: 'h1', kind: 'battery' },
      capabilities: ['grid_reward_state', 'grid_reward_reason', ...EARNED, 'flex_smart_enabled',
        'battery_savings_today', 'battery_savings_week', 'battery_savings_month',
        'battery_activity', 'battery_next_activity'],
      icon: '/battery.svg',
    },
  ]);
  // Every capability the devices get must be declared for the driver.
  const declared = require('../drivers/flex-device/driver.compose.json').capabilities;
  for (const d of list) for (const c of d.capabilities) assert.ok(declared.includes(c), c);
});

test('pairing without a home device, or before any data, explains what to do', async () => {
  const homey = makeHomey();
  homey.drivers.registry['grid-reward'] = { getDevices: () => [] };
  await assert.rejects(new FlexDeviceDriver({ homey }).onPairListDevices(), /Add a Grid Rewards home device first/);
  const { homey: h2 } = await setup();
  await assert.rejects(new FlexDeviceDriver({ homey: h2 }).onPairListDevices(), /No car or battery found yet/);
});

test('updates are forwarded to the car: values, translated reason, flows', async () => {
  const { homey, home, flex, sub } = await setup({ flexData: [{ id: 'v1', homeId: 'h1', kind: 'vehicle' }] });
  const [carDevice] = flex;
  sub.emit('data', status([car(false), battery]));
  await home._queue;
  assert.strictEqual(carDevice.getCapabilityValue('grid_reward_state'), 'unavailable');
  assert.strictEqual(carDevice.getCapabilityValue('grid_reward_reason'), 'No car plugged in');
  assert.strictEqual(carDevice.getCapabilityValue('flex_plugged_in'), false);
  assert.strictEqual(carDevice.getCapabilityValue('flex_smart_enabled'), true);
  assert.deepStrictEqual(homey.triggered.find((t) => t.id === 'flex_state_changed').tokens, {
    state: 'unavailable', reason: 'No car plugged in', reason_code: 'noVehiclesPluggedIn',
  });

  // Plug in the car
  sub.emit('data', status([car(true, { __typename: 'GridRewardAvailable', kind: 'available' }), battery]));
  await home._queue;
  assert.strictEqual(carDevice.getCapabilityValue('flex_plugged_in'), true);
  assert.deepStrictEqual(homey.triggered.filter((t) => t.id === 'flex_plugged_in_changed').map((t) => t.tokens), [{ plugged_in: true }]);
});

test('the battery has no plugged-in value', async () => {
  const { home, flex, sub } = await setup({ flexData: [{ id: 'b1', homeId: 'h1', kind: 'battery' }] });
  sub.emit('data', status([car(false), battery]));
  await home._queue;
  assert.strictEqual(flex[0].getCapabilityValue('grid_reward_state'), 'available');
  assert.strictEqual(flex[0].getCapabilityValue('flex_plugged_in'), null);
});

test('a device Tibber no longer reports becomes unavailable', async () => {
  const { home, flex, sub } = await setup({ flexData: [{ id: 'v1', homeId: 'h1', kind: 'vehicle' }] });
  sub.emit('data', status([battery]));
  await home._queue;
  assert.strictEqual(flex[0].available, false);
  assert.match(flex[0].unavailableMessage, /no longer reports/);
});

test('flex device without its home device is unavailable', async () => {
  const homey = makeHomey();
  homey.drivers.registry['grid-reward'] = { getDevices: () => [] };
  const d = new FlexDevice({ homey, data: { id: 'v1', homeId: 'h1', kind: 'vehicle' } });
  await d.onInit();
  assert.strictEqual(d.available, false);
});

test('conditions: plugged in and available', async () => {
  const homey = makeHomey();
  await new FlexDeviceDriver({ homey }).onInit();
  const dev = (caps) => ({ getCapabilityValue: (k) => caps[k] });
  assert.strictEqual(await homey.conditions.flex_plugged_in({ device: dev({ flex_plugged_in: true }) }), true);
  assert.strictEqual(await homey.conditions.flex_available({ device: dev({ grid_reward_state: 'delivering' }) }), true);
  assert.strictEqual(await homey.conditions.flex_available({ device: dev({ grid_reward_state: 'unavailable' }) }), false);
});

test('smart control turned off fires both cards; turned on fires only the change card', async () => {
  const { homey, home, flex, sub } = await setup({ flexData: [{ id: 'v1', homeId: 'h1', kind: 'vehicle' }] });
  const carWith = (smart) => ({ ...car(true, { __typename: 'GridRewardAvailable', kind: 'available' }), isSmartChargingEnabled: smart });
  sub.emit('data', status([carWith(true), battery]));
  await home._queue;
  assert.strictEqual(homey.triggered.filter((t) => t.id.startsWith('flex_smart')).length, 0); // first value: no change yet
  sub.emit('data', status([carWith(false), battery]));
  await home._queue;
  assert.deepStrictEqual(homey.triggered.filter((t) => t.id.startsWith('flex_smart')).map((t) => [t.id, t.tokens]),
    [['flex_smart_changed', { smart_on: false }], ['flex_smart_turned_off', {}]]);
  assert.strictEqual(flex[0].getCapabilityValue('flex_smart_enabled'), false);
  sub.emit('data', status([carWith(true), battery]));
  await home._queue;
  assert.deepStrictEqual(homey.triggered.filter((t) => t.id.startsWith('flex_smart')).slice(2).map((t) => [t.id, t.tokens]),
    [['flex_smart_changed', { smart_on: true }]]);
});

test('condition: smart control is on', async () => {
  const homey = makeHomey();
  await new FlexDeviceDriver({ homey }).onInit();
  assert.strictEqual(await homey.conditions.flex_smart_is_on({ device: { getCapabilityValue: () => true } }), true);
  assert.strictEqual(await homey.conditions.flex_smart_is_on({ device: { getCapabilityValue: () => false } }), false);
});

test('home status change asks the battery to fetch its details soon', async () => {
  const { home, flex, sub } = await setup({ flexData: [{ id: 'b1', homeId: 'h1', kind: 'battery' }] });
  const asked = [];
  flex[0].pollSoon = (why) => asked.push(why);
  sub.emit('data', status([battery]));
  await home._queue;
  sub.emit('data', status([battery])); // same status: no extra fetch
  await home._queue;
  sub.emit('data', { ...status([battery]), state: { __typename: 'GridRewardDelivering', reason: 'excess' } });
  await home._queue;
  // First update: the battery's own status (none → available) and the home's (unknown → available)
  // both ask; pollSoon keeps only one pending fetch. Then the session start asks again.
  assert.deepStrictEqual(asked, ['battery status changed', 'home status changed', 'home status changed']);
});
