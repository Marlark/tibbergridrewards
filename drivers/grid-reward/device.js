'use strict';

const Homey = require('homey');
const { TibberAuthError, TibberApiChangedError } = require('../../lib/TibberAppClient');
const ConnectionPool = require('../../lib/ConnectionPool');
const HomeStore = require('../../lib/HomeStore');
const { flexDevicesOf } = require('../../lib/devices');
const {
  parseStatus, parseFlex, applyUpdate, settle, rollDayEvents, statsOf, localDayKey, SETTLE_MS,
} = require('../../lib/RewardTracker');
const { reasonText } = require('../../lib/reasons');
const { localeFor, dateFormat } = require('../../lib/i18n');
const {
  setIfChanged, applyCurrency, UnavailableWatch, isRecording, notifyWidgets,
} = require('../../lib/deviceUtils');
const { AvailabilityWatch } = require('../../lib/availability');
const reasonStats = require('../../lib/reasonStats');

// Capabilities shown in money; their unit follows Tibber's rewardCurrency.
const MONEY_CAPABILITIES = [
  'grid_reward_session',
  'grid_reward_session_estimate',
  'grid_reward_yesterday',
  'grid_reward_today',
  'grid_reward_month',
  'grid_reward_all_time',
  'grid_reward_last_session',
];

const CONNECTION_SETTINGS_MS = 60 * 1000; // refresh "last update" in settings at most once a minute
const ESTIMATE_EVERY_MS = 5 * 60 * 1000; // between updates from Tibber (fewer Insights writes)

// Added to home devices paired with an older version.
const STATS_CAPABILITIES = [
  'grid_reward_last_session',
  'grid_reward_sessions_today',
  'grid_reward_minutes_today',
  'grid_reward_sessions_month',
  'grid_reward_availability',
  'grid_reward_yesterday',
  'grid_reward_session_estimate',
];

// "Updated" as a value on the device is optional (setting show_updated): it is
// written on every update from Tibber, about 150 times a day. The widget and the
// connection status show the time anyway, without any writes.
const UPDATED_CAPABILITY = 'grid_reward_updated';

/**
 * A Tibber home. Receives Grid Rewards status over the account's shared
 * WebSocket, keeps today/session/month figures (lib/RewardTracker.js), fires the
 * flow cards and forwards car/battery status to their devices. What is kept in
 * the app settings (history, daily totals, records, …) is in lib/HomeStore.js.
 */
class GridRewardDevice extends Homey.Device {

  async onInit() {
    this.homeId = this.getData().id;
    this.store = new HomeStore({
      settings: this.homey.settings, homeId: this.homeId, monthOf: (ms) => this._monthOf(ms),
    });
    // Older versions kept the history in the device store.
    this.store.init({ oldHistory: this.getStoreValue('history') });
    if (Array.isArray(this.getStoreValue('history'))) await this.setStoreValue('history', null);

    this.tracker = this.getStoreValue('tracker') || {};
    this.lastGridState = this.getCapabilityValue('grid_reward_state') || 'unknown';
    // 'auth' | 'api' | null: why the device is unavailable, if it is.
    this.problem = null;
    this.lastReason = { text: '', code: '' };
    // Highest value so far today / this month, for the threshold cards. Comparing
    // with the highest value means a small dip and rise does not fire twice.
    // null = not known yet (never fire on the first value).
    this.high = {
      today: this.getCapabilityValue('grid_reward_today'),
      todayKey: this.tracker.dayKey,
      month: this.getCapabilityValue('grid_reward_month'),
      monthKey: this.tracker.monthKey,
    };
    // "Unavailable for X hours"; the start time survives restarts.
    this.unavailWatch = new UnavailableWatch(this, 'unavailable_for');
    // Last saved tracker, to skip store writes when nothing changed (about half of all updates).
    this._savedTracker = JSON.stringify(this.tracker);
    // Connection status shown in the device settings.
    this.conn = {
      state: 'connecting', since: null, lastUpdate: null, reconnects: 0, shownAt: 0,
    };
    // All work that touches tracker/capabilities/flows runs one job at a time,
    // so quick successive updates can't interleave (e.g. double state_changed).
    this._queue = Promise.resolve();

    for (const cap of STATS_CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

    await this._applyShowUpdated(this.getSetting('show_updated') === true);

    this.availability = new AvailabilityWatch(this);
    await this._initYesterday();

    this._startSubscription();

    // Roll the day over at midnight even if Tibber sends nothing.
    this.dayTimer = this.homey.setInterval(() => this._enqueue(() => this._tickDay()), 60 * 1000);

    // A session may have ended just before a restart and still await settlement.
    this._scheduleSettle();
  }

  _enqueue(job) {
    this._queue = this._queue.then(job).catch((err) => this.error(err));
    return this._queue;
  }

  // --- Connection ---

  /**
   * Join the Tibber account's shared login and WebSocket (one per account, see
   * ConnectionPool). Connection events are account-wide; data is only for our home.
   */
  _startSubscription() {
    const { email, password } = this.getStore();
    this.account = ConnectionPool.for(this.homey).acquire({
      email, password, homeId: this.homeId, log: this.log.bind(this),
    });
    this.client = this.account.client;
    const sub = this.account.sub;
    this._subHandlers = {
      data: (status, homeId) => {
        if ((homeId || (status && status.homeId)) !== this.homeId) return; // another home on the account
        this._enqueue(() => this._onStatus(status));
      },
      connected: () => {
        // A successful login fixes an auth problem. An API problem is only
        // fixed when real data arrives again (see _onStatus).
        if (this.problem === 'auth') this._clearProblem();
        this._setConnection('connected');
      },
      disconnected: () => {
        this.conn.reconnects += 1;
        this._setConnection('reconnecting');
      },
      error: (err) => {
        this.error('Subscription:', err.message);
        if (err instanceof TibberAuthError) {
          this._setProblem('auth');
          this._setConnection('auth');
        } else if (err instanceof TibberApiChangedError) {
          this._setProblem('api');
          this._setConnection('api');
        }
      },
    };
    for (const [event, fn] of Object.entries(this._subHandlers)) sub.on(event, fn);
    this.sub = sub;
    // Joined a connection that another home already opened.
    if (sub.connected) this._setConnection('connected');
  }

  _stopSubscription() {
    if (!this.sub) return;
    for (const [event, fn] of Object.entries(this._subHandlers || {})) this.sub.off(event, fn);
    ConnectionPool.for(this.homey).release(this.account.key, this.homeId);
    this.sub = null;
  }

  _setProblem(kind) {
    const first = this.problem !== kind;
    this.problem = kind;
    this.setUnavailable(this.homey.__(kind === 'auth' ? 'error.auth' : 'error.api_changed')).catch(this.error);
    // Tell the user once per episode, not on every hourly retry.
    if (kind === 'api' && first) {
      this.homey.notifications.createNotification({ excerpt: this.homey.__('notification.api_changed') })
        .catch(this.error);
    }
  }

  _clearProblem() {
    this.problem = null;
    this.setAvailable().catch(this.error);
  }

  /** Called from the driver's repair flow with verified credentials. */
  async updateCredentials({ email, password }) {
    await this.setStoreValue('email', email);
    await this.setStoreValue('password', password);
    this._stopSubscription();
    this._startSubscription();
  }

  // --- Time ---

  _dayKey() {
    return localDayKey(new Date(), this.homey.clock.getTimezone());
  }

  _monthOf(ms) {
    return localDayKey(new Date(ms), this.homey.clock.getTimezone()).slice(0, 7);
  }

  // --- Updates ---

  async _tickDay() {
    await this._checkUnavailable(this.lastGridState);
    await this.availability.update(this.lastGridState, this._dayKey());
    if (Date.now() - (this.estimateAt || 0) >= ESTIMATE_EVERY_MS) await this._updateEstimate();
    const key = this._dayKey();
    if (this.tracker.dayKey === key) return;
    const result = rollDayEvents(this.tracker, key);
    this.tracker = result.state;
    await this._saveTracker();
    await this.setCapabilityValue('grid_reward_today', 0);
    await this._afterChange(result.events);
  }

  async _onStatus(status) {
    if (isRecording(Homey.env)) {
      // One JSON line per update; extract with tools/extract-recording.js
      this.log('[REC]', JSON.stringify({ t: Date.now(), tz: this.homey.clock.getTimezone(), status }));
    }
    if (this.problem) this._clearProblem();

    const {
      gridState, reasonCodes, month, allTime, currency,
    } = parseStatus(status);
    // null when the update has no flexDevices at all: then leave cars/batteries alone.
    const flex = Array.isArray(status.flexDevices) ? status.flexDevices.map(parseFlex).filter((f) => f.id) : null;
    const codes = this._reasonCodes(gridState, reasonCodes, flex || []);
    const reason = { text: reasonText(this.homey, codes), code: codes.join(', ') };

    this.lastReason = reason;
    // Cars/batteries delivering now: the session's reward is theirs (see lib/flexEarnings.js).
    const flexDelivering = (flex || []).filter((f) => f.gridState === 'delivering').map((f) => f.id);
    const result = applyUpdate(this.tracker, {
      month, gridState, dayKey: this._dayKey(), now: Date.now(), reason: reason.code, flexDelivering,
    });
    this.tracker = result.state;
    await this._saveTracker();

    await setIfChanged(this, {
      grid_reward_state: gridState,
      grid_reward_active: gridState === 'delivering',
      grid_reward_reason: reason.text || '-',
      grid_reward_session: result.sessionReward,
      grid_reward_month: month,
      grid_reward_today: result.today,
      grid_reward_all_time: allTime,
    });
    await applyCurrency(this, MONEY_CAPABILITIES, currency);
    await this.availability.update(gridState, this._dayKey());
    await this._updateEstimate();
    await this._setUpdated();

    // Flow triggers
    await this._checkThresholds(result.today, month);
    const homeStateChanged = gridState !== this.lastGridState;
    if (homeStateChanged) {
      this.lastGridState = gridState;
      await this.homey.flow.getDeviceTriggerCard('state_changed')
        .trigger(this, { state: gridState, reason: reason.text, reason_code: reason.code })
        .catch(this.error);
    }
    this._scheduleSettle();
    await this._checkUnavailable(gridState);
    this.conn.lastUpdate = Date.now();
    this._publishConnection();

    await this._updateFlexDevices(flex, { homeStateChanged });
    await this._afterChange(result.events, reason);
  }

  /** After the tracker changed: statistics, flow cards, cars/batteries and widgets. */
  async _afterChange(events, reason) {
    await this._publishStats();
    await this._fireEvents(events, reason);
    await this._publishFlexEarnings();
    notifyWidgets(this.homey);
  }

  async _saveTracker() {
    const json = JSON.stringify(this.tracker);
    if (json === this._savedTracker) return;
    await this.setStoreValue('tracker', this.tracker);
    this._savedTracker = json;
  }

  async _publishStats() {
    const st = statsOf(this.tracker, this._dayKey());
    await setIfChanged(this, {
      grid_reward_last_session: st.lastSessionReward,
      grid_reward_sessions_today: st.sessionsToday,
      grid_reward_minutes_today: st.minutesToday,
      grid_reward_sessions_month: st.sessionsMonth,
    });
  }

  async _fireEvents(events, reason = { text: '', code: '' }) {
    const card = (id) => this.homey.flow.getDeviceTriggerCard(id);
    for (const ev of events) {
      if (ev.type === 'session_started') {
        await card('session_started').trigger(this, { reason: reason.text, reason_code: reason.code }).catch(this.error);
      } else if (ev.type === 'session_ended') {
        this.store.addSession(ev);
        await this._creditFlexDevices(ev);
        await this._fireRecords(this.store.recordSession(ev));
        await card('session_ended').trigger(this, { reward: ev.reward, minutes: ev.minutes }).catch(this.error);
      } else if (ev.type === 'day_ended') {
        this.store.addDay(ev);
        await setIfChanged(this, { grid_reward_yesterday: ev.reward });
        await this._fireRecords(this.store.recordDay(ev));
        await card('daily_summary').trigger(this, {
          reward: ev.reward, sessions: ev.sessions, minutes: ev.minutes, date: ev.date,
        }).catch(this.error);
      } else if (ev.type === 'month_ended') {
        await card('monthly_summary').trigger(this, {
          reward: ev.reward, sessions: ev.sessions, minutes: ev.minutes, month: ev.month,
        }).catch(this.error);
      }
    }
  }

  /**
   * Reason codes to show for the home. When the home is unavailable, add the
   * reasons of its unavailable car/battery (e.g. noVehiclesPluggedIn): that is
   * usually why, and the home itself does not say so.
   */
  _reasonCodes(gridState, homeCodes, flex) {
    if (gridState !== 'unavailable') return homeCodes;
    const extra = flex.filter((f) => f.gridState === 'unavailable').flatMap((f) => f.reasonCodes);
    return [...new Set([...homeCodes, ...extra])];
  }

  // --- Thresholds ---

  async _checkThresholds(today, month) {
    const h = this.high;
    const fire = async (card, from, to, tokens) => {
      if (typeof from !== 'number' || typeof to !== 'number' || to <= from) return;
      await this.homey.flow.getDeviceTriggerCard(card).trigger(this, tokens, { from, to }).catch(this.error);
    };
    if (today !== null) {
      // New day (also when the update itself rolled the day): start from 0.
      if (h.todayKey !== this.tracker.dayKey) {
        if (h.todayKey !== undefined && h.today !== null) h.today = 0;
        h.todayKey = this.tracker.dayKey;
      }
      await fire('reward_today_passed', h.today, today, { today });
      h.today = h.today === null ? today : Math.max(h.today, today);
    }
    if (month !== null) {
      // New month (Tibber's reset, as detected by RewardTracker): start again, no fire.
      if (h.monthKey !== this.tracker.monthKey) {
        if (h.monthKey !== undefined) h.month = month;
        h.monthKey = this.tracker.monthKey;
      }
      await fire('reward_month_passed', h.month, month, { month });
      h.month = h.month === null ? month : Math.max(h.month, month);
    }
  }

  // --- Values: yesterday (#24), estimate (#44), last update (#57) ---

  /**
   * "Reward yesterday" stays the same all day, so Insights shows one step per day
   * with that day's total. At start-up, take it from the saved daily totals.
   */
  async _initYesterday() {
    if (!this.hasCapability('grid_reward_yesterday')) return;
    const yesterday = localDayKey(new Date(Date.now() - 24 * 3600 * 1000), this.homey.clock.getTimezone());
    const day = this.getDays().find((d) => d.date === yesterday);
    await setIfChanged(this, { grid_reward_yesterday: day ? day.reward : null });
  }

  /** While a session runs: Tibber's figure so far, or minutes × the usual rate if more. */
  async _updateEstimate() {
    this.estimateAt = Date.now();
    const t = this.tracker;
    let value = null;
    if (t.session) {
      const minutes = (Date.now() - t.session.startedAt) / 60000;
      const reported = Math.max(0, (t.lastMonth ?? 0) - t.session.startMonth);
      const rate = reasonStats.ratePerMinute(this.getHistory(), t.session.reason);
      value = reasonStats.estimate({ sessionReward: reported, minutes, rate });
    }
    // No session: clear it (setIfChanged skips null).
    if (value === null && this.hasCapability('grid_reward_session_estimate')
      && this.getCapabilityValue('grid_reward_session_estimate') !== null) {
      await this.setCapabilityValue('grid_reward_session_estimate', null).catch(this.error);
    }
    await setIfChanged(this, { grid_reward_session_estimate: value });
  }

  /** Time of the latest update from Tibber, e.g. "10:07", or null before the first one. */
  getUpdatedTime() {
    if (!this.conn || !this.conn.lastUpdate) return null;
    return dateFormat(localeFor(this.homey.i18n.getLanguage()), {
      timeZone: this.homey.clock.getTimezone(), hour: '2-digit', minute: '2-digit',
    }).format(new Date(this.conn.lastUpdate));
  }

  /** The "Updated" value, only when the user turned it on. */
  async _setUpdated() {
    if (!this.hasCapability(UPDATED_CAPABILITY)) return;
    this.conn.lastUpdate = Date.now();
    await setIfChanged(this, { [UPDATED_CAPABILITY]: this.getUpdatedTime() });
  }

  async _applyShowUpdated(show) {
    if (show && !this.hasCapability(UPDATED_CAPABILITY)) {
      await this.addCapability(UPDATED_CAPABILITY).catch(this.error);
    } else if (!show && this.hasCapability(UPDATED_CAPABILITY)) {
      await this.removeCapability(UPDATED_CAPABILITY).catch(this.error);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('show_updated')) await this._applyShowUpdated(newSettings.show_updated === true);
  }

  /** Display unit for money, e.g. for the widget and the history page. */
  getCurrencyUnit() {
    return this.getStoreValue('currencyUnit') || 'kr';
  }

  async _checkUnavailable(gridState) {
    await this.unavailWatch.check(gridState, this.lastReason);
  }

  // --- Saved per home (lib/HomeStore.js), used by the settings page, widgets and export ---

  /** Finished sessions, newest first. */
  getHistory() {
    return this.store.getHistory();
  }

  /** Daily totals { date, reward, sessions, minutes }, newest first. */
  getDays() {
    return this.store.getDays();
  }

  /** { home: rec, [flexId]: rec } */
  getRecords() {
    return this.store.getRecords();
  }

  /** { 'YYYY-MM': { reason: { sessions, reward, minutes } } } */
  getReasonStats() {
    return this.store.getReasonStats();
  }

  async _fireRecords(found) {
    for (const b of found) {
      const tokens = { record: this.homey.__(`records.${b.type}`), value: b.value, previous: b.previous };
      this.log(`New record${b.id ? ` for ${b.id}` : ''}: ${b.type} ${b.previous} -> ${b.value}`);
      const device = b.id ? this._flexDevicesOfHome().find((d) => d.getData().id === b.id) : this;
      if (!device) continue; // a car/battery without a device in Homey
      await this.homey.flow.getDeviceTriggerCard(b.id ? 'flex_record_broken' : 'record_broken')
        .trigger(device, tokens).catch(this.error);
    }
  }

  // --- Connection status in the device settings ---

  _setConnection(state) {
    if (state === 'connected' && this.conn.state !== 'connected') this.conn.since = Date.now();
    if (state !== 'connected') this.conn.since = null;
    this.conn.state = state;
    this._publishConnection({ force: true });
  }

  _formatTime(ms) {
    if (!ms) return '–';
    const lang = localeFor(this.homey.i18n.getLanguage());
    return dateFormat(lang, {
      timeZone: this.homey.clock.getTimezone(), dateStyle: 'short', timeStyle: 'medium',
    }).format(new Date(ms));
  }

  _publishConnection({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - this.conn.shownAt < CONNECTION_SETTINGS_MS) return;
    this.conn.shownAt = now;
    this.setSettings({
      conn_status: this.homey.__(`conn.${this.conn.state}`),
      conn_last_update: this._formatTime(this.conn.lastUpdate),
      conn_connected_since: this._formatTime(this.conn.since),
      conn_reconnects: String(this.conn.reconnects),
    }).catch(this.error);
  }

  // --- Cars and batteries (flex devices) ---

  /** Latest parsed flex devices of this home, used when pairing car/battery devices. */
  getFlexDevices() {
    return this.getStoreValue('flexDevices') || [];
  }

  _flexDevicesOfHome() {
    return flexDevicesOf(this.homey, this.homeId);
  }

  /** Name of a car/battery: as the user named its device, or as Tibber names it. */
  flexName(flexId) {
    const paired = this._flexDevicesOfHome().find((d) => d.getData().id === flexId);
    if (paired && paired.getName) return paired.getName();
    const f = this.getFlexDevices().find((x) => x.id === flexId);
    return f ? (f.name || f.make || f.kind) : flexId;
  }

  /** What a car/battery of this home earned (lib/flexEarnings.js earningsOf), including the running session. */
  getFlexEarnings(flexId) {
    return this.store.flexEarnings(flexId, this._dayKey(), this.tracker);
  }

  async _updateFlexDevices(flex, { homeStateChanged = false } = {}) {
    if (!flex) return;
    if (JSON.stringify(flex) !== JSON.stringify(this.getFlexDevices())) {
      await this.setStoreValue('flexDevices', flex);
    }
    for (const device of this._flexDevicesOfHome()) {
      const f = flex.find((x) => x.id === device.getData().id) || null;
      await device.onFlexStatus(f).catch(this.error);
      // A session started or ended: show the battery's new activity without waiting 5 min.
      if (homeStateChanged && device.pollSoon) device.pollSoon('home status changed');
    }
  }

  /** A session ended: give its reward to the cars/batteries that delivered during it. */
  async _creditFlexDevices(ev) {
    if (!ev.flex || !ev.flex.length) return;
    // The same day as the home's "today": a settlement after midnight counts in the new day.
    this.store.creditFlex(ev, this._dayKey());
    const share = Math.round((ev.reward / ev.flex.length) * 100) / 100;
    for (const device of this._flexDevicesOfHome()) {
      if (!ev.flex.includes(device.getData().id) || !device.onSessionEnded) continue;
      await device.onSessionEnded({
        reward: share,
        minutes: ev.minutes,
        earnedToday: this.getFlexEarnings(device.getData().id).today,
        shared: ev.flex.length > 1,
      }).catch(this.error);
    }
  }

  async _publishFlexEarnings() {
    const unit = this.getCurrencyUnit();
    for (const device of this._flexDevicesOfHome()) {
      if (!device.onEarnings) continue;
      await device.onEarnings(this.getFlexEarnings(device.getData().id), unit).catch(this.error);
    }
  }

  // --- Settlement after a session ---

  // An ended session waits for Tibber's settlement. If no update arrives,
  // close it after SETTLE_MS so the session_ended card still fires.
  _scheduleSettle() {
    const p = this.tracker.pending;
    if (!p || this.settleTimer) return;
    const delay = Math.max(0, p.endedAt + SETTLE_MS - Date.now()) + 1000;
    this.settleTimer = this.homey.setTimeout(() => {
      this.settleTimer = null;
      this._enqueue(() => this._settle());
    }, delay);
  }

  async _settle() {
    const result = settle(this.tracker, Date.now());
    if (!result.events.length) {
      this._scheduleSettle();
      return;
    }
    this.tracker = result.state;
    await this._saveTracker();
    await this._afterChange(result.events);
  }

  async onUninit() {
    if (this.availability) await this.availability.save();
    this._stopSubscription();
    if (this.dayTimer) this.homey.clearInterval(this.dayTimer);
    if (this.settleTimer) this.homey.clearTimeout(this.settleTimer);
  }

  async onDeleted() {
    await this.onUninit();
  }

}

module.exports = GridRewardDevice;
