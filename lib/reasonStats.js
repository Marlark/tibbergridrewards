'use strict';

/**
 * Sessions per reason (#17) and the estimated reward of a running session (#44).
 * Pure functions.
 *
 * Reason stats are kept per home in the app settings, per calendar month:
 *   { 'YYYY-MM': { excess: { sessions, reward, minutes }, shortage: …, other: … } }
 * A session counts for its main (first) reason, in the month it ended.
 */

const MONTHS_MAX = 13;
const MIN_SESSIONS_FOR_RATE = 3;

const round2 = (n) => Math.round(n * 100) / 100;

/** 'shortage, other' -> 'shortage'; '' -> 'unknown' */
function mainReason(reason) {
  return String(reason || '').split(',')[0].trim() || 'unknown';
}

function addSession(store, {
  reason, reward, minutes, monthKey,
}) {
  const all = { ...(store || {}) };
  const month = { ...(all[monthKey] || {}) };
  const key = mainReason(reason);
  const r = month[key] || { sessions: 0, reward: 0, minutes: 0 };
  month[key] = {
    sessions: r.sessions + 1,
    reward: round2(r.reward + (reward || 0)),
    minutes: r.minutes + (minutes || 0),
  };
  all[monthKey] = month;
  // Keep the newest MONTHS_MAX months.
  const keep = Object.keys(all).sort().slice(-MONTHS_MAX);
  return Object.fromEntries(keep.map((k) => [k, all[k]]));
}

/** From the saved history (sessions with endedAt), for a first start. monthOf(ms) -> 'YYYY-MM'. */
function seed(sessions, monthOf) {
  return (sessions || []).reduce((store, s) => addSession(store, {
    reason: s.reason, reward: s.reward, minutes: s.minutes, monthKey: monthOf(s.endedAt),
  }), {});
}

/**
 * One month as rows with shares (%), biggest reward first:
 * [{ reason, sessions, reward, minutes, sessionShare, rewardShare }]
 */
function monthRows(month) {
  const rows = Object.entries(month || {}).map(([reason, r]) => ({ reason, ...r }));
  const sessions = rows.reduce((a, r) => a + r.sessions, 0);
  const reward = rows.reduce((a, r) => a + r.reward, 0);
  return rows
    .map((r) => ({
      ...r,
      sessionShare: sessions ? Math.round((r.sessions / sessions) * 100) : 0,
      rewardShare: reward ? Math.round((r.reward / reward) * 100) : 0,
    }))
    .sort((a, b) => b.reward - a.reward);
}

/**
 * Reward per minute from earlier sessions: with the same main reason when there
 * are enough of them, otherwise from all. null when there are too few.
 */
function ratePerMinute(history, reason) {
  const usable = (history || []).filter((s) => s.minutes > 0 && typeof s.reward === 'number');
  const same = usable.filter((s) => mainReason(s.reason) === mainReason(reason));
  const base = same.length >= MIN_SESSIONS_FOR_RATE ? same : usable;
  if (base.length < MIN_SESSIONS_FOR_RATE) return null;
  const minutes = base.reduce((a, s) => a + s.minutes, 0);
  return base.reduce((a, s) => a + s.reward, 0) / minutes;
}

/**
 * Estimated reward of a running session: what Tibber has reported so far, or
 * minutes × the usual rate if that is more (Tibber reports with a delay).
 */
function estimate({
  sessionReward, minutes, rate,
}) {
  if (rate === null || rate === undefined) return round2(sessionReward || 0);
  return round2(Math.max(sessionReward || 0, minutes * rate));
}

module.exports = {
  mainReason, addSession, seed, monthRows, ratePerMinute, estimate, MONTHS_MAX,
};
