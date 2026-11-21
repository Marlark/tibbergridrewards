'use strict';

// The car: plug-in reminder (#74) and check against the charger (#72)

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const {
  minutesOf, reminderDue, mismatchStep, MISMATCH_GRACE_MS,
} = require('../lib/carChecks');
const FlexDevice = require('../drivers/flex-device/device');
const FlexDeviceDriver = require('../drivers/flex-device/driver');

const MIN = 60 * 1000;

test('minutesOf reads HH:MM', () => {
  assert.strictEqual(minutesOf('20:00'), 1200);
  assert.strictEqual(minutesOf('7:30'), 450);
  assert.strictEqual(minutesOf('24:00'), null);
  assert.strictEqual(minutesOf(''), null);
});

test('reminder: once a day, within 30 min after the time, only when unplugged', () => {
  const base = {
    enabled: true, time: '20:00', dayKey: '2026-11-21', minuteOfDay: 1200, lastDay: null, pluggedIn: false,
  };
  assert.strictEqual(reminderDue(base), true);
  assert.strictEqual(reminderDue({ ...base, minuteOfDay: 1199 }), false, 'too early');
  assert.strictEqual(reminderDue({ ...base, minuteOfDay: 1230 }), false, 'too late, e.g. after a restart');
  assert.strictEqual(reminderDue({ ...base, lastDay: '2026-11-21' }), false, 'already reminded today');
  assert.strictEqual(reminderDue({ ...base, pluggedIn: true }), false);
  assert.strictEqual(reminderDue({ ...base, pluggedIn: null }), false, 'unknown: no reminder');
  assert.strictEqual(reminderDue({ ...base, enabled: false }), false);
});

test('mismatch: starts after the grace period, ends once when they agree', () => {
  let r = mismatchStep(null, { chargerPlugged: true, tibberPlugged: false, now: 0 });
  assert.strictEqual(r.started, false);
  r = mismatchStep(r.state, { chargerPlugged: true, tibberPlugged: false, now: MISMATCH_GRACE_MS - 1 });
  assert.strictEqual(r.started, false);
  r = mismatchStep(r.state, { chargerPlugged: true, tibberPlugged: false, now: MISMATCH_GRACE_MS });
  assert.strictEqual(r.started, true);
  r = mismatchStep(r.state, { chargerPlugged: true, tibberPlugged: false, now: MISMATCH_GRACE_MS + MIN });
  assert.strictEqual(r.started, false, 'only once');
  r = mismatchStep(r.state, { chargerPlugged: true, tibberPlugged: true, now: MISMATCH_GRACE_MS + 2 * MIN });
  assert.strictEqual(r.ended, true);
  r = mismatchStep(r.state, { chargerPlugged: true, tibberPlugged: true, now: MISMATCH_GRACE_MS + 3 * MIN });
  assert.strictEqual(r.ended, false);
  // A short disagreement (Tibber is a bit slower than the charger) is no problem.
  r = mismatchStep({}, { chargerPlugged: true, tibberPlugged: false, now: 0 });
  r = mismatchStep(r.state, { chargerPlugged: true, tibberPlugged: true, now: 2 * MIN });
  assert.deepStrictEqual([r.started, r.ended], [false, false]);
});

// --- On the car device ---

async function setup(t, { at = '2026-11-21T19:00:00Z', settings = {} } = {}) {
  let now = Date.parse(at); // 20:00 in Stockholm
  t.mock.method(Date, 'now', () => now);
  const homey = makeHomey();
  const flex = {
    id: 'v1', kind: 'vehicle', gridState: 'unavailable', reasonCodes: ['noVehiclesPluggedIn'], pluggedIn: false, smartEnabled: true,
  };
  const home = {
    getData: () => ({ id: 'h1' }), getFlexDevices: () => [flex], problem: null,
  };
  homey.drivers.registry['grid-reward'] = { getDevices: () => [home] };
  const car = new FlexDevice({
    homey, data: { id: 'v1', homeId: 'h1', kind: 'vehicle' }, settings,
  });
  car.getName = () => 'My car';
  car.getSetting = (k) => settings[k];
  await car.onInit();
  const tick = homey.timers.filter((x) => x.ms === MIN && !x.cleared).pop();
  return {
    homey, car, flex, tick: () => tick.fn(), setNow: (v) => { now = v; }, now: () => now,
  };
}

test('reminder: a notification and a flow at the chosen time, once', async (t) => {
  const { homey, car, tick } = await setup(t, { settings: { reminder_enabled: true, reminder_time: '20:00' } });
  await tick();
  await tick();
  assert.strictEqual(homey.notifications.sent.length, 1);
  assert.match(homey.notifications.sent[0].excerpt, /Plug in My car/);
  assert.strictEqual(homey.triggered.filter((x) => x.id === 'flex_plug_reminder').length, 1);
  await car.onUninit();
});

test('reminder: off by default, and never for a plugged-in car', async (t) => {
  const { homey, car, tick } = await setup(t);
  await tick();
  assert.strictEqual(homey.notifications.sent.length, 0);
  await car.onUninit();
});

test('charger check: the flow card reports, a lasting disagreement warns, agreeing clears it', async (t) => {
  const {
    homey, car, flex, tick, setNow, now,
  } = await setup(t, { at: '2026-11-21T12:00:00Z' });
  const driver = new FlexDeviceDriver({ homey });
  await driver.onInit();
  const report = homey.conditions['action:flex_charger_reported'];
  await report({ device: car, plugged: 'yes' });
  assert.match(car.getSetting('charger_state') || car._settings.charger_state, /Plugged in \(13:00\)/);
  assert.ok(!car.warning, 'no warning straight away');

  setNow(now() + 10 * MIN);
  await tick();
  assert.match(car.warning, /charger says the car is plugged in/);
  assert.strictEqual(homey.triggered.filter((x) => x.id === 'flex_plug_mismatch').length, 1);

  flex.pluggedIn = true;
  await car.onFlexStatus({ ...flex, gridState: 'available', reasonCodes: [] });
  assert.strictEqual(car.warning, null);
  await car.onUninit();
});

test('charger check: a battery ignores the card', async (t) => {
  const { homey } = await setup(t);
  const battery = new FlexDevice({ homey, data: { id: 'b1', homeId: 'h1', kind: 'battery' } });
  battery._pollBattery = async () => {};
  await battery.onInit();
  await battery.onChargerReported(true);
  assert.strictEqual(battery.getStoreValue('charger'), undefined);
  await battery.onUninit();
});
