'use strict';

const Homey = require('homey');
const { reasonText } = require('../../lib/reasons');
const unavailable = require('../../lib/unavailable');
const { unitFor } = require('../../lib/currency');

const SAVINGS_CAPABILITIES = ['battery_savings_today', 'battery_savings_week', 'battery_savings_month'];
const { TibberApiChangedError } = require('../../lib/TibberAppClient');
const { localDayKey } = require('../../lib/RewardTracker');
const {
  POLL_MS, BATTERY_QUERY, batteryVariables, parseBattery, humanize,
} = require('../../lib/battery');

const BATTERY_CAPABILITIES = [
  'battery_savings_today',
  'battery_savings_week',
  'battery_savings_month',
  'battery_activity',
  'battery_next_activity',
];

/**
 * A car or battery. Grid Rewards status comes from its home's device via
 * onFlexStatus(). A battery also polls its details (savings, activity, plan)
 * every 5 minutes, using the home device's login.
 */
class FlexDevice extends Homey.Device {

  async onInit() {
    const { homeId, id, kind } = this.getData();
    this.lastGridState = this.getCapabilityValue('grid_reward_state');
    this.lastPluggedIn = this.hasCapability('flex_plugged_in') ? this.getCapabilityValue('flex_plugged_in') : null;
    this.lastActivityCode = null;
    this.lastReason = { text: '', code: '' };
    // "Unavailable for X hours", e.g. the car has not been plugged in.
    this.unavail = unavailable.restore(this.getStoreValue('unavailableSince'), Date.now());
    this.unavailTimer = this.homey.setInterval(
      () => this._checkUnavailable(this.lastGridState).catch(this.error), 60 * 1000,
    );

    if (kind === 'battery') {
      // Batteries paired with an older version lack the battery capabilities.
      for (const cap of BATTERY_CAPABILITIES) {
        if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
      }
      this.batteryTimer = this.homey.setInterval(() => this._pollBattery().catch(this.error), POLL_MS);
      // First poll shortly after start, when the home device has logged in.
      this.batteryKick = this.homey.setTimeout(() => this._pollBattery().catch(this.error), 15 * 1000);
    }

    // Show the latest known values right away instead of waiting for the next update.
    const home = this._home();
    if (!home) {
      await this.setUnavailable(this.homey.__('error.no_home_device')).catch(this.error);
      return;
    }
    const f = home.getFlexDevices().find((x) => x.id === id);
    if (f) await this.onFlexStatus(f, { silent: true });
    this.homeId = homeId;
  }

  _home() {
    const { homeId } = this.getData();
    try {
      return this.homey.drivers.getDriver('grid-reward').getDevices()
        .find((d) => d.getData().id === homeId) || null;
    } catch (err) {
      return null; // driver not ready
    }
  }

  /**
   * f: parsed flex device (RewardTracker.parseFlex) or null when Tibber no longer
   * reports it. silent: update values without triggering flows (used at start-up).
   */
  async onFlexStatus(f, { silent = false } = {}) {
    if (!f) {
      await this.setUnavailable(this.homey.__('error.flex_missing'));
      return;
    }
    if (!this.getAvailable()) await this.setAvailable();

    const text = reasonText(this.homey, f.reasonCodes);
    const code = f.reasonCodes.join(', ');
    const sets = [
      this.setCapabilityValue('grid_reward_state', f.gridState),
      this.setCapabilityValue('grid_reward_reason', text || '-'),
    ];
    if (f.smartEnabled !== null && this.hasCapability('flex_smart_enabled')) {
      sets.push(this.setCapabilityValue('flex_smart_enabled', f.smartEnabled));
    }
    if (f.pluggedIn !== null && this.hasCapability('flex_plugged_in')) {
      sets.push(this.setCapabilityValue('flex_plugged_in', f.pluggedIn));
    }
    await Promise.all(sets);

    this.lastReason = { text, code };
    const stateChanged = f.gridState !== this.lastGridState;
    const plugChanged = f.pluggedIn !== null && this.lastPluggedIn !== null && f.pluggedIn !== this.lastPluggedIn;
    this.lastGridState = f.gridState;
    if (f.pluggedIn !== null) this.lastPluggedIn = f.pluggedIn;
    if (silent) return;

    if (stateChanged) {
      await this.homey.flow.getDeviceTriggerCard('flex_state_changed')
        .trigger(this, { state: f.gridState, reason: text, reason_code: code })
        .catch(this.error);
    }
    if (plugChanged) {
      await this.homey.flow.getDeviceTriggerCard('flex_plugged_in_changed')
        .trigger(this, { plugged_in: f.pluggedIn })
        .catch(this.error);
    }
    await this._checkUnavailable(f.gridState);
  }

  async _checkUnavailable(gridState) {
    const r = unavailable.step(this.unavail, gridState, Date.now());
    if (r.watch.since !== this.unavail.since) await this.setStoreValue('unavailableSince', r.watch.since);
    this.unavail = r.watch;
    if (!r.fire) return;
    await this.homey.flow.getDeviceTriggerCard('flex_unavailable_for')
      .trigger(this, {
        hours: Math.round((r.fire.toMin / 60) * 10) / 10,
        reason: this.lastReason.text,
        reason_code: this.lastReason.code,
      }, r.fire)
      .catch(this.error);
  }

  // --- Battery details ---

  async _pollBattery() {
    const home = this._home();
    // No home device, or it can't log in / the API changed: it already says so.
    if (!home || !home.client || home.problem) return;
    const { homeId, id } = this.getData();

    let parsed;
    try {
      const data = await home.client.query(BATTERY_QUERY, batteryVariables({ homeId, batteryId: id, now: Date.now() }));
      parsed = parseBattery(data);
    } catch (err) {
      this.error('Battery details:', err.message);
      const msg = err instanceof TibberApiChangedError ? 'error.api_changed' : 'error.battery_failed';
      await this.setWarning(this.homey.__(msg)).catch(this.error);
      return;
    }
    if (!parsed) {
      await this.setWarning(this.homey.__('error.battery_failed')).catch(this.error);
      return;
    }
    await this.unsetWarning().catch(this.error);
    await this._applyUnit(parsed.unit);

    const activityText = parsed.activity ? this._activityText(parsed.activity.code) : '-';
    const values = {
      battery_savings_today: parsed.savingsToday,
      battery_savings_week: parsed.savingsWeek,
      battery_savings_month: parsed.savingsMonth,
      battery_activity: activityText,
      battery_next_activity: this._nextText(parsed.nextPlanned),
    };
    await Promise.all(Object.entries(values)
      .filter(([cap, v]) => v !== null && this.hasCapability(cap))
      .map(([cap, v]) => this.setCapabilityValue(cap, v)));

    const code = parsed.activity ? parsed.activity.code : '';
    if (this.lastActivityCode !== null && code !== this.lastActivityCode) {
      await this.homey.flow.getDeviceTriggerCard('battery_activity_changed')
        .trigger(this, { activity: activityText, activity_code: code })
        .catch(this.error);
    }
    this.lastActivityCode = code;
  }

  /** Savings unit from Tibber: an ISO code (SEK, EUR) becomes kr / €, anything else is used as is. */
  async _applyUnit(raw) {
    if (!raw) return;
    const unit = /^[A-Z]{3}$/.test(raw) ? unitFor(raw) : raw;
    if (unit === this.getStoreValue('currencyUnit')) return;
    for (const cap of SAVINGS_CAPABILITIES) {
      if (this.hasCapability(cap)) await this.setCapabilityOptions(cap, { units: { en: unit } }).catch(this.error);
    }
    await this.setStoreValue('currencyUnit', unit);
  }

  /** Translated activity, or a readable version of an unknown code. */
  _activityText(code) {
    if (!code) return '-';
    const key = `battery_activity.${code}`;
    const t = this.homey.__(key);
    if (t && t !== key) return t;
    this.log(`Unknown battery activity "${code}" – add it to locales/*.json under battery_activity`);
    return humanize(code);
  }

  _nextText(next) {
    if (!next) return this.homey.__('battery.none');
    const tz = this.homey.clock.getTimezone();
    const when = new Date(next.time);
    const lang = this.homey.i18n.getLanguage() === 'sv' ? 'sv-SE' : 'en-GB';
    const time = new Intl.DateTimeFormat(lang, { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(when);
    const tomorrow = localDayKey(when, tz) !== localDayKey(new Date(), tz);
    const power = (next.powerW / 1000).toLocaleString(lang, { maximumFractionDigits: 1 });
    return this.homey.__(tomorrow ? 'battery.next_tomorrow' : 'battery.next', {
      action: this.homey.__(`battery.${next.action}`), time, power,
    });
  }

  async onUninit() {
    if (this.unavailTimer) this.homey.clearInterval(this.unavailTimer);
    if (this.batteryTimer) this.homey.clearInterval(this.batteryTimer);
    if (this.batteryKick) this.homey.clearTimeout(this.batteryKick);
  }

  async onDeleted() {
    await this.onUninit();
  }

}

module.exports = FlexDevice;
