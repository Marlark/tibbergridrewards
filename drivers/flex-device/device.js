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

// Tibber's battery service has short outages ("Circuit breaker open"). Only show a
// warning after this many failed polls in a row (5 min apart, so about 15 min).
const BATTERY_WARN_AFTER = 3;

// When Grid Rewards status changes, fetch battery details soon instead of waiting
// up to 5 min: after POLL_SOON_DELAY_MS (Tibber needs a moment to update the
// activity), and never more often than POLL_SOON_MIN_GAP_MS.
const POLL_SOON_DELAY_MS = 10 * 1000;
const POLL_SOON_MIN_GAP_MS = 60 * 1000;

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
    this.lastSmart = this.hasCapability('flex_smart_enabled') ? this.getCapabilityValue('flex_smart_enabled') : null;
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
    // Grid Rewards needs smart charging / smart mode: tell the user when it changes.
    const smartChanged = f.smartEnabled !== null && this.lastSmart !== null && f.smartEnabled !== this.lastSmart;
    this.lastGridState = f.gridState;
    if (f.pluggedIn !== null) this.lastPluggedIn = f.pluggedIn;
    if (f.smartEnabled !== null) this.lastSmart = f.smartEnabled;
    if (silent) return;

    if (stateChanged) {
      this.pollSoon('battery status changed');
      await this.homey.flow.getDeviceTriggerCard('flex_state_changed')
        .trigger(this, { state: f.gridState, reason: text, reason_code: code })
        .catch(this.error);
    }
    if (plugChanged) {
      await this.homey.flow.getDeviceTriggerCard('flex_plugged_in_changed')
        .trigger(this, { plugged_in: f.pluggedIn })
        .catch(this.error);
    }
    if (smartChanged) {
      await this.homey.flow.getDeviceTriggerCard('flex_smart_changed')
        .trigger(this, { smart_on: f.smartEnabled })
        .catch(this.error);
      if (!f.smartEnabled) {
        await this.homey.flow.getDeviceTriggerCard('flex_smart_turned_off').trigger(this, {}).catch(this.error);
      }
    }
    await this._checkUnavailable(f.gridState);
  }

  async _checkUnavailable(gridState) {
    await this.unavailWatch.check(gridState, this.lastReason);
  }

  // --- Battery details ---

  /** Fetch battery details soon (battery only). Called when a Grid Rewards status changes. */
  pollSoon(why) {
    if (this.getData().kind !== 'battery' || this.pollSoonTimer) return;
    const sinceLast = Date.now() - (this.lastPollAt || 0);
    const delay = Math.max(POLL_SOON_DELAY_MS, POLL_SOON_MIN_GAP_MS - sinceLast);
    this.log(`Fetching battery details in ${Math.round(delay / 1000)} s (${why})`);
    this.pollSoonTimer = this.homey.setTimeout(() => {
      this.pollSoonTimer = null;
      this._pollBattery().catch(this.error);
    }, delay);
  }

  async _pollBattery() {
    const home = this._home();
    // No home device, or it can't log in / the API changed: it already says so.
    if (!home || !home.client || home.problem) return;
    // A regular poll and a "soon" poll must not run at the same time.
    if (this.polling) return;
    this.polling = true;
    this.lastPollAt = Date.now();
    try {
      await this._pollBatteryNow(home);
    } finally {
      this.polling = false;
    }
  }

  async _pollBatteryNow(home) {
    const { homeId, id } = this.getData();

    let parsed = null;
    let failure = null;
    try {
      const data = await home.client.query(BATTERY_QUERY, batteryVariables({ homeId, batteryId: id, now: Date.now() }));
      parsed = parseBattery(data);
      if (!parsed) failure = new Error('No battery data in the response');
    } catch (err) {
      failure = err;
    }
    if (failure) {
      await this._batteryFailed(failure);
      return;
    }
    if (this.batteryFailures || this.batteryWarning) {
      this.log(`Battery details OK again after ${this.batteryFailures} failed poll(s)`);
      await this.unsetWarning().catch(this.error);
    }
    this.batteryFailures = 0;
    this.batteryWarning = false;
    this.plan = parsed.plan;
    this.planAt = Date.now();
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

  /** The latest planned charge level (#15), for the settings page. */
  getPlan() {
    return { points: this.plan || [], updatedAt: this.planAt || null };
  }

  /**
   * A failed poll keeps the last values. A changed API is shown at once (it will not
   * fix itself); other errors only after BATTERY_WARN_AFTER failures in a row.
   */
  async _batteryFailed(err) {
    this.batteryFailures = (this.batteryFailures || 0) + 1;
    const apiChanged = err instanceof TibberApiChangedError;
    const warn = apiChanged || this.batteryFailures >= BATTERY_WARN_AFTER;
    this.log(`Battery details failed (${this.batteryFailures} in a row): ${err.message}`);
    if (!warn || this.batteryWarning) return;
    this.batteryWarning = true;
    this.error('Battery details:', err.message);
    await this.setWarning(this.homey.__(apiChanged ? 'error.api_changed' : 'error.battery_failed')).catch(this.error);
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
    if (this.pollSoonTimer) this.homey.clearTimeout(this.pollSoonTimer);
  }

  async onDeleted() {
    await this.onUninit();
  }

}

module.exports = FlexDevice;
