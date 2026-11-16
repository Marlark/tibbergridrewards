'use strict';

const Homey = require('homey');
const { TibberAppClient, TibberAuthError } = require('../../lib/TibberAppClient');
const GridRewardSubscription = require('../../lib/GridRewardSubscription');
const {
  parseStatus, applyUpdate, rollDay, localDayKey,
} = require('../../lib/RewardTracker');

class GridRewardDevice extends Homey.Device {

  async onInit() {
    this.homeId = this.getData().id;
    this.tracker = this.getStoreValue('tracker') || {};
    this.lastGridState = this.getCapabilityValue('grid_reward_state') || 'unknown';
    // All work that touches tracker/capabilities/flows runs one job at a time,
    // so quick successive updates can't interleave (e.g. double state_changed).
    this._queue = Promise.resolve();

    this._startSubscription();

    // Roll the day over at midnight even if Tibber sends nothing.
    this.dayTimer = this.homey.setInterval(() => this._enqueue(() => this._tickDay()), 60 * 1000);
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
    sub.on('connected', () => this.setAvailable().catch(this.error));
    sub.on('error', (err) => {
      this.error('Subscription:', err.message);
      if (err instanceof TibberAuthError) {
        this.setUnavailable(this.homey.__('error.auth')).catch(this.error);
      }
    });
    this.sub = sub;
    sub.start();
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
    const key = this._dayKey();
    if (this.tracker.dayKey === key) return;
    this.tracker = rollDay(this.tracker, key);
    await this.setStoreValue('tracker', this.tracker);
    await this.setCapabilityValue('grid_reward_today', 0);
  }

  async _onStatus(status) {
    if (this.getSetting('record_raw')) {
      // One JSON line per update; extract with tools/extract-recording.js
      this.log('[REC]', JSON.stringify({ t: Date.now(), tz: this.homey.clock.getTimezone(), status }));
    }
    const {
      gridState, reason, month, allTime,
    } = parseStatus(status);

    const result = applyUpdate(this.tracker, {
      month, gridState, dayKey: this._dayKey(), now: Date.now(),
    });
    this.tracker = result.state;
    await this.setStoreValue('tracker', this.tracker);

    const sets = [
      this.setCapabilityValue('grid_reward_state', gridState),
      this.setCapabilityValue('grid_reward_active', gridState === 'delivering'),
      this.setCapabilityValue('grid_reward_reason', reason || '-'),
      this.setCapabilityValue('grid_reward_session', result.sessionReward),
    ];
    if (month !== null) sets.push(this.setCapabilityValue('grid_reward_month', month));
    if (result.today !== null) sets.push(this.setCapabilityValue('grid_reward_today', result.today));
    if (allTime !== null) sets.push(this.setCapabilityValue('grid_reward_all_time', allTime));
    await Promise.all(sets);

    // Flow triggers
    if (gridState !== this.lastGridState) {
      this.lastGridState = gridState;
      await this.homey.flow.getDeviceTriggerCard('state_changed')
        .trigger(this, { state: gridState, reason: reason || '' })
        .catch(this.error);
    }
    for (const ev of result.events) {
      if (ev.type === 'session_started') {
        await this.homey.flow.getDeviceTriggerCard('session_started')
          .trigger(this, { reason: reason || '' }).catch(this.error);
      } else if (ev.type === 'session_ended') {
        await this.homey.flow.getDeviceTriggerCard('session_ended')
          .trigger(this, { reward: ev.reward, minutes: ev.minutes }).catch(this.error);
      }
    }
  }

  async onUninit() {
    if (this.sub) this.sub.stop();
    if (this.dayTimer) this.homey.clearInterval(this.dayTimer);
  }

  async onDeleted() {
    await this.onUninit();
  }

}

module.exports = GridRewardDevice;
