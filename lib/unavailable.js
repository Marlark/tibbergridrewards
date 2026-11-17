'use strict';

/**
 * "Unavailable for longer than X hours".
 *
 * watch = { since: ms | null, lastMin: number }  (since is persisted in the device store)
 *
 * step() is called on every status update and once a minute. While the status is
 * 'unavailable' it returns { fromMin, toMin } for the minutes that passed since the
 * previous step. A flow with a threshold of T minutes runs when fromMin < T <= toMin,
 * i.e. exactly once per unavailable period, whatever T the user chose.
 */
function step(watch, gridState, now) {
  const w = { since: null, lastMin: 0, ...(watch || {}) };
  if (gridState !== 'unavailable') {
    return { watch: { since: null, lastMin: 0 }, fire: null };
  }
  if (w.since === null) {
    return { watch: { since: now, lastMin: 0 }, fire: null };
  }
  const toMin = Math.floor((now - w.since) / 60000);
  if (toMin <= w.lastMin) return { watch: w, fire: null };
  return { watch: { since: w.since, lastMin: toMin }, fire: { fromMin: w.lastMin, toMin } };
}

/**
 * Restore after a restart: don't fire for thresholds that were passed while the
 * app was not running.
 */
function restore(since, now) {
  if (typeof since !== 'number') return { since: null, lastMin: 0 };
  return { since, lastMin: Math.floor((now - since) / 60000) };
}

/** Run listener check for a flow with args.hours. */
function crossed(fire, hours) {
  const threshold = Math.max(1, Math.round(Number(hours) * 60));
  return !!fire && fire.fromMin < threshold && threshold <= fire.toMin;
}

module.exports = { step, restore, crossed };
