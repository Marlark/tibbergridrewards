'use strict';

/**
 * Minimal stand-in for the 'homey' module, just enough for device.js and driver.js.
 * Store and capability writes are async (one tick), like on a real Homey,
 * so interleaving bugs show up in tests.
 */

const tick = () => new Promise((r) => setImmediate(r));

function makeHomey({ timeZone = 'Europe/Stockholm' } = {}) {
  const triggered = [];
  const conditions = {};
  const timers = [];
  return {
    triggered,
    conditions,
    timers,
    clock: { getTimezone: () => timeZone },
    __: (key) => key,
    setInterval(fn, ms) { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearInterval(t) { if (t) t.cleared = true; },
    setTimeout(fn, ms) { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout(t) { if (t) t.cleared = true; },
    flow: {
      getDeviceTriggerCard: (id) => ({
        trigger: async (device, tokens) => { await tick(); triggered.push({ id, tokens }); },
      }),
      getConditionCard: (id) => ({
        registerRunListener: (fn) => { conditions[id] = fn; },
      }),
    },
  };
}

class Device {
  constructor({
    homey, data, store = {}, settings = {}, capabilities = {},
  }) {
    this.homey = homey;
    this._data = data;
    this._store = { ...store };
    this._settings = { ...settings };
    this._caps = { ...capabilities };
    this.available = true;
    this.unavailableMessage = null;
    this.logs = [];
    this.errors = [];
    // Arrow functions: the app passes this.error unbound to .catch()
    this.log = (...a) => this.logs.push(a.join(' '));
    this.error = (...a) => this.errors.push(a.map(String).join(' '));
  }

  getData() { return this._data; }

  getStore() { return { ...this._store }; }

  getStoreValue(k) { return this._store[k]; }

  async setStoreValue(k, v) { await tick(); this._store[k] = v; }

  getSetting(k) { return this._settings[k]; }

  getCapabilityValue(k) { return k in this._caps ? this._caps[k] : null; }

  async setCapabilityValue(k, v) { await tick(); this._caps[k] = v; }

  async setAvailable() { this.available = true; }

  async setUnavailable(msg) { this.available = false; this.unavailableMessage = msg; }
}

class Driver {
  constructor({ homey }) {
    this.homey = homey;
    this.log = () => {};
    this.error = () => {};
  }
}

class App {}

module.exports = {
  Device, Driver, App, makeHomey,
};
