'use strict';

const Homey = require('homey');
const { TibberAppClient, TibberAuthError, TibberApiChangedError } = require('../../lib/TibberAppClient');
const GridRewardSubscription = require('../../lib/GridRewardSubscription');
const {
  parseStatus, parseFlex, applyUpdate, settle, rollDayEvents, statsOf, localDayKey, SETTLE_MS,
} = require('../../lib/RewardTracker');
const { reasonText } = require('../../lib/reasons');
const { setIfChanged, applyCurrency, UnavailableWatch } = require('../../lib/deviceUtils');

// Capabilities shown in money; their unit follows Tibber's rewardCurrency.
const MONEY_CAPABILITIES = [
  'grid_reward_session',
  'grid_reward_today',
  'grid_reward_month',
  'grid_reward_all_time',
  'grid_reward_last_session',
];

const HISTORY_MAX = 100;
const CONNECTION_SETTINGS_MS = 60 * 1000; // refresh "last update" in settings at most once a minute

const STATS_CAPABILITIES = [
  'grid_reward_last_session',
  'grid_reward_sessions_today',
  'grid_reward_minutes_today',
  'grid_reward_sessions_month',
];

class GridRewardDevice extends Homey.Device {

  async onInit() {
    this.homeId = this.getData().id;
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

    // Devices paired with an older version lack the newer capabilities.
    for (const cap of STATS_CAPABILITIES) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

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

  _startSubscription() {
    const { email, password } = this.getStore();
    this.client = new TibberAppClient({ email, password, log: this.log.bind(this) });
    const sub = new GridRewardSubscription({
      client: this.client, homeId: this.homeId, homey: this.homey, log: this.log.bind(this),
    });
    sub.on('data', (status) => this._enqueue(() => this._onStatus(status)));
    sub.on('connected', () => {
      // A successful login fixes an auth problem. An API problem is only
      // fixed when real data arrives again (see _onStatus).
      if (this.problem === 'auth') this._clearProblem();
      this._setConnection('connected');
    });
    sub.on('disconnected', () => {
      this.conn.reconnects += 1;
      this._setConnection('reconnecting');
    });
    sub.on('error', (err) => {
      this.error('Subscription:', err.message);
      if (err instanceof TibberAuthError) {
        this._setProblem('auth');
        this._setConnection('auth');
      } else if (err instanceof TibberApiChangedError) {
        this._setProblem('api');
        this._setConnection('api');
      }
    });
    this.sub = sub;
    sub.start();
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
    if (this.sub) this.sub.stop();
    this._startSubscription();
  }

  _dayKey() {
    return localDayKey(new Date(), this.homey.clock.getTimezone());
  }

  async _tickDay() {
    await this._checkUnavailable(this.lastGridState);
    const key = this._dayKey();
    if (this.tracker.dayKey === key) return;
    const result = rollDayEvents(this.tracker, key);
    this.tracker = result.state;
    await this._saveTracker();
    await this.setCapabilityValue('grid_reward_today', 0);
    await this._publishStats();
    await this._fireEvents(result.events);
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

  async _onStatus(status) {
    if (this.getSetting('record_raw')) {
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
    const result = applyUpdate(this.tracker, {
      month, gridState, dayKey: this._dayKey(), now: Date.now(), reason: reason.code,
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
    await this._publishStats();
    await applyCurrency(this, MONEY_CAPABILITIES, currency);

    // Flow triggers
    await this._checkThresholds(result.today, month);
    if (gridState !== this.lastGridState) {
      this.lastGridState = gridState;
      await this.homey.flow.getDeviceTriggerCard('state_changed')
        .trigger(this, { state: gridState, reason: reason.text, reason_code: reason.code })
        .catch(this.error);
    }
    await this._fireEvents(result.events, reason);
    this._scheduleSettle();
    await this._checkUnavailable(gridState);
    this.conn.lastUpdate = Date.now();
    this._publishConnection();

    await this._updateFlexDevices(flex);
  }

  async _fireEvents(events, reason = { text: '', code: '' }) {
    for (const ev of events) {
      if (ev.type === 'session_started') {
        await this.homey.flow.getDeviceTriggerCard('session_started')
          .trigger(this, { reason: reason.text, reason_code: reason.code }).catch(this.error);
      } else if (ev.type === 'session_ended') {
        await this._addToHistory(ev);
        await this.homey.flow.getDeviceTriggerCard('session_ended')
          .trigger(this, { reward: ev.reward, minutes: ev.minutes }).catch(this.error);
      } else if (ev.type === 'day_ended') {
        await this.homey.flow.getDeviceTriggerCard('daily_summary')
          .trigger(this, {
            reward: ev.reward, sessions: ev.sessions, minutes: ev.minutes, date: ev.date,
          }).catch(this.error);
      } else if (ev.type === 'month_ended') {
        await this.homey.flow.getDeviceTriggerCard('monthly_summary')
          .trigger(this, {
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

  // --- Currency ---

  /** Display unit for money, e.g. for the widget and the history page. */
  getCurrencyUnit() {
    return this.getStoreValue('currencyUnit') || 'kr';
  }

  // --- Unavailable for a long time ---

  async _checkUnavailable(gridState) {
    await this.unavailWatch.check(gridState, this.lastReason);
  }

  // --- Session history ---

  /** Finished sessions, newest first. */
  getHistory() {
    return this.getStoreValue('history') || [];
  }

  async _addToHistory(ev) {
    const entry = {
      startedAt: ev.startedAt, endedAt: ev.endedAt, reward: ev.reward, minutes: ev.minutes, reason: ev.reason,
    };
    await this.setStoreValue('history', [entry, ...this.getHistory()].slice(0, HISTORY_MAX));
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
    const lang = this.homey.i18n.getLanguage() === 'sv' ? 'sv-SE' : 'en-GB';
    return new Intl.DateTimeFormat(lang, {
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

  async _updateFlexDevices(flex) {
    if (!flex) return;
    if (JSON.stringify(flex) !== JSON.stringify(this.getFlexDevices())) {
      await this.setStoreValue('flexDevices', flex);
    }
    let devices = [];
    try {
      devices = this.homey.drivers.getDriver('flex-device').getDevices();
    } catch (err) {
      return; // driver not ready yet
    }
    for (const device of devices) {
      if (device.getData().homeId !== this.homeId) continue;
      const f = flex.find((x) => x.id === device.getData().id) || null;
      await device.onFlexStatus(f).catch(this.error);
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
    await this._publishStats();
    await this._fireEvents(result.events);
  }

  async onUninit() {
    if (this.sub) this.sub.stop();
    if (this.dayTimer) this.homey.clearInterval(this.dayTimer);
    if (this.settleTimer) this.homey.clearTimeout(this.settleTimer);
  }

  async onDeleted() {
    await this.onUninit();
  }

}

module.exports = GridRewardDevice;
