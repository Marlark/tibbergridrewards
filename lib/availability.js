'use strict';

/**
 * "Available today" (#30, #68): the part of the day (in %) a home, car or battery
 * was available for Grid Rewards or delivering. That is the potential, not only
 * what was paid out.
 *
 * Time is summed between observations: every status update and a minute tick.
 * A gap longer than MAX_GAP_MS (Homey off, app restarted) is not counted, so the
 * percentage is of the time actually observed today.
 */

const MAX_GAP_MS = 5 * 60 * 1000;
const COUNTED = ['available', 'delivering', 'unavailable'];
const UP = ['available', 'delivering'];
const SAVE_EVERY_MS = 15 * 60 * 1000;

/** Account the time since the last observation, then remember gridState. Pure. */
function step(prev, { gridState, now, dayKey }) {
  const p = prev || {};
  const s = p.dayKey === dayKey ? { ...p } : { dayKey, observedMs: 0, availableMs: 0 };
  const gap = typeof p.at === 'number' ? now - p.at : 0;
  if (gap > 0 && gap <= MAX_GAP_MS && COUNTED.includes(p.state)) {
    s.observedMs += gap;
    if (UP.includes(p.state)) s.availableMs += gap;
  }
  s.at = now;
  s.state = gridState;
  return s;
}

/** Percentage, or null until at least a minute has been observed today. */
function percent(s) {
  if (!s || !(s.observedMs >= 60 * 1000)) return null;
  return Math.round((s.availableMs / s.observedMs) * 100);
}

/**
 * For a device: keeps the figures in its store (saved at most every 15 min and at
 * a new day, to keep writes down) and sets the grid_reward_availability capability.
 */
class AvailabilityWatch {
  constructor(device) {
    this.device = device;
    this.state = device.getStoreValue('availability') || null;
    this.savedAt = 0;
  }

  async update(gridState, dayKey) {
    const before = this.state && this.state.dayKey;
    this.state = step(this.state, { gridState, now: Date.now(), dayKey });
    if (before !== dayKey || Date.now() - this.savedAt >= SAVE_EVERY_MS) await this.save();
    const value = percent(this.state);
    if (this.device.hasCapability('grid_reward_availability')
      && this.device.getCapabilityValue('grid_reward_availability') !== value) {
      await this.device.setCapabilityValue('grid_reward_availability', value).catch(this.device.error);
    }
    return value;
  }

  async save() {
    this.savedAt = Date.now();
    await this.device.setStoreValue('availability', this.state).catch(this.device.error);
  }
}

module.exports = {
  step, percent, AvailabilityWatch, MAX_GAP_MS,
};
