'use strict';

const Homey = require('homey');
const { reasonText } = require('../../lib/reasons');
const { localeFor } = require('../../lib/i18n');
const { setIfChanged, applyCurrency, UnavailableWatch } = require('../../lib/deviceUtils');
const { TibberApiChangedError } = require('../../lib/TibberAppClient');
const { localDayKey } = require('../../lib/RewardTracker');
const {
  POLL_MS, BATTERY_QUERY, batteryVariables, parseBattery, humanize,
} = require('../../lib/battery');

const SAVINGS_CAPABILITIES = ['battery_savings_today', 'battery_savings_week', 'battery_savings_month'];

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
    this.unavailWatch = new UnavailableWatch(this, 'flex_unavailable_for');
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
    // Car/battery data changed in only 24 of 209 updates on a real day.
    await setIfChanged(this, {
      grid_reward_state: f.gridState,
      grid_reward_reason: text || '-',
      flex_smart_enabled: f.smartEnabled,
      flex_plugged_in: f.pluggedIn,
    });

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
    await this.unavailWatch.check(gridState, this.lastReason);
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
    await applyCurrency(this, SAVINGS_CAPABILITIES, parsed.unit);

    const activityText = parsed.activity ? this._activityText(parsed.activity.code) : '-';
    await setIfChanged(this, {
      battery_savings_today: parsed.savingsToday,
      battery_savings_week: parsed.savingsWeek,
      battery_savings_month: parsed.savingsMonth,
      battery_activity: activityText,
      battery_next_activity: this._nextText(parsed.nextPlanned),
    });

    const code = parsed.activity ? parsed.activity.code : '';
    if (this.lastActivityCode !== null && code !== this.lastActivityCode) {
      await this.homey.flow.getDeviceTriggerCard('battery_activity_changed')
        .trigger(this, { activity: activityText, activity_code: code })
        .catch(this.error);
    }
    this.lastActivityCode = code;
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
    const lang = localeFor(this.homey.i18n.getLanguage());
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
