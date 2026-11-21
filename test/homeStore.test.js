'use strict';

// lib/HomeStore.js: what the app keeps per home in its settings, without a device.

const test = require('node:test');
const assert = require('node:assert');
const HomeStore = require('../lib/HomeStore');

function settings(values = {}) {
  return {
    values,
    get(k) { return k in this.values ? this.values[k] : null; },
    set(k, v) { this.values[k] = v; },
  };
}

const store = (values) => new HomeStore({ settings: settings(values), homeId: 'h1', monthOf: () => '2026-11' });

test('uses the same keys as before, so existing data is kept', () => {
  const s = store({ 'history:h1': [{ reward: 1, minutes: 10, endedAt: 1 }], 'days:h1': [{ date: '2026-11-20', reward: 1 }] });
  s.init();
  assert.strictEqual(s.getHistory().length, 1);
  assert.strictEqual(s.getDays()[0].date, '2026-11-20');
  assert.ok(s.settings.values['records:h1'].home.bestSession, 'records seeded from the history');
  assert.ok(s.settings.values['reasons:h1']['2026-11'], 'reasons seeded from the history');
});

test('history from an older version is moved in once', () => {
  const s = store();
  s.init({ oldHistory: [{ reward: 2, minutes: 5, endedAt: 1 }] });
  assert.strictEqual(s.getHistory()[0].reward, 2);
  s.init({ oldHistory: [{ reward: 9, minutes: 5, endedAt: 1 }] });
  assert.strictEqual(s.getHistory()[0].reward, 2, 'never overwrites');
});

test('a session goes to the history (at most 100) and the reasons; days at most 400', () => {
  const s = store();
  s.init();
  for (let i = 0; i < 105; i += 1) {
    s.addSession({
      startedAt: i, endedAt: i + 1, reward: 1, minutes: 15, reason: 'excess',
    });
  }
  assert.strictEqual(s.getHistory().length, HomeStore.HISTORY_MAX);
  assert.strictEqual(s.getReasonStats()['2026-11'].excess.sessions, 105);
  for (let i = 0; i < 405; i += 1) {
    s.addDay({
      date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), reward: 1, sessions: 1, minutes: 1,
    });
  }
  assert.strictEqual(s.getDays().length, HomeStore.DAYS_MAX);
});

test('cars/batteries: credited, then shown with the running session', () => {
  const s = store();
  s.init();
  s.creditFlex({ reward: 2, minutes: 30, flex: ['car'] }, '2026-11-21');
  const tracker = { lastMonth: 13, session: { startMonth: 12, flex: ['car'] } };
  assert.strictEqual(s.flexEarnings('car', '2026-11-21', tracker).today, 3);
  assert.deepStrictEqual(s.recordSession({
    reward: 2, minutes: 30, endedAt: 5, flex: ['car'],
  }), [], 'first records are set quietly');
});
