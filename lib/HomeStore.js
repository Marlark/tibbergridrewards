'use strict';

/**
 * Everything the app keeps per Tibber home in its settings: session history,
 * daily totals, records, sessions per reason, and what each car/battery earned.
 *
 * Kept in the app's settings under the Tibber home id, not in the device store,
 * so it survives removing and adding the home device again. It is only lost if
 * the app itself is uninstalled. The keys ("history:<homeId>", …) are the same as
 * before this class existed.
 *
 * No flow cards or capabilities here: methods return what happened (e.g. broken
 * records) and the device acts on it.
 */

const records = require('./records');
const reasonStats = require('./reasonStats');
const { splitSession, liveShares, earningsOf } = require('./flexEarnings');

const HISTORY_MAX = 100;
const DAYS_MAX = 400; // daily totals: a bit more than a year

class HomeStore {
  /**
   * settings: homey.settings. monthOf(ms) -> 'YYYY-MM' in Homey's time zone.
   */
  constructor({ settings, homeId, monthOf }) {
    this.settings = settings;
    this.homeId = homeId;
    this.monthOf = monthOf;
  }

  _key(kind) {
    return `${kind}:${this.homeId}`;
  }

  _get(kind, empty) {
    return this.settings.get(this._key(kind)) || empty;
  }

  _set(kind, value) {
    this.settings.set(this._key(kind), value);
  }

  /** At start-up: move old data and fill what an update added, from the history. */
  init({ oldHistory = null } = {}) {
    if (Array.isArray(oldHistory) && oldHistory.length && !this.settings.get(this._key('history'))) {
      this._set('history', oldHistory);
    }
    this._seedRecords();
    this._seedReasons();
  }

  // --- Sessions and days ---

  /** Finished sessions, newest first. */
  getHistory() {
    return this._get('history', []);
  }

  addSession(ev) {
    const entry = {
      startedAt: ev.startedAt,
      endedAt: ev.endedAt,
      reward: ev.reward,
      minutes: ev.minutes,
      reason: ev.reason,
      ...(ev.flex ? { flex: ev.flex } : {}),
      ...(ev.settled ? { settled: ev.settled, settledAfter: ev.settledAfter } : {}),
    };
    this._set('history', [entry, ...this.getHistory()].slice(0, HISTORY_MAX));
    this._set('reasons', reasonStats.addSession(this.getReasonStats(), {
      reason: ev.reason, reward: ev.reward, minutes: ev.minutes, monthKey: this.monthOf(ev.endedAt || Date.now()),
    }));
  }

  /** Daily totals { date, reward, sessions, minutes }, newest first. */
  getDays() {
    return this._get('days', []);
  }

  addDay(ev) {
    const day = {
      date: ev.date, reward: ev.reward, sessions: ev.sessions, minutes: ev.minutes,
    };
    const rest = this.getDays().filter((d) => d.date !== day.date);
    this._set('days', [day, ...rest].slice(0, DAYS_MAX));
  }

  // --- Sessions per reason (#17) ---

  /** { 'YYYY-MM': { reason: { sessions, reward, minutes } } } */
  getReasonStats() {
    return this._get('reasons', {});
  }

  _seedReasons() {
    if (this.settings.get(this._key('reasons'))) return;
    this._set('reasons', reasonStats.seed(this.getHistory(), this.monthOf));
  }

  // --- Records (#31, #73) ---

  /** { home: rec, [flexId]: rec } */
  getRecords() {
    return this._get('records', {});
  }

  /** First start with records: take them from the saved history, without triggers. */
  _seedRecords() {
    if (this.settings.get(this._key('records'))) return;
    const sessions = this.getHistory();
    const all = { home: records.seed({ sessions, days: this.getDays() }) };
    for (const id of new Set(sessions.flatMap((s) => s.flex || []))) {
      all[id] = records.seed({ sessions, flexId: id });
    }
    this._set('records', all);
  }

  /** A finished session. Returns the broken records [{ type, value, previous, id }] (id null = home). */
  recordSession(ev) {
    const all = { ...this.getRecords() };
    const found = [];
    const home = records.onSession(all.home, ev);
    all.home = home.rec;
    found.push(...home.broken.map((b) => ({ ...b, id: null })));
    for (const id of ev.flex || []) {
      const r = records.onSession(all[id], { ...ev, reward: ev.reward / ev.flex.length });
      all[id] = r.rec;
      found.push(...r.broken.map((b) => ({ ...b, id })));
    }
    this._set('records', all);
    return found;
  }

  /** A finished day, for the home and each car/battery that earned that day. */
  recordDay(ev) {
    const all = { ...this.getRecords() };
    const found = [];
    const home = records.onDay(all.home, ev);
    all.home = home.rec;
    found.push(...home.broken.map((b) => ({ ...b, id: null })));
    for (const [id, e] of Object.entries(this._get('flexearn', {}))) {
      if (e.dayKey !== ev.date) continue;
      const r = records.onDay(all[id], { reward: e.today, date: ev.date });
      all[id] = r.rec;
      found.push(...r.broken.map((b) => ({ ...b, id })));
    }
    this._set('records', all);
    return found;
  }

  // --- What each car/battery earned ---

  /** Give a finished session's reward to the cars/batteries that delivered (dayKey: the home's today). */
  creditFlex(ev, dayKey) {
    if (!ev.flex || !ev.flex.length) return;
    this._set('flexearn', splitSession(this._get('flexearn', {}), ev, dayKey));
  }

  /** What a car/battery earned (flexEarnings.earningsOf), with the running session from the tracker. */
  flexEarnings(flexId, dayKey, tracker) {
    return earningsOf(this._get('flexearn', {}), flexId, dayKey, liveShares(tracker));
  }
}

module.exports = HomeStore;
module.exports.HISTORY_MAX = HISTORY_MAX;
module.exports.DAYS_MAX = DAYS_MAX;
