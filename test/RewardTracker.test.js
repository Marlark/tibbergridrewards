'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applyUpdate, rollDay, localDayKey } = require('../lib/RewardTracker');

// Session events also carry startedAt/endedAt/reason (for the history); most tests
// only check type, reward and minutes.
const brief = (events) => events.map(({ startedAt, endedAt, reason, ...rest }) => rest);

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
  assert.deepStrictEqual(brief(r.events), [{ type: 'session_started' }]);
  r = applyUpdate(r.state, { month: 41.2, gridState: 'delivering', dayKey: '2026-11-16', now: T0 + 5 * 60000 });
  assert.strictEqual(r.sessionReward, 1.2);
  r = applyUpdate(r.state, { month: 41.5, gridState: 'available', dayKey: '2026-11-16', now: T0 + 15 * 60000 });
  // Ended, but waiting for Tibber's settlement of the last quarter
  assert.deepStrictEqual(brief(r.events), []);
  assert.strictEqual(r.sessionReward, 0);
  r = applyUpdate(r.state, { month: 41.6, gridState: 'available', dayKey: '2026-11-16', now: T0 + 15 * 60000 + 40000 });
  assert.deepStrictEqual(brief(r.events), [{ type: 'session_ended', reward: 1.6, minutes: 15 }]);
  assert.deepStrictEqual(r.state.lastSession, {
    reward: 1.6, minutes: 15, startedAt: T0, endedAt: T0 + 15 * 60000, reason: '',
  });
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

// --- Settlement after a session ends (real data: +0.02–0.19 kr about 40 s later) ---

const { settle, SETTLE_MS } = require('../lib/RewardTracker');

const D = '2026-11-16';
const up = (state, month, gridState, now) => applyUpdate(state, {
  month, gridState, dayKey: D, now,
});

function endedSession() {
  let r = up({}, 10, 'available', T0);
  r = up(r.state, 10, 'delivering', T0);
  r = up(r.state, 12, 'delivering', T0 + 10 * 60000);
  return up(r.state, 12, 'available', T0 + 15 * 60000);
}

test('settle(): without a settlement, session_ended fires after SETTLE_MS', () => {
  const r = endedSession();
  const endedAt = T0 + 15 * 60000;
  assert.deepStrictEqual(brief(settle(r.state, endedAt + SETTLE_MS - 1).events), []);
  const s = settle(r.state, endedAt + SETTLE_MS);
  assert.deepStrictEqual(brief(s.events), [{ type: 'session_ended', reward: 2, minutes: 15 }]);
  assert.strictEqual(s.state.pending, null);
});

test('a late update without month change also closes after SETTLE_MS', () => {
  const r = endedSession();
  const late = up(r.state, 12, 'available', T0 + 15 * 60000 + SETTLE_MS + 1000);
  assert.deepStrictEqual(brief(late.events), [{ type: 'session_ended', reward: 2, minutes: 15 }]);
});

test('a new session started before the settlement does not count it twice', () => {
  let r = endedSession();
  r = up(r.state, 12, 'delivering', T0 + 15 * 60000 + 8000); // new session, settlement not here yet
  assert.deepStrictEqual(brief(r.events), [{ type: 'session_started' }]);
  r = up(r.state, 12.2, 'delivering', T0 + 15 * 60000 + 40000); // settlement of the first
  assert.deepStrictEqual(brief(r.events), [{ type: 'session_ended', reward: 2.2, minutes: 15 }]);
  assert.strictEqual(r.sessionReward, 0);
  r = up(r.state, 12.5, 'delivering', T0 + 25 * 60000);
  assert.strictEqual(r.sessionReward, 0.3);
});

test('two sessions ending without any settlement in between both fire', () => {
  let r = endedSession();
  r = up(r.state, 12, 'delivering', T0 + 16 * 60000);
  r = up(r.state, 12, 'available', T0 + 17 * 60000);
  assert.deepStrictEqual(brief(r.events), [{ type: 'session_ended', reward: 2, minutes: 15 }]);
  assert.ok(r.state.pending);
});

test('month reset while waiting closes the session with what it had', () => {
  let r = applyUpdate({}, { month: 120, gridState: 'delivering', dayKey: '2026-11-30', now: T0 });
  r = applyUpdate(r.state, { month: 121, gridState: 'available', dayKey: '2026-11-30', now: T0 + 60000 });
  r = applyUpdate(r.state, { month: 0.1, gridState: 'available', dayKey: '2026-12-01', now: T0 + 90000 });
  assert.deepStrictEqual(brief(r.events.filter((e) => e.type === 'session_ended')), [{ type: 'session_ended', reward: 1, minutes: 1 }]);
  assert.strictEqual(r.today, 0.1);
});

// --- Daily summary ---

const { rollDayEvents, parseStatus, parseFlex } = require('../lib/RewardTracker');

test('day_ended summarises reward, sessions and minutes of the day', () => {
  let r = up({}, 10, 'available', T0);
  r = up(r.state, 10, 'delivering', T0 + 60000);
  r = up(r.state, 11, 'available', T0 + 31 * 60000);
  r = up(r.state, 11.5, 'available', T0 + 32 * 60000); // settlement
  const next = applyUpdate(r.state, { month: 11.5, gridState: 'available', dayKey: '2026-11-17', now: T0 + 14 * 3600000 });
  assert.deepStrictEqual(brief(next.events), [{
    type: 'day_ended', date: '2026-11-16', reward: 1.5, sessions: 1, minutes: 30,
  }]);
  assert.deepStrictEqual(next.state.dayStats, { sessions: 0, minutes: 0 });
});

test('midnight timer emits the summary too, but only once', () => {
  const s = { dayKey: '2026-11-16', dayStart: 10, lastMonth: 13, dayStats: { sessions: 2, minutes: 45 } };
  const a = rollDayEvents(s, '2026-11-17');
  assert.deepStrictEqual(brief(a.events), [{ type: 'day_ended', date: '2026-11-16', reward: 3, sessions: 2, minutes: 45 }]);
  assert.deepStrictEqual(brief(rollDayEvents(a.state, '2026-11-17').events), []);
});

test('no summary for a day without data (first start)', () => {
  assert.deepStrictEqual(brief(rollDayEvents({}, '2026-11-17').events), []);
});

// --- Reason codes and flex devices ---

test('parseStatus returns reason codes', () => {
  assert.deepStrictEqual(parseStatus({ state: { __typename: 'GridRewardDelivering', reason: 'excess' } }).reasonCodes, ['excess']);
  assert.deepStrictEqual(parseStatus({ state: { __typename: 'GridRewardUnavailable', reasons: ['a', 'b'] } }).reasonCodes, ['a', 'b']);
  assert.deepStrictEqual(parseStatus({}).reasonCodes, []);
});

test('parseFlex handles car and battery (shapes from real data)', () => {
  assert.deepStrictEqual(parseFlex({
    __typename: 'GridRewardVehicle', kind: 'vehicle', vehicleId: 'v1', shortName: 'Car', make: 'EV3', isPluggedIn: false, isSmartChargingEnabled: true, state: { __typename: 'GridRewardUnavailable', reasons: ['noVehiclesPluggedIn'] },
  }), {
    id: 'v1', kind: 'vehicle', name: 'Car', make: 'EV3', gridState: 'unavailable', reasonCodes: ['noVehiclesPluggedIn'], pluggedIn: false, smartEnabled: true,
  });
  assert.deepStrictEqual(parseFlex({
    __typename: 'GridRewardBattery', kind: 'battery', batteryId: 'b1', shortName: 'Battery', make: 'Huawei', isSmartModeEnabled: true, state: { __typename: 'GridRewardAvailable', kind: 'available' },
  }), {
    id: 'b1', kind: 'battery', name: 'Battery', make: 'Huawei', gridState: 'available', reasonCodes: ['available'], pluggedIn: null, smartEnabled: true,
  });
});

// --- Statistics ---

const { statsOf } = require('../lib/RewardTracker');

test('statsOf: last session, sessions and minutes today and this month', () => {
  let r = up({}, 10, 'available', T0);
  r = up(r.state, 10, 'delivering', T0 + 60000);
  r = up(r.state, 11, 'available', T0 + 21 * 60000);
  r = up(r.state, 11.2, 'available', T0 + 22 * 60000); // settlement
  assert.deepStrictEqual(statsOf(r.state, D), {
    lastSessionReward: 1.2, lastSessionMinutes: 20, sessionsToday: 1, minutesToday: 20, sessionsMonth: 1, minutesMonth: 20,
  });
  // Next day: today is 0, month keeps counting, last session stays
  assert.deepStrictEqual(statsOf(r.state, '2026-11-17'), {
    lastSessionReward: 1.2, lastSessionMinutes: 20, sessionsToday: 0, minutesToday: 0, sessionsMonth: 1, minutesMonth: 20,
  });
  // Next month: month is 0
  assert.strictEqual(statsOf(r.state, '2026-12-01').sessionsMonth, 0);
});

test('real recording: 9 sessions this month after replay', () => {
  const fs = require('fs');
  const path = require('path');
  const { replay, parseJsonl } = require('../tools/replay');
  const recs = parseJsonl(fs.readFileSync(path.join(__dirname, 'fixtures', 'real-2026-11-17.jsonl'), 'utf8'));
  const { state } = replay(recs);
  const st = statsOf(state, '2026-11-17');
  assert.strictEqual(st.sessionsMonth, 9);
  assert.strictEqual(st.lastSessionReward, 2.53);
});
