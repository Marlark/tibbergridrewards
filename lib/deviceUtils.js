'use strict';

/**
 * Helpers shared by the home device and the car/battery device.
 */

const unavailable = require('./unavailable');
const { unitFor } = require('./currency');

/**
 * Set capability values, but only those that changed. A real day had 1 463 writes
 * of which 365 changed something; every write is a call into Homey.
 * values: { capabilityId: value }. null/undefined and missing capabilities are skipped.
 */
async function setIfChanged(device, values) {
  const writes = Object.entries(values)
    .filter(([cap, v]) => v !== null && v !== undefined
      && device.hasCapability(cap) && device.getCapabilityValue(cap) !== v)
    .map(([cap, v]) => device.setCapabilityValue(cap, v));
  await Promise.all(writes);
  return writes.length;
}

/**
 * Show money capabilities in Tibber's currency. code: 'SEK', 'EUR', ... or an
 * already readable unit ('kr'). Remembered in the store, so it is set only once.
 */
async function applyCurrency(device, capabilities, code) {
  if (!code) return;
  const unit = /^[A-Z]{3}$/.test(code) ? unitFor(code) : code;
  if (unit === device.getStoreValue('currencyUnit')) return;
  for (const cap of capabilities) {
    if (device.hasCapability(cap)) {
      await device.setCapabilityOptions(cap, { units: { en: unit } }).catch(device.error);
    }
  }
  await device.setStoreValue('currencyUnit', unit);
}

/**
 * "Unavailable for X hours" for one device: keeps the period's start in the
 * store (so it survives restarts) and triggers the device's flow card.
 */
class UnavailableWatch {
  constructor(device, cardId) {
    this.device = device;
    this.cardId = cardId;
    this.watch = unavailable.restore(device.getStoreValue('unavailableSince'), Date.now());
  }

  /** reason: { text, code } shown in the card's tokens. */
  async check(gridState, reason) {
    const r = unavailable.step(this.watch, gridState, Date.now());
    if (r.watch.since !== this.watch.since) await this.device.setStoreValue('unavailableSince', r.watch.since);
    this.watch = r.watch;
    if (!r.fire) return;
    await this.device.homey.flow.getDeviceTriggerCard(this.cardId)
      .trigger(this.device, {
        hours: Math.round((r.fire.toMin / 60) * 10) / 10,
        reason: reason.text,
        reason_code: reason.code,
      }, r.fire)
      .catch(this.device.error);
  }
}

/**
 * Tell open dashboard widgets that something changed, so they reload at once
 * instead of polling (they still reload every 5 min in case an event is missed).
 */
const WIDGET_EVENT = 'grid-rewards-changed';
function notifyWidgets(homey) {
  if (!homey.api || typeof homey.api.realtime !== 'function') return;
  Promise.resolve(homey.api.realtime(WIDGET_EVENT, null)).catch(() => {});
}

/**
 * Record raw data only during development: `homey app run` sets DEBUG=1, a
 * published app never does. Turn it off with "RECORD_RAW": "0" in env.json.
 * env: Homey.env (it warns when an unset variable is read, so check the key first).
 */
function isRecording(env) {
  if (process.env.DEBUG !== '1') return false;
  const e = env || {};
  return !Object.keys(e).includes('RECORD_RAW') || e.RECORD_RAW !== '0';
}

module.exports = {
  setIfChanged, applyCurrency, UnavailableWatch, isRecording, notifyWidgets, WIDGET_EVENT,
};
