'use strict';

/**
 * Checks for the car. Pure functions.
 *
 * #74 Plug-in reminder: once a day at a chosen time, if the car is not plugged in
 *     (it only earns Grid Rewards when it is).
 * #72 Check against the charger: the user's flow reports what the charger (Easee,
 *     Zaptec, the car's own app …) says. When the charger says plugged in but
 *     Tibber has seen no car for MISMATCH_GRACE_MS, Tibber's link to the car has
 *     probably dropped, and the car earns nothing until it is fixed.
 */

const REMINDER_WINDOW_MIN = 30;
const MISMATCH_GRACE_MS = 10 * 60 * 1000;

/** '20:00' -> 1200, or null. */
function minutesOf(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v < 24 * 60 ? v : null;
}

/**
 * Should the reminder go out now? Only within REMINDER_WINDOW_MIN after the time
 * (so a restart late in the evening does not remind hours too late), once a day,
 * and only when Tibber says the car is not plugged in.
 */
function reminderDue({
  enabled, time, dayKey, minuteOfDay, lastDay, pluggedIn,
}) {
  const at = minutesOf(time);
  if (!enabled || at === null || pluggedIn !== false || lastDay === dayKey) return false;
  return minuteOfDay >= at && minuteOfDay < at + REMINDER_WINDOW_MIN;
}

/**
 * Charger and Tibber disagree? state: { since } from the previous call.
 * Returns { state, started, ended }: started once when the disagreement has
 * lasted MISMATCH_GRACE_MS, ended once when it is over.
 */
function mismatchStep(prev, { chargerPlugged, tibberPlugged, now }) {
  const p = prev || {};
  const disagree = chargerPlugged === true && tibberPlugged === false;
  if (!disagree) {
    return { state: {}, started: false, ended: Boolean(p.active) };
  }
  const since = typeof p.since === 'number' ? p.since : now;
  const active = now - since >= MISMATCH_GRACE_MS;
  return { state: { since, active }, started: active && !p.active, ended: false };
}

module.exports = {
  minutesOf, reminderDue, mismatchStep, MISMATCH_GRACE_MS, REMINDER_WINDOW_MIN,
};
