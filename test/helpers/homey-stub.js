'use strict';

/**
 * Minimal stand-in for the 'homey' module, just enough for device.js and driver.js.
 * Store and capability writes are async (one tick), like on a real Homey,
 * so interleaving bugs show up in tests.
 */

const path = require('path');

const tick = () => new Promise((r) => setImmediate(r));

// Like Homey: translate from locales/en.json, return the key when missing.
const EN = require(path.join(__dirname, '..', '..', 'locales', 'en.json'));
function translate(key, tokens = {}) {
  const v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), EN);
  if (typeof v !== 'string') return key;
  return v.replace(/__(\w+)__/g, (m, name) => (name in tokens ? String(tokens[name]) : m));
}

function makeHomey({ timeZone = 'Europe/Stockholm' } = {}) {
  const triggered = [];
  const conditions = {};
  const timers = [];
  const notifications = [];
  const drivers = {}; // id -> { getDevices() }
  const triggerListeners = {};
  return {
    triggered,
    conditions,
    timers,
    notifications: {
      sent: notifications,
      createNotification: async (n) => { notifications.push(n); },
    },
    drivers: {
      registry: drivers,
      getDriver: (id) => {
        if (!drivers[id]) throw new Error(`Driver not found: ${id}`);
        return drivers[id];
      },
    },
    // Like homey.settings: app-wide, survives removing a device.
    settings: {
      values: {},
      get(key) { return key in this.values ? this.values[key] : null; },
      set(key, value) { this.values[key] = value; },
    },
    clock: { getTimezone: () => timeZone },
    // homey.api.realtime: events for the dashboard widgets
    api: {
      events: [],
      realtime(event, data) { this.events.push({ event, data }); },
    },
    i18n: { getLanguage: () => 'en' },
    __: translate,
    setInterval(fn, ms) { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearInterval(t) { if (t) t.cleared = true; },
    setTimeout(fn, ms) { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout(t) { if (t) t.cleared = true; },
    triggerListeners,
    flow: {
      // Like Homey: a trigger with a run listener only fires when the listener says so.
      getDeviceTriggerCard: (id) => ({
        registerRunListener: (fn) => { triggerListeners[id] = fn; },
        trigger: async (device, tokens, state) => {
          await tick();
          triggered.push({
            id, tokens, ...(state !== undefined ? { state } : {}), device,
          });
        },
      }),
      getConditionCard: (id) => ({
        registerRunListener: (fn) => { conditions[id] = fn; },
      }),
      getActionCard: (id) => ({
        registerRunListener: (fn) => { conditions[`action:${id}`] = fn; },
      }),
    },
  };
}

class Device {
  constructor({
    homey, data, store = {}, settings = {}, capabilities = {}, capabilityList = null,
  }) {
    this._capList = capabilityList;
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

  async setSettings(obj) { Object.assign(this._settings, obj); }

  getCapabilityValue(k) { return k in this._caps ? this._caps[k] : null; }

  async setCapabilityValue(k, v) { await tick(); this._caps[k] = v; }

  hasCapability(k) {
    if (this._removed && this._removed.has(k)) return false;
    return !this._capList || this._capList.includes(k);
  }

  async setCapabilityOptions(k, o) { this.capabilityOptions = { ...this.capabilityOptions, [k]: o }; }

  async addCapability(k) {
    if (this._removed) this._removed.delete(k);
    if (this._capList && !this._capList.includes(k)) this._capList.push(k);
  }

  async removeCapability(k) {
    if (this._capList) this._capList = this._capList.filter((c) => c !== k);
    else this._removed = new Set([...(this._removed || []), k]);
    delete this._caps[k];
  }

  async setWarning(msg) { this.warning = msg; }

  async unsetWarning() { this.warning = null; }

  getAvailable() { return this.available; }

  async setAvailable() { this.available = true; }

  async setUnavailable(msg) { this.available = false; this.unavailableMessage = msg; }
}

class Driver {
  constructor({ homey, devices = [] }) {
    this.homey = homey;
    this._devices = devices;
    this.log = () => {};
    this.error = () => {};
  }

  getDevices() { return this._devices; }
}

class App {}

// Like Homey.env: the contents of env.json. Tests may change it.
const env = {};

module.exports = {
  Device, Driver, App, makeHomey, env,
};
