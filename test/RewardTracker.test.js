'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applyUpdate, rollDay, localDayKey } = require('../lib/RewardTracker');

const T0 = Date.parse('2026-11-16T10:00:00Z');

test('first value: today = 0, dayStart = month', () => {
  const r = applyUpdate({}, { month: 40, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  assert.strictEqual(r.today, 0);
  assert.strictEqual(r.state.dayStart, 40);
});

test('today increases with month', () => {
  let r = applyUpdate({}, { month: 40, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  r = applyUpdate(r.state, { month: 42.5, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  assert.strictEqual(r.today, 2.5);
});

test('session: start, live amount and end with reward and duration', () => {
  let r = applyUpdate({}, { month: 40, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  r = applyUpdate(r.state, { month: 40, gridState: 'delivering', dayKey: '2026-11-16', now: T0 });
  assert.deepStrictEqual(r.events, [{ type: 'session_started' }]);
  r = applyUpdate(r.state, { month: 41.2, gridState: 'delivering', dayKey: '2026-11-16', now: T0 + 5 * 60000 });
  assert.strictEqual(r.sessionReward, 1.2);
  r = applyUpdate(r.state, { month: 41.5, gridState: 'available', dayKey: '2026-11-16', now: T0 + 15 * 60000 });
  assert.deepStrictEqual(r.events, [{ type: 'session_ended', reward: 1.5, minutes: 15 }]);
  assert.strictEqual(r.sessionReward, 0);
});

test('day rollover (even if Homey was offline at midnight)', () => {
  let r = applyUpdate({}, { month: 40, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  r = applyUpdate(r.state, { month: 43, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  // Next update arrives the next day
  r = applyUpdate(r.state, { month: 44, gridState: 'available', dayKey: '2026-11-17', now: T0 });
  assert.strictEqual(r.today, 1);
});

test('month rollover resets the day base', () => {
  let r = applyUpdate({}, { month: 120, gridState: 'available', dayKey: '2026-11-30', now: T0 });
  r = applyUpdate(r.state, { month: 0.4, gridState: 'available', dayKey: '2026-12-01', now: T0 });
  assert.strictEqual(r.today, 0.4);
});

test('rollDay via timer sets dayStart = lastMonth', () => {
  const s = rollDay({ dayKey: '2026-11-16', dayStart: 10, lastMonth: 13 }, '2026-11-17');
  assert.strictEqual(s.dayStart, 13);
});

test('localDayKey uses the time zone', () => {
  // 23:30 UTC on 16 Nov is 00:30 on 17 Nov in Stockholm
  assert.strictEqual(localDayKey(new Date('2026-11-16T23:30:00Z'), 'Europe/Stockholm'), '2026-11-17');
});

test('downward correction within the month is not treated as a month reset', () => {
  let r = applyUpdate({}, { month: 40, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  r = applyUpdate(r.state, { month: 41.5, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  r = applyUpdate(r.state, { month: 41.3, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  assert.strictEqual(r.today, 1.3);
});

test('correction below the day base clamps today to 0, never negative', () => {
  let r = applyUpdate({}, { month: 40, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  r = applyUpdate(r.state, { month: 39, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  assert.strictEqual(r.today, 0);
  r = applyUpdate(r.state, { month: 39.5, gridState: 'available', dayKey: '2026-11-16', now: T0 });
  assert.strictEqual(r.today, 0.5);
});

test('correction during a session keeps the session reward non-negative', () => {
  let r = applyUpdate({}, { month: 40, gridState: 'delivering', dayKey: '2026-11-16', now: T0 });
  r = applyUpdate(r.state, { month: 39.8, gridState: 'delivering', dayKey: '2026-11-16', now: T0 });
  assert.strictEqual(r.sessionReward, 0);
});

test('late month reset (Tibber resets after midnight) is still detected', () => {
  let r = applyUpdate({}, { month: 120, gridState: 'available', dayKey: '2026-11-30', now: T0 });
  // 1 Dec: still last month's figure (late settlement)
  r = applyUpdate(r.state, { month: 121, gridState: 'available', dayKey: '2026-12-01', now: T0 });
  // Then the reset arrives
  r = applyUpdate(r.state, { month: 0.4, gridState: 'available', dayKey: '2026-12-01', now: T0 });
  assert.strictEqual(r.today, 0.4);
  assert.strictEqual(r.state.monthKey, '2026-12');
});

test('session spanning a month reset continues from 0', () => {
  let r = applyUpdate({}, { month: 120, gridState: 'delivering', dayKey: '2026-11-30', now: T0 });
  r = applyUpdate(r.state, { month: 0.7, gridState: 'delivering', dayKey: '2026-12-01', now: T0 });
  assert.strictEqual(r.sessionReward, 0.7);
});

test('old stored state without monthKey: a drop is treated as a reset', () => {
  const old = { dayKey: '2026-12-01', dayStart: 120, lastMonth: 120, session: null };
  const r = applyUpdate(old, { month: 0.4, gridState: 'available', dayKey: '2026-12-01', now: T0 });
  assert.strictEqual(r.today, 0.4);
  assert.strictEqual(r.state.monthKey, '2026-12');
});
