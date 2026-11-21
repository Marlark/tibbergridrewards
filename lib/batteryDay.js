'use strict';

/**
 * The battery's day (#29, #48), from data the battery poll already fetches:
 * - batteryActivityHistory: what the battery did and why, as intervals
 * - batteryTimeline energyFlow, kind ACTUAL: what it charged/discharged per quarter
 *
 * Hours are the time the battery was charging or discharging, per reason:
 * Grid Rewards, price, solar or other. Energy is per quarter, counted for the
 * reason that was active at that time. Pure functions.
 *
 * NOTE: Tibber's charged/discharged per quarter is read as average power in W
 * (as for the planned charge), so energy = W × 0.25 h. This is not yet verified
 * against a real battery response; ENERGY_PER_QUARTER is the one place to change.
 */

const { dateFormat } = require('./i18n');
const QUARTER_MS = 15 * 60 * 1000;
const ENERGY_PER_QUARTER = (watts) => (watts * 0.25) / 1000; // W -> kWh in a quarter

const REASONS = ['gridRewards', 'price', 'solar', 'other'];

/** 'ChargingForGridRewards' -> 'gridRewards'; unknown codes -> 'other'. */
function reasonOf(code) {
  const c = String(code || '');
  if (/GridRewards/.test(c)) return 'gridRewards';
  if (/Price/.test(c)) return 'price';
  if (/Solar/.test(c)) return 'solar';
  return 'other';
}

/** 'charging' | 'discharging' | 'idle', from the start of the code. */
function directionOf(code) {
  const c = String(code || '');
  if (/^Charging/.test(c)) return 'charging';
  if (/^Discharging/.test(c)) return 'discharging';
  return 'idle';
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Stats for one local day [dayStart, dayEnd).
 * intervals: [{ from, to (null = still running), code }] (ISO strings), flow: ACTUAL
 * items [{ time, charged, discharged }]. now: open intervals end here.
 */
function dayStats({
  intervals = [], flow = [], dayStart, dayEnd, now,
}) {
  const hours = Object.fromEntries(REASONS.map((r) => [r, 0]));
  const spans = [];
  for (const i of intervals) {
    const from = Math.max(Date.parse(i.from), dayStart);
    const to = Math.min(i.to ? Date.parse(i.to) : now, dayEnd, now);
    if (!(to > from)) continue;
    spans.push({ from, to, code: i.code });
    if (directionOf(i.code) !== 'idle') hours[reasonOf(i.code)] += (to - from) / 3600000;
  }

  const kwh = {
    charged: 0, discharged: 0, gridRewardsCharged: 0, gridRewardsDischarged: 0,
  };
  for (const q of flow) {
    const t = Date.parse(q.time);
    if (!(t >= dayStart && t < dayEnd)) continue;
    const charged = ENERGY_PER_QUARTER(q.charged || 0);
    const discharged = ENERGY_PER_QUARTER(q.discharged || 0);
    kwh.charged += charged;
    kwh.discharged += discharged;
    // The reason active in the middle of the quarter.
    const mid = t + QUARTER_MS / 2;
    const span = spans.find((s) => s.from <= mid && mid < s.to);
    if (span && reasonOf(span.code) === 'gridRewards') {
      kwh.gridRewardsCharged += charged;
      kwh.gridRewardsDischarged += discharged;
    }
  }

  return {
    hours: Object.fromEntries(REASONS.map((r) => [r, round1(hours[r])])),
    kwh: Object.fromEntries(Object.entries(kwh).map(([k, v]) => [k, round2(v)])),
  };
}

/** The time zone's offset from UTC (ms) at time t. */
function offsetAt(t, timeZone) {
  const p = Object.fromEntries(dateFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(t / 1000) * 1000;
}

/**
 * Local midnight (ms) of the day `now` is in, in the given time zone. On the
 * days summer time starts or ends, midnight has another offset than `now`.
 */
function startOfLocalDay(now, timeZone) {
  const offNow = offsetAt(now, timeZone);
  const wall = now + offNow;
  const wallMidnight = wall - (((wall % 86400000) + 86400000) % 86400000);
  const guess = wallMidnight - offNow;
  return wallMidnight - offsetAt(guess, timeZone);
}

module.exports = {
  reasonOf, directionOf, dayStats, startOfLocalDay, REASONS, ENERGY_PER_QUARTER,
};
