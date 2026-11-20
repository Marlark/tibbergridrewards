'use strict';

/**
 * Records (#31 for the home, #73 for each car/battery): best day, best session
 * and longest session. Kept per home in the app settings:
 *   { home: rec, [flexId]: rec }, rec = { bestDay, bestSession, longestSession },
 *   each { value, at } (at: date YYYY-MM-DD or a timestamp).
 *
 * A record is only "broken" when there was one before: the first values (and the
 * ones seeded from the history at start-up) are set without a flow trigger.
 * Pure functions.
 */

const TYPES = ['bestDay', 'bestSession', 'longestSession'];

function improve(rec, type, value, at, broken) {
  if (typeof value !== 'number' || !(value > 0)) return rec;
  const old = rec[type];
  if (old && value <= old.value) return rec;
  if (old) broken.push({ type, value, previous: old.value });
  return { ...rec, [type]: { value, at } };
}

/** A finished session: { reward, minutes, endedAt }. Returns { rec, broken[] }. */
function onSession(rec, { reward, minutes, endedAt }) {
  const broken = [];
  let r = rec || {};
  r = improve(r, 'bestSession', Math.round(reward * 100) / 100, endedAt, broken);
  r = improve(r, 'longestSession', minutes, endedAt, broken);
  return { rec: r, broken };
}

/** A finished day: { reward, date }. Returns { rec, broken[] }. */
function onDay(rec, { reward, date }) {
  const broken = [];
  const r = improve(rec || {}, 'bestDay', Math.round(reward * 100) / 100, date, broken);
  return { rec: r, broken };
}

/**
 * Records from the saved history, for a first start with this feature.
 * sessions: home history; days: daily totals; flexId: only that device's
 * sessions (its share), or the home's when omitted.
 */
function seed({ sessions = [], days = [], flexId = null }) {
  let rec = {};
  for (const s of sessions) {
    const ids = s.flex || [];
    if (flexId && !ids.includes(flexId)) continue;
    const reward = flexId ? s.reward / ids.length : s.reward;
    rec = onSession(rec, { reward, minutes: s.minutes, endedAt: s.endedAt }).rec;
  }
  if (!flexId) for (const d of days) rec = onDay(rec, d).rec;
  return rec;
}

module.exports = {
  TYPES, onSession, onDay, seed,
};
