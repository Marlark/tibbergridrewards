'use strict';

/**
 * What each car/battery has earned. Tibber only reports the reward for the whole
 * home, but each flex device has its own state. Real data shows one device at a
 * time delivering during a session, so a session's reward goes to the device(s)
 * that were delivering during it (split evenly if several were).
 *
 * Kept per home in the app settings, so it survives removing and adding the
 * car/battery device:
 *   { [flexId]: { dayKey, today, todaySessions, todayMinutes,
 *                 monthKey, month, monthSessions, monthMinutes, total } }
 * Pure functions.
 */

const round2 = (n) => Math.round(n * 100) / 100;

/** Add one session's share to a device, in the given day. */
function addEarning(store, flexId, amount, dayKey, minutes = 0) {
  const all = { ...(store || {}) };
  const e = all[flexId] || {};
  const monthKey = dayKey.slice(0, 7);
  const sameDay = e.dayKey === dayKey;
  const sameMonth = e.monthKey === monthKey;
  all[flexId] = {
    dayKey,
    today: round2((sameDay ? e.today || 0 : 0) + amount),
    todaySessions: (sameDay ? e.todaySessions || 0 : 0) + 1,
    todayMinutes: (sameDay ? e.todayMinutes || 0 : 0) + minutes,
    monthKey,
    month: round2((sameMonth ? e.month || 0 : 0) + amount),
    monthSessions: (sameMonth ? e.monthSessions || 0 : 0) + 1,
    monthMinutes: (sameMonth ? e.monthMinutes || 0 : 0) + minutes,
    total: round2((e.total || 0) + amount),
  };
  return all;
}

/**
 * Split a session's reward over the devices that delivered during it. Each of
 * them delivered for the whole session, so each gets its minutes.
 */
function splitSession(store, { reward, minutes = 0, flex }, dayKey) {
  const ids = flex || [];
  if (!ids.length || !(reward > 0)) return store || {};
  const share = reward / ids.length;
  return ids.reduce((s, id) => addEarning(s, id, share, dayKey, minutes), store || {});
}

/**
 * Not yet settled amounts per device: the running session, and an ended one that
 * waits for Tibber's settlement. tracker: RewardTracker state.
 */
function liveShares(tracker) {
  const live = {};
  const t = tracker || {};
  const month = typeof t.lastMonth === 'number' ? t.lastMonth : null;
  if (month === null) return live;
  const add = (part, upTo) => {
    if (!part || !part.flex || !part.flex.length) return;
    const share = Math.max(0, upTo - part.startMonth) / part.flex.length;
    for (const id of part.flex) live[id] = (live[id] || 0) + share;
  };
  add(t.session, month);
  // An ended session runs until the next one started (that one has its own share).
  add(t.pending, t.session ? t.session.startMonth : month);
  return live;
}

/** This month's amount for a device, including what is not yet settled. */
function monthOf(store, flexId, dayKey, live = 0) {
  const e = (store || {})[flexId] || {};
  return (e.monthKey === dayKey.slice(0, 7) ? e.month || 0 : 0) + live;
}

/**
 * Values to show for a device on dayKey, including what is not yet settled.
 * share: the device's part (%) of what the home's cars/batteries earned this month,
 * or null when nothing was earned yet. (Measured against what was credited to
 * devices, not Tibber's month total, which also has sessions from before the
 * update and sessions no device delivered in.)
 */
function earningsOf(store, flexId, dayKey, liveById = {}) {
  const e = (store || {})[flexId] || {};
  const live = liveById[flexId] || 0;
  const sameDay = e.dayKey === dayKey;
  const sameMonth = e.monthKey === dayKey.slice(0, 7);
  const ids = new Set([...Object.keys(store || {}), ...Object.keys(liveById)]);
  const all = [...ids].reduce((sum, id) => sum + monthOf(store, id, dayKey, liveById[id] || 0), 0);
  const mine = monthOf(store, flexId, dayKey, live);
  return {
    today: round2((sameDay ? e.today || 0 : 0) + live),
    month: round2(mine),
    total: round2((e.total || 0) + live),
    sessionsToday: sameDay ? e.todaySessions || 0 : 0,
    minutesToday: sameDay ? e.todayMinutes || 0 : 0,
    sessionsMonth: sameMonth ? e.monthSessions || 0 : 0,
    minutesMonth: sameMonth ? e.monthMinutes || 0 : 0,
    share: all > 0 ? Math.round((mine / all) * 100) : null,
  };
}

module.exports = {
  addEarning, splitSession, liveShares, earningsOf,
};
