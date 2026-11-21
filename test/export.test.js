'use strict';

// CSV export of the history (#10)

const test = require('node:test');
const assert = require('node:assert');
const { makeHomey } = require('./helpers/homey-stub');
const { exportCsv, field, localTime } = require('../lib/csv');
const appApi = require('../api');

const NOW = Date.parse('2026-11-20T12:00:00Z');

function home(name, {
  sessions = [], days = [], unit = 'kr', flexName,
} = {}) {
  return {
    flexName,
    getName: () => name,
    getHistory: () => sessions,
    getDays: () => days,
    getCurrencyUnit: () => unit,
  };
}

function setup(homes, language = 'en') {
  const homey = makeHomey();
  homey.i18n.getLanguage = () => language;
  homey.drivers.registry['grid-reward'] = { getDevices: () => homes };
  return homey;
}

const lines = (csv) => csv.replace(/^﻿/, '').trimEnd().split('\r\n');

test('sessions: all homes, oldest first, local times, translated reasons', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const homey = setup([
    home('Villa', {
      sessions: [{
        startedAt: Date.parse('2026-11-19T07:00:00Z'), endedAt: Date.parse('2026-11-19T07:30:00Z'), reward: 1.5, minutes: 30, reason: 'excess', flex: ['v1'], settled: 0.12, settledAfter: 40,
      }],
      flexName: (id) => (id === 'v1' ? 'Car' : id),
    }),
    home('Cabin', {
      sessions: [{
        startedAt: Date.parse('2026-11-18T22:45:00Z'), endedAt: Date.parse('2026-11-18T23:15:00Z'), reward: 0.456, minutes: 30, reason: 'shortage, other',
      }],
    }),
  ]);
  const r = exportCsv({ homey, kind: 'sessions' });
  assert.strictEqual(r.filename, 'grid-rewards-sessions-2026-11-20.csv');
  assert.strictEqual(r.rows, 2);
  assert.ok(r.csv.startsWith('﻿'), 'BOM so Excel reads UTF-8');
  const [head, first, second] = lines(r.csv);
  assert.strictEqual(head, 'Home,Device,Started,Ended,Minutes,Reward,Settlement,Currency,Reason');
  assert.match(first, /^Cabin,,2026-11-18 23:45,2026-11-19 00:15,30,0\.46,,kr,"/); // Stockholm, crosses midnight
  assert.strictEqual(second, 'Villa,Car,2026-11-19 08:00,2026-11-19 08:30,30,1.50,0.12,kr,Excess power in the grid');
});

test('daily totals: Swedish uses ";" and a decimal comma', (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const homey = setup([home('Villa', {
    days: [
      { date: '2026-11-19', reward: 12.3, sessions: 4, minutes: 75 },
      { date: '2026-11-18', reward: 9, sessions: 3, minutes: 45 },
    ],
  })], 'sv');
  const r = exportCsv({ homey, kind: 'days' });
  assert.deepStrictEqual(lines(r.csv), [
    'Home;Date;Sessions;Minutes;Reward;Currency',
    'Villa;2026-11-18;3;45;9,00;kr',
    'Villa;2026-11-19;4;75;12,30;kr',
  ]);
});

test('nothing to export gives only the header', () => {
  const r = exportCsv({ homey: setup([]), kind: 'days' });
  assert.strictEqual(r.rows, 0);
  assert.strictEqual(lines(r.csv).length, 1);
});

test('unknown export kind is refused', () => {
  assert.throws(() => exportCsv({ homey: setup([]), kind: 'passwords' }), /Unknown export/);
});

test('fields with separators, quotes or line breaks are quoted', () => {
  assert.strictEqual(field('Villa, Ö', ','), '"Villa, Ö"');
  assert.strictEqual(field('Villa, Ö', ';'), 'Villa, Ö');
  assert.strictEqual(field('a "b"', ';'), '"a ""b"""');
  assert.strictEqual(field('a\nb', ';'), '"a\nb"');
  assert.strictEqual(field(null, ';'), '');
  assert.strictEqual(localTime(null, 'Europe/Stockholm'), '');
});

test('app API: getExport', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const homey = setup([home('Villa', { days: [{ date: '2026-11-19', reward: 1, sessions: 1, minutes: 15 }] })]);
  const r = await appApi.getExport({ homey, query: { kind: 'days' } });
  assert.strictEqual(r.rows, 1);
});
