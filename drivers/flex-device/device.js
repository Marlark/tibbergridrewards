'use strict';

const Homey = require('homey');
const { reasonText } = require('../../lib/reasons');
const { localeFor, dateFormat } = require('../../lib/i18n');
const {
  setIfChanged, applyCurrency, UnavailableWatch, isRecording, notifyWidgets,
} = require('../../lib/deviceUtils');
const { dayStats, startOfLocalDay } = require('../../lib/batteryDay');
const { TibberApiChangedError } = require('../../lib/TibberAppClient');
const { localDayKey } = require('../../lib/RewardTracker');
const { homeById } = require('../../lib/devices');
const { AvailabilityWatch } = require('../../lib/availability');
const { reminderDue, mismatchStep } = require('../../lib/carChecks');
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

// What this car/battery earned: its share of the home's sessions (lib/flexEarnings.js).
const EARNED_CAPABILITIES = ['flex_reward_today', 'flex_reward_month', 'flex_reward_total'];
// Added to cars/batteries paired with an older version.
const NEW_CAPABILITIES = [
  ...EARNED_CAPABILITIES,
  'flex_reward_share',
  'grid_reward_sessions_today',
  'grid_reward_minutes_today',
  'grid_reward_sessions_month',
  'grid_reward_availability',
];

const BATTERY_CAPABILITIES = [
  'battery_savings_today',
  'battery_savings_week',
  'battery_savings_month',
  'battery_activity',
  'battery_next_activity',
  'battery_hours_grid_rewards',
  'battery_hours_price',
  'battery_hours_solar',
  'battery_charged_today',
  'battery_discharged_today',
];

const BATTERY_DAYS_MAX = 400; // a bit more than a year

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
    this.availability = new AvailabilityWatch(this);
    this.unavailTimer = this.homey.setInterval(() => this._minuteTick().catch(this.error), 60 * 1000);

    // Cars/batteries paired with an older version lack the "earned" capabilities.
    for (const cap of NEW_CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

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
    if (home.getFlexEarnings) {
      await this.onEarnings(home.getFlexEarnings(id), home.getCurrencyUnit ? home.getCurrencyUnit() : '');
    }
    this.homeId = homeId;
  }

  _home() {
    return homeById(this.homey, this.getData().homeId);
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
    await this.availability.update(f.gridState, this._dayKey());
    const stateChanged = f.gridState !== this.lastGridState;
    const plugChanged = f.pluggedIn !== null && this.lastPluggedIn !== null && f.pluggedIn !== this.lastPluggedIn;
    // Grid Rewards needs smart charging / smart mode: tell the user when it changes.
    const smartChanged = f.smartEnabled !== null && this.lastSmart !== null && f.smartEnabled !== this.lastSmart;
    this.lastGridState = f.gridState;
    if (f.pluggedIn !== null) this.lastPluggedIn = f.pluggedIn;
    if (f.smartEnabled !== null) this.lastSmart = f.smartEnabled;
    if (silent) return;
    if (plugChanged) await this._carChecks();

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

  /** Earned, sessions and share, from the home device (lib/flexEarnings.js earningsOf). */
  async onEarnings(e, unit) {
    await applyCurrency(this, EARNED_CAPABILITIES, unit);
    await setIfChanged(this, {
      flex_reward_today: e.today,
      flex_reward_month: e.month,
      flex_reward_total: e.total,
      flex_reward_share: e.share,
      grid_reward_sessions_today: e.sessionsToday,
      grid_reward_minutes_today: e.minutesToday,
      grid_reward_sessions_month: e.sessionsMonth,
    });
  }

  /** A session this device delivered in has been settled; reward is its share. */
  async onSessionEnded({ reward, minutes, earnedToday }) {
    await this.homey.flow.getDeviceTriggerCard('flex_session_ended')
      .trigger(this, { reward, minutes, earned_today: earnedToday })
      .catch(this.error);
  }

  async _minuteTick() {
    await this._checkUnavailable(this.lastGridState);
    await this.availability.update(this.lastGridState, this._dayKey());
    await this._carChecks();
  }

  // --- Car: plug-in reminder (#74) and check against the charger (#72) ---

  /** From the flow card "The charger says the car is …". */
  async onChargerReported(plugged) {
    if (this.getData().kind !== 'vehicle') return;
    const at = Date.now();
    await this.setStoreValue('charger', { plugged, at });
    const time = dateFormat(localeFor(this.homey.i18n.getLanguage()), {
      timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit',
    }).format(new Date(at));
    await this.setSettings({ charger_state: this.homey.__(plugged ? 'car.plugged' : 'car.unplugged', { time }) })
      .catch(this.error);
    await this._carChecks();
  }

  /** Minutes since local midnight. */
  _minuteOfDay() {
    const parts = Object.fromEntries(dateFormat('en-GB', {
      timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(Date.now())).map((p) => [p.type, p.value]));
    return Number(parts.hour) * 60 + Number(parts.minute);
  }

  async _carChecks() {
    if (this.getData().kind !== 'vehicle') return;
    const dayKey = this._dayKey();
    if (reminderDue({
      enabled: this.getSetting('reminder_enabled'),
      time: this.getSetting('reminder_time'),
      dayKey,
      minuteOfDay: this._minuteOfDay(),
      lastDay: this.getStoreValue('reminderDay'),
      pluggedIn: this.lastPluggedIn,
    })) {
      await this.setStoreValue('reminderDay', dayKey);
      this.log('Plug-in reminder: the car is not plugged in');
      await this.homey.notifications.createNotification({ excerpt: this.homey.__('car.notify', { name: this.getName() }) })
        .catch(this.error);
      await this.homey.flow.getDeviceTriggerCard('flex_plug_reminder').trigger(this, {}).catch(this.error);
    }

    const charger = this.getStoreValue('charger');
    const r = mismatchStep(this.mismatch, {
      chargerPlugged: charger ? charger.plugged : null, tibberPlugged: this.lastPluggedIn, now: Date.now(),
    });
    this.mismatch = r.state;
    if (r.started) {
      this.log('The charger says plugged in, but Tibber sees no car');
      await this.setWarning(this.homey.__('car.warn')).catch(this.error);
      await this.homey.flow.getDeviceTriggerCard('flex_plug_mismatch').trigger(this, {}).catch(this.error);
    } else if (r.ended) {
      this.log('The charger and Tibber agree again');
      await this.unsetWarning().catch(this.error);
    }
  }

  _dayKey() {
    return localDayKey(new Date(), this.homey.clock.getTimezone());
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
    const now = Date.now();
    const dayStart = startOfLocalDay(now, this.homey.clock.getTimezone());
    try {
      const data = await home.client.query(BATTERY_QUERY, batteryVariables({
        homeId, batteryId: id, now, dayStart,
      }));
      if (isRecording(Homey.env)) {
        // To check units and new activity codes against a real battery (tools/extract-recording.js).
        this.log('[REC-BATTERY]', JSON.stringify({ t: now, tz: this.homey.clock.getTimezone(), data }));
      }
      parsed = parseBattery(data, { now });
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

    await this._updateBatteryDay(parsed, { now, dayStart });
    notifyWidgets(this.homey);

    const code = parsed.activity ? parsed.activity.code : '';
    if (this.lastActivityCode !== null && code !== this.lastActivityCode) {
      await this.homey.flow.getDeviceTriggerCard('battery_activity_changed')
        .trigger(this, { activity: activityText, activity_code: code })
        .catch(this.error);
    }
    this.lastActivityCode = code;
  }

  // --- The battery's day (#29, #48) ---

  _batteryDaysKey() {
    const { homeId, id } = this.getData();
    return `batterydays:${homeId}:${id}`;
  }

  /** Finished days { date, hours, kwh, savings }, newest first, and today so far. */
  getBatteryDays() {
    const today = this.getStoreValue('batteryDay');
    const done = this.homey.settings.get(this._batteryDaysKey()) || [];
    return { today: today || null, days: done };
  }

  async _updateBatteryDay(parsed, { now, dayStart }) {
    const tz = this.homey.clock.getTimezone();
    const dayKey = localDayKey(new Date(dayStart + 12 * 3600 * 1000), tz);
    const dayEnd = startOfLocalDay(dayStart + 26 * 3600 * 1000, tz);
    const stats = dayStats({
      intervals: parsed.intervals, flow: parsed.actual, dayStart, dayEnd, now,
    });
    const today = {
      date: dayKey, hours: stats.hours, kwh: stats.kwh, savings: parsed.savingsToday,
    };

    // A new day: the last figures of the previous one are final.
    const prev = this.getStoreValue('batteryDay');
    if (prev && prev.date && prev.date !== dayKey) await this._finishBatteryDay(prev);
    if (JSON.stringify(prev) !== JSON.stringify(today)) await this.setStoreValue('batteryDay', today);

    await setIfChanged(this, {
      battery_hours_grid_rewards: stats.hours.gridRewards,
      battery_hours_price: stats.hours.price,
      battery_hours_solar: stats.hours.solar,
      battery_charged_today: stats.kwh.charged,
      battery_discharged_today: stats.kwh.discharged,
    });
  }

  async _finishBatteryDay(day) {
    const key = this._batteryDaysKey();
    const rest = (this.homey.settings.get(key) || []).filter((d) => d.date !== day.date);
    this.homey.settings.set(key, [day, ...rest].slice(0, BATTERY_DAYS_MAX));
    await this.homey.flow.getDeviceTriggerCard('battery_daily_summary').trigger(this, {
      date: day.date,
      hours_grid_rewards: day.hours.gridRewards,
      hours_price: day.hours.price,
      hours_solar: day.hours.solar,
      charged_kwh: day.kwh.charged,
      discharged_kwh: day.kwh.discharged,
      savings: typeof day.savings === 'number' ? day.savings : 0,
    }).catch(this.error);
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
    const time = dateFormat(lang, { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(when);
    const tomorrow = localDayKey(when, tz) !== localDayKey(new Date(), tz);
    const power = (next.powerW / 1000).toLocaleString(lang, { maximumFractionDigits: 1 });
    return this.homey.__(tomorrow ? 'battery.next_tomorrow' : 'battery.next', {
      action: this.homey.__(`battery.${next.action}`), time, power,
    });
  }

  async onUninit() {
    if (this.availability) await this.availability.save();
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
