'use strict';

// Reasons per month (#17), reward yesterday (#24), session estimate (#44),
// settlement per session (#56) and the time of the last update (#57).

require('./helpers/setup');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeHomey } = require('./helpers/homey-stub');
const {
  mainReason, addSession, seed, monthRows, ratePerMinute, estimate, MONTHS_MAX,
} = require('../lib/reasonStats');
const GridRewardSubscription = require('../lib/GridRewardSubscription');

const subs = [];
GridRewardSubscription.prototype.start = function start() { this._stopped = false; subs.push(this); };

const GridRewardDevice = require('../drivers/grid-reward/device');
const history = require('../lib/history');
const { getStatus } = require('../widgets/grid-rewards/api');

// --- Pure functions ---

test('reasons: the main reason counts, per month, with shares', () => {
  assert.strictEqual(mainReason('shortage, other'), 'shortage');
  assert.strictEqual(mainReason(''), 'unknown');
  let s = addSession({}, {
    reason: 'excess', reward: 3, minutes: 30, monthKey: '2026-11',
  });
  s = addSession(s, {
    reason: 'excess', reward: 1, minutes: 15, monthKey: '2026-11',
  });
  s = addSession(s, {
    reason: 'shortage, other', reward: 4, minutes: 45, monthKey: '2026-11',
  });
  assert.deepStrictEqual(monthRows(s['2026-11']), [
    {
      reason: 'excess', sessions: 2, reward: 4, minutes: 45, sessionShare: 67, rewardShare: 50,
    },
    {
      reason: 'shortage', sessions: 1, reward: 4, minutes: 45, sessionShare: 33, rewardShare: 50,
    },
  ]);
});

test('reasons: only the newest 13 months are kept; seeding from the history', () => {
  let s = {};
  for (let m = 0; m < 15; m += 1) {
    const monthKey = new Date(Date.UTC(2025, m, 15)).toISOString().slice(0, 7); // 2025-01 … 2026-03
    s = addSession(s, {
      reason: 'excess', reward: 1, minutes: 1, monthKey,
    });
  }
  assert.strictEqual(Object.keys(s).length, MONTHS_MAX);
  assert.ok(!('2025-01' in s) && '2026-03' in s);
  const seeded = seed([{
    reason: 'excess', reward: 2, minutes: 10, endedAt: 5,
  }], () => '2026-11');
  assert.deepStrictEqual(seeded, { '2026-11': { excess: { sessions: 1, reward: 2, minutes: 10 } } });
});

test('estimate: the usual rate for the reason, never below what Tibber reported', () => {
  const hist = [
    { reason: 'excess', reward: 1, minutes: 10 },
    { reason: 'excess', reward: 2, minutes: 20 },
    { reason: 'excess', reward: 3, minutes: 30 },
    { reason: 'shortage', reward: 10, minutes: 10 },
  ];
  assert.strictEqual(ratePerMinute(hist, 'excess'), 0.1);
  // Too few shortage sessions: the rate of all sessions.
  assert.strictEqual(ratePerMinute(hist, 'shortage'), 16 / 70);
  assert.strictEqual(ratePerMinute(hist.slice(0, 2), 'excess'), null);
  assert.strictEqual(estimate({ sessionReward: 0.5, minutes: 12, rate: 0.1 }), 1.2);
  assert.strictEqual(estimate({ sessionReward: 2, minutes: 12, rate: 0.1 }), 2);
  assert.strictEqual(estimate({ sessionReward: 0.5, minutes: 12, rate: null }), 0.5);
});

// --- A real day through the home device ---

test('real day: settlements, reasons, yesterday, estimate and last update', async (t) => {
  const recs = fs.readFileSync(path.join(__dirname, 'fixtures', 'real-2026-11-17.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  let now = recs[0].t;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['Date'], now });
  subs.length = 0;
  const homey = makeHomey();
  const home = new GridRewardDevice({ homey, data: { id: 'home-1' }, store: { email: 'a@example.com', password: 'pw' } });
  home.getName = () => 'Home';
  homey.drivers.registry['grid-reward'] = { getDevices: () => [home] };
  await home.onInit();
  const estimates = [];
  for (const r of recs) {
    now = r.t;
    t.mock.timers.setTime(now);
    subs[0].emit('data', r.status, 'home-1');
    await home._queue;
    const e = home.getCapabilityValue('grid_reward_session_estimate');
    if (e !== null) estimates.push(e);
  }

  // #56: Tibber settled the last quarter of most sessions, 0.02–0.19 kr about 40 s after the end.
  const sessions = home.getHistory();
  const settled = sessions.filter((s) => s.settled);
  assert.ok(settled.length >= 5, `${settled.length} of ${sessions.length} sessions settled`);
  for (const s of settled) {
    assert.ok(s.settled > 0 && s.settled < 0.5, String(s.settled));
    assert.ok(s.settledAfter > 0 && s.settledAfter < 180, String(s.settledAfter));
  }

  // #17: every session counted once, by its reason.
  const months = home.getReasonStats();
  const counted = Object.values(months).flatMap((m) => Object.values(m)).reduce((a, r) => a + r.sessions, 0);
  assert.strictEqual(counted, sessions.length);

  // #24: the recording crosses midnight, so yesterday has a value: the day's total.
  const days = home.getDays();
  assert.strictEqual(home.getCapabilityValue('grid_reward_yesterday'), days[0].reward);

  // #44: an estimate was shown during the sessions, and none outside them.
  assert.ok(estimates.length > 0);
  assert.strictEqual(home.getCapabilityValue('grid_reward_session_estimate'), null);

  // #57: the time of the last update, in Homey's time zone (18:01 UTC = 19:01 in Stockholm).
  // The widget always has it; as a value on the device only when turned on (writes).
  assert.strictEqual(home.getUpdatedTime(), '19:01');
  const w = await getStatus({ homey, query: {} });
  assert.strictEqual(w.updated, '19:01');
  assert.strictEqual(w.labels.updated, 'Updated');
  assert.strictEqual(home.hasCapability('grid_reward_updated'), false, 'off by default');
  await home.onSettings({ newSettings: { show_updated: true }, changedKeys: ['show_updated'] });
  assert.strictEqual(home.hasCapability('grid_reward_updated'), true);
  subs[0].emit('data', recs[recs.length - 1].status, 'home-1');
  await home._queue;
  assert.strictEqual(home.getCapabilityValue('grid_reward_updated'), '19:01');
  await home.onSettings({ newSettings: { show_updated: false }, changedKeys: ['show_updated'] });
  assert.strictEqual(home.hasCapability('grid_reward_updated'), false);

  // The history page: the reasons table and the settlement per session.
  const page = history.getHistory({ homey });
  assert.ok(page.homes[0].reasons.length >= 1);
  assert.ok(page.homes[0].reasons[0].rows.every((r) => r.text && r.text !== r.reason));
  assert.ok(page.homes[0].sessions.some((s) => s.settled));
  await home.onUninit();
});

test('yesterday is taken from the saved daily totals at start-up', async (t) => {
  const now = Date.parse('2026-11-21T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['Date'], now });
  subs.length = 0;
  const homey = makeHomey();
  homey.settings.values['days:h1'] = [{
    date: '2026-11-20', reward: 12.5, sessions: 4, minutes: 80,
  }];
  const home = new GridRewardDevice({ homey, data: { id: 'h1' }, store: { email: 'a@example.com', password: 'pw' } });
  await home.onInit();
  assert.strictEqual(home.getCapabilityValue('grid_reward_yesterday'), 12.5);
  await home.onUninit();
});
